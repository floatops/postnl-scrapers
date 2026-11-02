// Eén browsersessie bij PostNL voor één depot, in één tabblad (floatops/matransport#562).
//
// - Elke nieuwe login krijgt een nieuw IP uit de proxy-pool (kiesProxy) en een rij in postnl_sessies.
// - Video: per context (recordVideo). Een segment eindigt bij een contextwissel (zelfde cookies,
//   geen nieuwe login, alleen als `cfg.contextWissel` aan staat: gemeten in stap 0) of bij het sluiten.
// - Trace: na het inloggen één keer gestart, daarna een chunk per taak. Wachtwoorden komen zo
//   nooit in de trace.
// - Alle Mendix-antwoorden van de huidige taak worden bewaard (`antwoorden`) voor de lezers.
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { kiesProxy, sluitProxyAf } from '../../credentials-shared/src/proxyPool.js'
import { naarDepot } from '../../credentials-shared/src/postnl/login.js'
import { volgMendix } from '../../postnl-planner/src/mendix.js'
import { bewaarVideo, latestPad, foutPad, ruimOudeFoutVideosOp, depotSlug, nlTijdstempel, BUCKET } from '../../credentials-shared/src/sessieVideo.js'

export const WORKER = 'postnl-sessie'
const VIDEO = { width: 1280, height: 720 }

export class Sessie {
  constructor({ depot, klantId, supabase, chromium, opslag, cfg, log = console, headless = true }) {
    Object.assign(this, { depot, klantId, supabase, chromium, opslag, cfg, log, headless })
    this.browser = null
    this.context = null
    this.page = null
    this.proxy = null
    this.id = null
    this.ingelogdOm = null
    this.segmentOm = null
    this.antwoorden = []
    this.lezingen = 0
    this.herlogins = 0
    this.incidentInSegment = false
    this.depotHost = new URL(depot.url).hostname
  }

  get open() { return Boolean(this.page && !this.page.isClosed()) }
  get leeftijdMin() { return this.ingelogdOm ? (Date.now() - this.ingelogdOm) / 60_000 : 0 }

