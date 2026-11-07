// Eén browsersessie bij PostNL voor één depot (floatops/matransport#562): één browser, één login,
// één tabblad voor OOM PD en, als RVA aanstaat (matransport#569), een tweede tabblad voor RVA.
//
// - Elke nieuwe login krijgt een nieuw IP uit de proxy-pool (kiesProxy) en een rij in postnl_sessies.
// - Video: per context (recordVideo). Een segment eindigt bij een contextwissel (zelfde cookies,
//   geen nieuwe login, alleen als `cfg.contextWissel` aan staat: gemeten in stap 0) of bij het sluiten.
// - Trace: per taak gestart en gestopt. Logt een taak onderweg echt opnieuw in, dan staat de trace
//   stil zolang het wachtwoord getypt wordt: Playwright zet de waarde van elke fill() anders leesbaar
//   in de trace (matransport#600). Bewust geen chunks: Playwright kopieert bij elke stopChunk het hele netwerklog en
//   ruimt niets op tot de browser sluit. Bij een browser die de hele dag open blijft was dat
//   6-7 GB schijf per uur per depot (06-11, matransport#600).
// - Tijdelijke bestanden (trace, video) staan in één werkmap per depot, die de sessie zelf leegt:
//   na elke taak, na elke contextwissel, bij sluiten, en bij openen (restjes van een crash).
// - Alle Mendix-antwoorden van de huidige taak worden bewaard (`antwoorden`) voor de lezers.
// - Opnames (trace, video) gaan naar de schijf van de VPS, niet naar de database-opslag (duur):
//   $OPNAME_ROOT/{klant}/{depot}/…-latest.* en …/fout/…-{tijd}.* (30 dagen, zelf opgeruimd).
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { kiesProxy, sluitProxyAf, isProxyWeigering, PROXY_NETWERKFOUT } from '../../credentials-shared/src/proxyPool.js'
import { naarDepot, login, volgLogins, volgWachtwoord } from '../../credentials-shared/src/postnl/login.js'
import { maakLevensmeter, duurTekst } from './levensmeter.js'
import { volgMendix } from '../../postnl-planner/src/mendix.js'
import { openRva } from '../../postnl-rva/src/scherm.js'
import { depotSlug, nlTijdstempel, BEWAAR_DAGEN } from '../../credentials-shared/src/sessieVideo.js'

export const WORKER = 'postnl-sessie'
// LOG_ROOT: Stack B logt in zijn eigen map; de map van Stack A is voor die gebruiker niet schrijfbaar.
export const OPNAME_ROOT = process.env.OPNAME_ROOT || path.join(process.env.LOG_ROOT || '/var/log/workers', 'postnl', 'opnames')
// Per gebruiker: /tmp is gedeeld, Stack A draait als root en Stack B als floatops-b, en een klant-uuid
// kan op beide stacks bestaan (Stack B is een kloon).
export const WERK_ROOT = process.env.SESSIE_WERK_ROOT || path.join(os.tmpdir(), `postnl-sessie-werk-${process.getuid?.() ?? 'lokaal'}`)
const TRACE_MS = 60_000   // grens op tracing.start/stop: een trace mag een taak nooit laten hangen
const SLUIT_MS = 30_000   // grens op browseraanroepen bij het sluiten: dit is juist het noodpad
// context.close() maakt de video's van 30 min af (twee tabbladen). Op 06-11 duurde dat langer dan
// 30 s, en toen gaf elk videosegment een nieuwe login op beide depots (matransport#600).
export const CONTEXT_SLUIT_MS = 150_000

function grens(belofte, ms, wat) {
  let t
  const klok = new Promise((_, nee) => { t = setTimeout(() => nee(new Error(`${wat} duurde langer dan ${Math.round(ms / 1000)} s`)), ms) })
  return Promise.race([belofte, klok]).finally(() => clearTimeout(t))
}

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
// Zelfde verhouding als de viewport (1440x900). Tot 07-11 1280x720: met vier opnames tegelijk liep
// ffmpeg (VP8, één thread) zo ver achter dat het sluiten van een segment opliep tot boven de 150 s,
// en elke keer kostte dat een sessie en een login (matransport#613). 960x600 = 37% minder pixels.
export const VIDEO = { width: 960, height: 600 }

