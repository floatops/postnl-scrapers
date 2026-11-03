// Eén browsersessie bij PostNL voor één depot (floatops/matransport#562): één browser, één login,
// één tabblad voor OOM PD en, als RVA aanstaat (matransport#569), een tweede tabblad voor RVA.
//
// - Elke nieuwe login krijgt een nieuw IP uit de proxy-pool (kiesProxy) en een rij in postnl_sessies.
// - Video: per context (recordVideo). Een segment eindigt bij een contextwissel (zelfde cookies,
//   geen nieuwe login, alleen als `cfg.contextWissel` aan staat: gemeten in stap 0) of bij het sluiten.
// - Trace: na het inloggen één keer gestart, daarna een chunk per taak. Wachtwoorden komen zo
//   nooit in de trace.
// - Alle Mendix-antwoorden van de huidige taak worden bewaard (`antwoorden`) voor de lezers.
// - Opnames (trace, video) gaan naar de schijf van de VPS, niet naar de database-opslag (duur):
//   $OPNAME_ROOT/{klant}/{depot}/…-latest.* en …/fout/…-{tijd}.* (30 dagen, zelf opgeruimd).
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { kiesProxy, sluitProxyAf } from '../../credentials-shared/src/proxyPool.js'
import { naarDepot, login } from '../../credentials-shared/src/postnl/login.js'
import { volgMendix } from '../../postnl-planner/src/mendix.js'
import { openRva } from '../../postnl-rva/src/scherm.js'
import { depotSlug, nlTijdstempel, BEWAAR_DAGEN } from '../../credentials-shared/src/sessieVideo.js'

export const WORKER = 'postnl-sessie'
export const OPNAME_ROOT = process.env.OPNAME_ROOT || '/var/log/workers/postnl/opnames'

// Kopieert een opname naar de VPS-map. Geslaagd: …-latest (overschreven); incident: fout/ met tijd.
export async function bewaarOpname(map, bron, naam, ext, incident) {
  const doel = incident ? path.join(map, 'fout', `${naam}-${nlTijdstempel()}.${ext}`) : path.join(map, `${naam}-latest.${ext}`)
  await fs.mkdir(path.dirname(doel), { recursive: true })
  await fs.copyFile(bron, doel)
  return doel
}

// Foutopnames ouder dan BEWAAR_DAGEN weg.
export async function ruimOpnamesOp(map, nu = Date.now()) {
  const fout = path.join(map, 'fout')
  const namen = await fs.readdir(fout).catch(() => [])
  for (const n of namen) {
    const st = await fs.stat(path.join(fout, n)).catch(() => null)
    if (st && nu - st.mtimeMs > BEWAAR_DAGEN * 86400_000) await fs.rm(path.join(fout, n), { force: true })
  }
}
const VIDEO = { width: 1280, height: 720 }

export class Sessie {
  constructor({ depot, klantId, supabase, chromium, opslag, cfg, log = console, headless = true }) {
    Object.assign(this, { depot, klantId, supabase, chromium, opslag, cfg, log, headless })
    this.browser = null
    this.context = null
    this.page = null
    this.rvaPage = null      // tweede tabblad voor RVA (matransport#569), pas geopend als nodig
    this.proxy = null
    this.id = null
    this.ingelogdOm = null
    this.segmentOm = null
    this.antwoorden = []
    this.lezingen = 0
    this.herlogins = 0
    this.incidentInSegment = false
    this.depotHost = new URL(depot.url).hostname
    this.opnameMap = path.join(OPNAME_ROOT, klantId, depotSlug(depot.naam))
  }

  get open() { return Boolean(this.page && !this.page.isClosed()) }
  get leeftijdMin() { return this.ingelogdOm ? (Date.now() - this.ingelogdOm) / 60_000 : 0 }