  async openen() {
    this.proxy = await kiesProxy(this.supabase, { worker: WORKER, depot: this.depot })
    const opties = { headless: this.headless, args: ['--disable-dev-shm-usage'] }
    if (process.env.CHROMIUM_EXECUTABLE_PATH) opties.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
    if (this.proxy) opties.proxy = this.proxy.proxy
    try {
      this.browser = await this.chromium.launch(opties)
      await this.#nieuweContext()
      await naarDepot(this.page, this.depot, { log: this.log })
      await this.#traceAan()
      this.ingelogdOm = Date.now()
      this.segmentOm = Date.now()
      this.id = await this.opslag.sessieStart({ depot: this.depot.naam, proxyGebruikId: this.proxy?.gebruikId, externIp: this.proxy?.label?.match(/\(([^)]+)\)/)?.[1] ?? null })
      this.log.log(`[${this.depot.naam}] Ingelogd (${this.proxy?.label ?? 'geen proxy'})`)
    } catch (err) {
      err.page = this.page
      await this.sluiten('login_mislukt', { fout: err }).catch(() => {})
      throw err
    }
  }

  async #nieuweContext(storageState = null) {
    this.videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'postnl-sessie-'))
    this.context = await this.browser.newContext({
      serviceWorkers: 'block', timezoneId: 'Europe/Amsterdam', viewport: { width: 1440, height: 900 },
      recordVideo: { dir: this.videoDir, size: VIDEO },
      ...(storageState ? { storageState } : {}),
    })
    this.page = await this.context.newPage()
    this.mendix = volgMendix(this.page)
    this.page.on('response', (res) => {
      if (!res.url().includes('/xas/')) return
      res.json().then(j => this.antwoorden.push(j)).catch(() => {})
    })
  }

  // tracing.start() begint zelf al een chunk; die meteen weggooien, zodat elke taak een eigen
  // chunk krijgt (startChunk/stopChunk) en het inloggen er nooit in staat.
  async #traceAan() {
    try {
      await this.context.tracing.start({ screenshots: true, snapshots: true })
      await this.context.tracing.stopChunk()
    } catch (e) {
      this.log.warn(`[${this.depot.naam}] Trace starten mislukt (gaat door zonder): ${e.message}`)
    }
  }

  // Vóór elke taak: lege lijst Mendix-antwoorden en een nieuwe trace-chunk.
  async taakBegin(naam) {
    this.antwoorden = []
    await this.context?.tracing.startChunk({ title: naam }).catch(() => {})
  }

  // Na elke taak: trace-chunk opslaan. Met een incident naar fout/ (30 dagen), anders alleen
  // de laatste per taak. Geeft het opslagpad of null.
  async taakEinde(naam, { incident = false } = {}) {
    if (!this.context) return null
    if (incident) this.incidentInSegment = true
    const lokaal = path.join(this.videoDir ?? os.tmpdir(), `trace-${naam}-${Date.now()}.zip`)
    try {
      await this.context.tracing.stopChunk({ path: lokaal })
      const map = `${this.klantId}/${WORKER}/trace`
      const pad = incident
        ? `${map}/fout/${depotSlug(this.depot.naam)}-${naam}-${nlTijdstempel()}.zip`
        : `${map}/${depotSlug(this.depot.naam)}-${naam}-latest.zip`
      const { error } = await this.supabase.storage.from(BUCKET).upload(pad, await fs.readFile(lokaal), { contentType: 'application/zip', upsert: true })
      if (error) throw error
      return pad
    } catch (err) {
      this.log.warn(`[${this.depot.naam}] Trace opslaan mislukt (gaat door): ${err.message}`)
      return null
    } finally {
      await fs.rm(lokaal, { force: true }).catch(() => {})
    }
  }

  // Nieuw videosegment zonder nieuwe login: zelfde browser en IP, cookies meegenomen.
  // Geeft false als de sessie daarna niet meer ingelogd is (dan is dat zelf een meting).
  async nieuwSegment() {
    const state = await this.context.storageState()
    const oud = { context: this.context, page: this.page, dir: this.videoDir }
    await oud.context.tracing.stop().catch(() => {})
    await this.#nieuweContext(state)
    await oud.context.close().catch(() => {})
    await this.#bewaarVideo(oud.page, oud.dir, this.incidentInSegment)
    this.incidentInSegment = false
    this.segmentOm = Date.now()
    try {
      const { ingelogd } = await naarDepot(this.page, this.depot, { log: this.log })
      await this.#traceAan()
      if (ingelogd) { this.herlogins++; return false }
      return true
    } catch (err) {
      return false
    }
  }

  async #bewaarVideo(page, dir, incident) {
    const video = page?.video()
    if (!video) return null
    const pad = incident ? foutPad(this.klantId, WORKER, this.depot.naam) : latestPad(this.klantId, WORKER, this.depot.naam)
    const opgeslagen = await bewaarVideo(this.supabase, video, pad, `[${this.depot.naam}] `).catch(() => null)
    if (incident && opgeslagen) await ruimOudeFoutVideosOp(this.supabase, this.klantId, WORKER).catch(() => {})
    await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    return opgeslagen
  }

  // Sluiten met een reden (verlopen, gegooid, blokkade, nacht, leeg, herstart, …). Idempotent.
  async sluiten(reden, { fout = null, uitkomst = null } = {}) {
    const page = this.page
    const dir = this.videoDir
    const incident = this.incidentInSegment || !['nacht', 'leeg', 'herstart', 'voor_planner', 'vernieuwd', 'vernieuwd_voor_schrijven'].includes(reden)
    this.page = null
    if (this.context) {
      await this.context.tracing.stop().catch(() => {})
      await this.context.close().catch(() => {})
    }
    await this.browser?.close().catch(() => {})
    this.context = null
    this.browser = null
    const video = await this.#bewaarVideo(page, dir, incident)
    if (this.proxy) {
      await sluitProxyAf(this.supabase, this.proxy, uitkomst ?? (reden === 'blokkade' ? 'blokkade' : fout ? 'fout' : 'ok'),
        `${reden}${fout ? `: ${String(fout.message).split('\n')[0]}` : ''} (${this.lezingen} lezingen)`)
      this.proxy = null
    }
    await this.opslag.sessieBij(this.id, {
      einde_at: new Date().toISOString(), einde_reden: reden, lezingen: this.lezingen, herlogins: this.herlogins,
      ...(video ? { video_path: video } : {}),
    })
    this.id = null
    this.ingelogdOm = null
    this.incidentInSegment = false
    return video
  }
}