export class Sessie {
  constructor({ depot, klantId, supabase, chromium, opslag, cfg, log = console, headless = true, contextSluitMs = CONTEXT_SLUIT_MS }) {
    Object.assign(this, { depot, klantId, supabase, chromium, opslag, cfg, log, headless, contextSluitMs })
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
    this.huidigeTaak = null
    this.herloginTaak = 0    // fouten 460 tijdens de huidige taak (matransport#598)
    // Proxy-signalen tijdens de huidige taak, op beide tabbladen (matransport#613): 407-antwoorden
    // (de aanbieder weigert) en verzoeken die de proxy niet doorliet (dan toetst de depot-lus).
    this.proxy407 = 0
    this.tunnelFouten = 0
    // Tijdstippen (ms) van alle 460's in deze sessie. Bewust een andere naam dan `herlogins` (het
    // aantal logins in hetzelfde tabblad, een getal naar postnl_sessies.herlogins): in 33f0ae9 deelden
    // ze één naam, waardoor het afsluiten van een sessie faalde en een 460 na een her-login het
    // proces kon laten crashen (#599, gevonden door de worker-controleur).
    this.fouten460 = []
    // Hoe lang blijft de sessie geldig, per tabblad (levensmeter.js)
    this.meters = { oompd: maakLevensmeter({ tab: 'oompd' }), rva: maakLevensmeter({ tab: 'rva' }) }
    this.incidentInSegment = false
    this.depotHost = new URL(depot.url).hostname
    this.opnameMap = path.join(OPNAME_ROOT, klantId, depotSlug(depot.naam))
    this.werkMap = path.join(WERK_ROOT, klantId, depotSlug(depot.naam))
    this.tracesDir = path.join(this.werkMap, 'traces')
    this.traceLoopt = false
  }

  get open() { return Boolean(this.page && !this.page.isClosed()) }
  get leeftijdMin() { return this.ingelogdOm ? (Date.now() - this.ingelogdOm) / 60_000 : 0 }