  async openen() {
    this.proxy = await kiesProxy(this.supabase, { worker: WORKER, depot: this.depot })
    const opties = { headless: this.headless, args: ['--disable-dev-shm-usage'] }
    if (process.env.CHROMIUM_EXECUTABLE_PATH) opties.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
    if (this.proxy) opties.proxy = this.proxy.proxy
    try {
      await ruimOpnamesOp(this.opnameMap).catch(() => {})
      this.browser = await this.chromium.launch(opties)
      await this.#nieuweContext()
      await naarDepot(this.page, this.depot, { log: this.log })
      await this.rvaOpenen()
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

  // Het RVA-tabblad (matransport#569): een tweede tabblad in dezelfde browser en context, dus
  // dezelfde login en cookies. Eén browser per depot, twee tabbladen die altijd open staan: OOM PD
  // (this.page) en RVA. Met cfg.rva meteen na het inloggen en na elk nieuw videosegment geopend;
  // de taak rvaWakker houdt het levend. rvaTab() opent het ook als het onverwacht dicht is.
  async rvaTab() {
    if (!this.context) throw new Error('Geen open sessie voor het RVA-tabblad')
    if (!this.rvaPage || this.rvaPage.isClosed()) this.rvaPage = await this.context.newPage()
    return this.rvaPage
  }

  // RVA openen als het aanstaat. Lukt het niet, dan gaat de sessie gewoon door (OOM PD werkt);
  // de volgende RVA-taak probeert het opnieuw.
  async rvaOpenen() {
    if (!this.cfg?.rva) return
    try {
      await openRva(await this.rvaTab(), { login: (p) => login(p, this.depot, { log: this.log }) })
    } catch (err) {
      this.log.warn(`[${this.depot.naam}] RVA-tabblad openen mislukt (volgende RVA-taak probeert opnieuw): ${err.message}`)
    }
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
      return await bewaarOpname(this.opnameMap, lokaal, `trace-${naam}`, 'zip', incident)
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
    const oud = { context: this.context, page: this.page, rvaPage: this.rvaPage, dir: this.videoDir }
    // Altijd één tabblad per app: eerst het oude sluiten, dan pas het nieuwe openen (zelfde cookies).
    // Het RVA-tabblad gaat mee dicht; de volgende RVA-taak opent het opnieuw.
    await oud.context.tracing.stop().catch(() => {})
    await oud.context.close().catch(() => {})
    this.rvaPage = null
    await this.#nieuweContext(state)
    await this.#bewaarVideo(oud.page, oud.dir, this.incidentInSegment, oud.rvaPage)
    this.incidentInSegment = false
    this.segmentOm = Date.now()
    try {
      const { ingelogd } = await naarDepot(this.page, this.depot, { log: this.log })
      await this.rvaOpenen()
      await this.#traceAan()
      if (ingelogd) { this.herlogins++; return false }
      return true
    } catch (err) {
      return false
    }
  }

  // Bewaart de video van het OOM PD-tabblad (en die van het RVA-tabblad als 'video-rva'), dan pas
  // de tijdelijke map weg: beide video's staan daarin. Geeft het pad van de OOM PD-video.
  async #bewaarVideo(page, dir, incident, rvaPage = null) {
    const bewaar = async (p, naam) => {
      const video = p?.video()
      if (!video) return null
      try {
        return await bewaarOpname(this.opnameMap, await video.path(), naam, 'webm', incident)
      } catch (err) {
        this.log.warn(`[${this.depot.naam}] Video ${naam} opslaan mislukt (gaat door): ${err.message}`)
        return null
      }
    }
    try {
      const pad = await bewaar(page, 'video')
      await bewaar(rvaPage, 'video-rva')
      return pad
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => {})
    }
  }

  // Sluiten met een reden (verlopen, gegooid, blokkade, nacht, leeg, herstart, …). Idempotent.
  async sluiten(reden, { fout = null, uitkomst = null } = {}) {
    const page = this.page
    const rvaPage = this.rvaPage
    const dir = this.videoDir
    const incident = this.incidentInSegment || !['nacht', 'leeg', 'herstart', 'vernieuwd', 'vernieuwd_voor_schrijven'].includes(reden)
    this.page = null
    this.rvaPage = null
    if (this.context) {
      await this.context.tracing.stop().catch(() => {})
      await this.context.close().catch(() => {})
    }
    await this.browser?.close().catch(() => {})
    this.context = null
    this.browser = null
    const video = await this.#bewaarVideo(page, dir, incident, rvaPage)
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