  async openen() {
    this.proxy = await kiesProxy(this.supabase, { worker: WORKER, depot: this.depot })
    // tracesDir: anders in de eigen playwright-artifacts-map van de browser, die pas bij sluiten weggaat.
    // handleSIGTERM/SIGINT uit: anders sluit Playwright bij een SIGTERM meteen de browser, en faalt de
    // lopende taak (07-11 22:12, proef matransport#613: Waddinxveen "browser_weg"). index.js stopt zelf
    // netjes na de lopende taak. Valt het proces hard weg, dan sluit Chromium vanzelf: de pipe is dicht.
    const opties = { headless: this.headless, args: ['--disable-dev-shm-usage'], tracesDir: this.tracesDir, handleSIGTERM: false, handleSIGINT: false }
    if (process.env.CHROMIUM_EXECUTABLE_PATH) opties.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
    if (this.proxy) opties.proxy = this.proxy.proxy
    try {
      await ruimOpnamesOp(this.opnameMap).catch(() => {})
      // Eén sessie per depot (slot), dus wat hier nog staat is van een crash.
      await this.#legeTraces(true)
      this.browser = await this.chromium.launch(opties)
      await this.#nieuweContext()
      await naarDepot(this.page, this.depot, { log: this.log })
      await this.rvaOpenen()
      this.ingelogdOm = Date.now()
      this.segmentOm = Date.now()
      this.meters.oompd.start()
      if (this.rvaPage && !this.rvaPage.isClosed()) this.meters.rva.start()
      this.id = await this.opslag.sessieStart({ depot: this.depot.naam, proxyGebruikId: this.proxy?.gebruikId, externIp: this.proxy?.label?.match(/\(([^)]+)\)/)?.[1] ?? null })
      this.log.log(`[${this.depot.naam}] Ingelogd (${this.proxy?.label ?? 'geen proxy'})`)
    } catch (err) {
      err.page = this.page
      // De proxy van deze poging: sluiten() vergeet hem, de depot-lus wil hem nog toetsen (#613).
      err.proxy = this.proxy?.proxy ?? null
      // De depot-lus heeft nog geen sessie: geef mee wat de tabbladen tijdens het inloggen zagen.
      err.proxy407 = this.proxy407
      err.tunnelFouten = this.tunnelFouten
      await this.sluiten('login_mislukt', { fout: err }).catch(() => {})
      throw err
    }
  }

  async #nieuweContext(storageState = null) {
    this.videoDir = await fs.mkdtemp(path.join(this.werkMap, 'video-'))
    this.context = await this.browser.newContext({
      serviceWorkers: 'block', timezoneId: 'Europe/Amsterdam', viewport: { width: 1440, height: 900 },
      recordVideo: { dir: this.videoDir, size: VIDEO },
      ...(storageState ? { storageState } : {}),
    })
    volgWachtwoord(this.context, { voor: () => this.#tracePauze(), na: () => this.#traceHervat() })
    this.page = await this.context.newPage()
    volgLogins(this.page, () => this.#verlopen('oompd'))
    this.#volgTunnel(this.page)
    this.mendix = volgMendix(this.page)
    this.page.on('response', (res) => {
      if (!res.url().includes('/xas/')) return
      // 460: PostNL trekt de Mendix-sessie in; de app logt daarna zelf stil opnieuw in (SSO).
      // Tellen per taak en voor het uurtotaal (matransport#598).
      if (res.status() === 460) {
        this.herloginTaak++
        this.fouten460.push(Date.now())
        const uur = this.fouten460.filter(t => Date.now() - t <= 3600_000).length
        this.log.warn(`[${this.depot.naam}] Fout 460: PostNL trok de sessie in tijdens ${this.huidigeTaak ?? 'geen taak'} (${uur} in het afgelopen uur)`)
        return
      }
      res.json().then(j => this.antwoorden.push(j)).catch(() => {})
    })
  }

  // Het RVA-tabblad (matransport#569): een tweede tabblad in dezelfde browser en context, dus
  // dezelfde login en cookies. Eén browser per depot, twee tabbladen die altijd open staan: OOM PD
  // (this.page) en RVA. Met cfg.rva meteen na het inloggen en na elk nieuw videosegment geopend;
  // de taak rvaWakker houdt het levend. rvaTab() opent het ook als het onverwacht dicht is.
  async rvaTab() {
    if (!this.context) throw new Error('Geen open sessie voor het RVA-tabblad')
    if (!this.rvaPage || this.rvaPage.isClosed()) {
      this.rvaPage = await this.context.newPage()
      volgLogins(this.rvaPage, () => this.#verlopen('rva'))
      this.#volgTunnel(this.rvaPage)
    }
    return this.rvaPage
  }

  // Verzoeken die de proxy niet doorliet. 07-11 (matransport#613): de aanbieder gaf 407 op elke
  // CONNECT; in het RVA-tabblad gaf dat "Fout – Er is een fout opgetreden" en lege pagina's. Een 407
  // is de aanbieder zelf (gemeten: response met status 407, gevolgd door requestfailed met
  // ERR_TUNNEL_CONNECTION_FAILED); alleen de tunnelfout laat de depot-lus nog toetsen.
  #volgTunnel(page) {
    page.on('response', (res) => { if (isProxyWeigering(res)) this.proxy407++ })
    page.on('requestfailed', (req) => {
      if (PROXY_NETWERKFOUT.test(req.failure()?.errorText ?? '')) this.tunnelFouten++
    })
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

  // Tijdelijke trace-bestanden weg. Tussen taken alles behalve resources/: Playwright onthoudt per
  // context welke resources het al schreef en schrijft die niet opnieuw, dus die horen bij de
  // context. `alles`: de hele werkmap opnieuw (bij openen, restjes van een crash).
  async #legeTraces(alles = false) {
    if (this.traceLoopt) return
    try {
      if (alles) await fs.rm(this.werkMap, { recursive: true, force: true })
      await fs.mkdir(this.tracesDir, { recursive: true })
      for (const n of await fs.readdir(this.tracesDir)) {
        if (n !== 'resources') await fs.rm(path.join(this.tracesDir, n), { recursive: true, force: true })
      }
    } catch (e) {
      this.log.warn(`[${this.depot.naam}] Trace-map opruimen mislukt (volgende keer opnieuw): ${e.message}`)
    }
  }

  // Er wordt in een tabblad ingelogd. Was dat tabblad al ingelogd, dan liet PostNL de sessie
  // verlopen: meting vastleggen (postnl_sessies.gebeurtenissen, soort sessie_verlopen).
  #verlopen(tab) {
    const meting = this.meters[tab].login({ taak: this.huidigeTaak })
    if (!meting) return
    this.herlogins++
    this.log.log(`[${this.depot.naam}] Sessie verlopen (${tab}) na ${duurTekst(meting.duurMin)} (${duurTekst(meting.stilMin)} stil, tijdens ${meting.taak ?? 'geen taak'}), opnieuw ingelogd in hetzelfde tabblad`)
    // Fouten 460 in het uur ervoor: dan trok PostNL de sessie in, geen zuivere meting (#598).
    const herlogins = this.fouten460.filter(t => Date.now() - t <= 3600_000).length
    this.opslag.gebeurtenis(this.id, { soort: 'sessie_verlopen', ...meting, ...(herlogins ? { herlogins } : {}) }).catch?.(() => {})
  }

  // Vóór het typen van het wachtwoord: wat er tot nu toe is opslaan (een her-login midden in een
  // taak is altijd de moeite waard) en de trace stilzetten. `na` start hem weer.
  async #tracePauze() {
    if (!this.traceLoopt) return
    const naam = this.huidigeTaak ?? 'taak'
    const lokaal = path.join(this.videoDir ?? os.tmpdir(), `trace-${naam}-${Date.now()}.zip`)
    try {
      await grens(this.context.tracing.stop({ path: lokaal }), TRACE_MS, 'Trace opslaan')
      await bewaarOpname(this.opnameMap, lokaal, `trace-${naam}-voor-login`, 'zip', true)
    } catch (e) {
      this.log.warn(`[${this.depot.naam}] Trace vóór de login opslaan mislukt: ${e.message}`)
      await grens(this.context.tracing.stop(), TRACE_MS, 'Trace stoppen').catch(() => {})
    } finally {
      this.traceLoopt = false
      this.tracePauzeVan = naam
      await fs.rm(lokaal, { force: true }).catch(() => {})
      await this.#legeTraces()
    }
  }

  async #traceHervat() {
    const naam = this.tracePauzeVan
    this.tracePauzeVan = null
    if (naam && this.context) await this.#startTrace(naam)
  }

  // Vóór elke taak: lege lijst Mendix-antwoorden en een nieuwe trace.
  async taakBegin(naam) {
    this.huidigeTaak = naam
    this.herloginTaak = 0
    this.proxy407 = 0
    this.tunnelFouten = 0
    this.antwoorden = []
    this.tracePauzeVan = null
    if (this.context) await this.#startTrace(naam)
  }

  async #startTrace(naam) {
    const start = () => grens(this.context.tracing.start({ title: naam, screenshots: true, snapshots: true }), TRACE_MS, 'Trace starten')
    try {
      // Een trace die nog loopt (stoppen mislukte eerder) eerst weg, anders weigert start().
      await start().catch(async () => {
        await grens(this.context.tracing.stop(), TRACE_MS, 'Trace stoppen')
        await start()
      })
      this.traceLoopt = true
    } catch (e) {
      this.log.warn(`[${this.depot.naam}] Trace starten mislukt (taak gaat door zonder): ${e.message}`)
    }
  }

  // Na elke taak: trace opslaan en de tijdelijke bestanden weg. Met een incident naar fout/
  // (30 dagen), anders alleen de laatste per taak. Geeft het opslagpad of null.
  async taakEinde(naam, { incident = false, tab = 'oompd' } = {}) {
    this.huidigeTaak = null
    this.meters[tab]?.taakKlaar()
    if (tab === 'rva') this.meters.rva.start()   // eerste geslaagde RVA-taak: vanaf nu meten
    if (!this.context) return null
    if (incident) this.incidentInSegment = true
    if (!this.traceLoopt) return null
    const lokaal = path.join(this.videoDir ?? os.tmpdir(), `trace-${naam}-${Date.now()}.zip`)
    try {
      await grens(this.context.tracing.stop({ path: lokaal }), TRACE_MS, 'Trace opslaan')
      return await bewaarOpname(this.opnameMap, lokaal, `trace-${naam}`, 'zip', incident)
    } catch (err) {
      this.log.warn(`[${this.depot.naam}] Trace opslaan mislukt (gaat door): ${err.message}`)
      // Mislukt het inpakken, dan draait de trace nog: stoppen, anders weigert de volgende start.
      await grens(this.context.tracing.stop(), TRACE_MS, 'Trace stoppen').catch(() => {})
      return null
    } finally {
      this.traceLoopt = false
      await fs.rm(lokaal, { force: true }).catch(() => {})
      await this.#legeTraces()
    }
  }

  // Nieuw videosegment zonder nieuwe login: zelfde browser en IP, cookies meegenomen.
  // Geeft false als de sessie daarna niet meer ingelogd is (dan is dat zelf een meting).
  async nieuwSegment() {
    // Grenzen: dit is ook het noodpad voor een handler die hangt, dan kan de browser zelf vastzitten.
    const state = await grens(this.context.storageState(), SLUIT_MS, 'Cookies lezen')
    const oud = { context: this.context, page: this.page, rvaPage: this.rvaPage, dir: this.videoDir }
    // Altijd één tabblad per app: eerst het oude sluiten, dan pas het nieuwe openen (zelfde cookies).
    // Het RVA-tabblad gaat mee dicht; de volgende RVA-taak opent het opnieuw.
    await grens(oud.context.tracing.stop(), SLUIT_MS, 'Trace stoppen').catch(() => {})
    this.traceLoopt = false
    const sluitBegin = Date.now()
    // Eerst de tabbladen leeg: daarna praat de oude context niet meer met PostNL. Niet page.close():
    // die wacht net als context.close() op ffmpeg, en het tabblad blijft zolang verkeer geven
    // (gemeten: 8 s ffmpeg = 8 s page.close(), about:blank 25 ms en daarna geen verzoek meer).
    let leeg = true
    for (const p of [oud.page, oud.rvaPage]) {
      if (p && !p.isClosed()) await grens(p.goto('about:blank'), SLUIT_MS, 'Tabblad leegmaken').catch((e) => { leeg = false; this.log.warn(`[${this.depot.naam}] ${e.message}`) })
    }
    // context.close() wacht tot ffmpeg de video's af heeft. Liep dat uit (06-11: tot boven de 150 s,
    // elke keer een sessie en een login kwijt, matransport#613), dan is er niets mis met de sessie:
    // de tabbladen zijn leeg. Dan door met de nieuwe context; de half geschreven video van dit
    // segment wordt niet bewaard, en de map gaat weg zodra het sluiten toch klaar is.
    const dicht = oud.context.close()
    let videoKlaar = true
    try {
      await grens(dicht, this.contextSluitMs, 'Context sluiten')
      this.log.log(`[${this.depot.naam}] Videosegment: context dicht in ${Math.round((Date.now() - sluitBegin) / 1000)} s`)
    } catch (err) {
      if (!leeg) throw err   // het oude tabblad draait nog: geen tweede Mendix ernaast, de sessie gaat dicht
      videoKlaar = false
      this.log.warn(`[${this.depot.naam}] Videosegment: ${err.message}; tabbladen zijn leeg, verder zonder de video van dit segment`)
      this.opslag.gebeurtenis(this.id, { soort: 'video_traag', sec: Math.round((Date.now() - sluitBegin) / 1000) }).catch?.(() => {})
      dicht.catch(() => {}).finally(() => fs.rm(oud.dir, { recursive: true, force: true }).catch(() => {}))
    }
    this.rvaPage = null
    await fs.rm(this.tracesDir, { recursive: true, force: true }).catch(() => {})   // resources/ hoort bij de oude context
    await this.#legeTraces()
    await this.#nieuweContext(state)
    if (videoKlaar) await this.#bewaarVideo(oud.page, oud.dir, this.incidentInSegment, oud.rvaPage)
    this.incidentInSegment = false
    this.segmentOm = Date.now()
    try {
      const { ingelogd } = await naarDepot(this.page, this.depot, { log: this.log })
      await this.rvaOpenen()
      if (ingelogd) return false   // telt de levensmeter (login in dit tabblad)
      return true
    } catch (err) {
      // Een geweigerde proxy is geen verlopen sessie: de depot-lus moet hem zien (matransport#613).
      if (err.name === 'ProxyGeweigerdError') throw err
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
      await grens(this.context.tracing.stop(), SLUIT_MS, 'Trace stoppen').catch(() => {})
      await grens(this.context.close(), this.contextSluitMs, 'Context sluiten').catch(() => {})
    }
    if (this.browser) await grens(this.browser.close(), SLUIT_MS, 'Browser sluiten').catch(e => this.log.warn(`[${this.depot.naam}] ${e.message}`))
    this.context = null
    this.browser = null
    this.traceLoopt = false
    const video = await this.#bewaarVideo(page, dir, incident, rvaPage)
    await fs.rm(this.werkMap, { recursive: true, force: true }).catch(() => {})
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
