// ============================================================
// POSTNL RITMONITOR-WORKER (zelfstandig, eigen proces/poort).
// Leest elke 5 min de live voortgang uit Planning → Ritmonitor:
// "Aantal stops" + "Stops te doen" + "Tijdstip laatste actie" per rit,
// en schrijft dat naar de ritten-tabel (postnl_stops_totaal e.d.).
//
// Standaard-code (config, helpers, login, depots, sessie) is bewust
// IDENTIEK aan worker/postnl-sync — elke worker is zelfstandig.
//
// Draaien:
//   npm start              → daemon: HTTP POST /sync-monitor (+ optionele cron)
//   npm run sync:once      → één keer draaien en stoppen (test)
// ============================================================

import 'dotenv/config'
import cron from 'node-cron'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { getDepots } from '../../credentials-shared/src/index.js'
import { installeerNeutraleConsole } from '../../credentials-shared/src/publiekLog.js'
import {
  kiesProxy, sluitProxyAf, detecteerBlok, isBlokStatus, uitkomstBijFout,
  proxyPoolAan, ProxyBlokkadeError,
} from '../../credentials-shared/src/proxyPool.js'
import { nlTijdstipNaarIso as tijdstipNaarIso, nieuweEindtijd } from './eindtijd.js'
import { bewaarVideo, latestPad, foutPad, ruimOudeFoutVideosOp } from '../../credentials-shared/src/sessieVideo.js'
import { pakSessieSlot } from '../../credentials-shared/src/sessieSlot.js'

// Proxy per browsersessie: zie credentials-shared/src/proxyPool.js. Op de VPS
// (PROXY_POOL=true) krijgt elke sessie het volgende IP uit de eigen pool en wordt
// elke blokkade gelogd; op GitHub Actions het oude gedrag (optioneel PROXY_SERVER).
// Hoe vaak een depot bij het openen van een sessie een ander IP probeert als het
// huidige geblokkeerd blijkt, vóór het depot voor deze run opgeeft.
const MAX_BLOKKADES_PER_OPEN = Number(process.env.PROXY_MAX_BLOKKADES || 3)

const CONFIG = {
  timezone: process.env.TZ || 'Europe/Amsterdam',
  headless: String(process.env.POSTNL_HEADLESS ?? 'true').toLowerCase() !== 'false',
  slowMo: Number(process.env.POSTNL_SLOWMO || 0),
  // Herhaald uitlezen binnen één run (sinds 2026-09-12): de eindtijd is de laatste
  // registratie van de dag, en die "afsluit-registratie" staat vaak maar kort in de
  // grid voordat PostNL de rit eruit haalt. Met één lezing per 7 min werd hij in
  // 343 van 445 gevallen gemist. Daarom leest elke run de grid opnieuw tot het
  // venster om is (5 min: met opstarten en inloggen ~6 min, past vóór de volgende 7-min-trigger), met een pauze
  // ertussen. Noodrem bij Akamai-/rate-problemen: RITMONITOR_VENSTER_SEC=0 als
  // GitHub-variabele → één lezing per run, zoals vóór deze wijziging.
  // Let op: een niet-bestaande GitHub-variabele komt binnen als '' (niet undefined),
  // en Number('') is 0 — dat zou onbedoeld de noodrem zijn. Daarom ook '' → standaard.
  vensterSec: Number(process.env.RITMONITOR_VENSTER_SEC || 300),
  intervalSec: Number(process.env.RITMONITOR_INTERVAL_SEC || 60),
  // Een mislukte lezing beëindigde tot 2026-09-17 het hele leesvenster van dat
  // depot (één `break`), ook al was het een transiente fout en waren er nog
  // minuten over. In de 7 dagen ervóór haalde 8% van de runs daardoor minder
  // dan 5 lezingen voor minstens één depot — precies waar de wachtdog
  // `check_ritmonitor_eindtijd()` op alarmeert, en precies het scenario waarvoor
  // het herhaald lezen bestaat (de afsluit-registratie missen). Nu wordt een
  // lezing opnieuw geprobeerd, en na de helft van die pogingen wordt de hele
  // browsersessie vervangen (hetzelfde escalatiepatroon als de route-TVI-scraper
  // in matransport: eerst opnieuw navigeren, dan pas een verse sessie). Korte
  // pauze ertussen i.p.v. het volle interval — het venster is de grens, niet het
  // aantal pogingen.
  maxFoutenAchtereen: Number(process.env.RITMONITOR_MAX_FOUTEN || 3),
  foutWachtSec: Number(process.env.RITMONITOR_FOUT_WACHT_SEC || 10),
}

function requireEnv(name) {
  const value = process.env[name]
  if (!value) throw new Error(`Ontbrekende env variabele: ${name}`)
  return value
}

const supabase = createClient(
  requireEnv('SUPABASE_URL'),
  requireEnv('SUPABASE_SERVICE_ROLE_KEY'),
  { auth: { persistSession: false } }
)

const KLANT_ID = requireEnv('KLANT_ID')

function vandaagNl() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: CONFIG.timezone,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(new Date())
  const map = Object.fromEntries(parts.map(p => [p.type, p.value]))
  return `${map.year}-${map.month}-${map.day}`
}

function normaliseerRitnummer(value) {
  const digits = String(value || '').match(/\d+/)?.[0] || ''
  return digits ? String(parseInt(digits, 10)) : ''
}

// Reserve-ritten: 4-cijferig ritnummer, of het "shift"-cijfer (het eerste cijfer
// van het ritnummer) is '9' — PostNL's eigen conventie voor reservechauffeurs
// zonder vaste dienst. shift_tijden (matransport) kent alleen shift 1-6, dus een
// reserve-rit heeft nooit een geldige shift-begintijd — de begintijd komt in
// plaats daarvan uit de eerst gelezen "laatste actie"-tijd, niet het loutere
// detectiemoment (zie opslaanMonitorInSupabase hieronder).
function isReserveRitnummer(ritnummer) {
  const s = String(ritnummer || '')
  return s.length === 4 || s.charAt(0) === '9'
}

// Ad-ritten (avondritten): kanaal-code 'AD' uit de Ritmonitor-kolom "Kanaal".
// Hebben geen shift (geen shift_tijden-data voor avondritten) en een vaste
// begintijd van 17:00.
function isAdKanaal(kanaal) {
  return kanaal === 'AD'
}

function toNumber(value) {
  if (!value) return null
  const n = Number(String(value).trim().replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// Zet een "HH:MM"-tijd uit shift_tijden (NL-lokaal) om naar een UTC ISO-string.
// Shift-tijden komen uit de e-mail (altijd NL-lokale wandkloktijd, niet van
// PostNL's Mendix-grid) — dus hier geen heuristiek nodig: gewoon de offset
// van Europe/Amsterdam op die datum aftrekken.
function shiftTijdNaarIso(datum, tijd) {
  if (!datum || !tijd) return null
  const m = String(tijd).match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  const asUtc = new Date(`${datum}T${m[1].padStart(2, '0')}:${m[2]}:00Z`)
  if (Number.isNaN(asUtc.getTime())) return null
  const offsetNaam = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Amsterdam', timeZoneName: 'longOffset' })
    .formatToParts(asUtc).find(p => p.type === 'timeZoneName')?.value || ''
  const om = offsetNaam.match(/([+-])(\d{2}):(\d{2})/)
  const offsetMin = om ? (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3])) : 0
  return new Date(asUtc.getTime() - offsetMin * 60000).toISOString()
}

// "Tijdstip laatste actie" (HH:MM) → ISO-timestamp, in dezelfde tijdzone als de
// browser-context rendert (timezoneId in openDepotSessie). Zie src/eindtijd.js
// voor waarom hier niet meer tussen UTC en NL-lokaal gegokt wordt.
function nlTijdstipNaarIso(datum, tekst, nuMs = Date.now()) {
  return tijdstipNaarIso(datum, tekst, nuMs, CONFIG.timezone)
}

// detecteerBlok() (Akamai-/WAF-pagina herkennen) staat sinds #173 in
// credentials-shared/src/proxyPool.js, gedeeld met postnl-dagplanning.

const SEL_LOGIN_VELD = 'input[type="text"], input[type="email"]'

async function loginPostnl(page, depot) {
  console.log(`[${depot.naam}] Login pagina URL:`, page.url())
  // Het invoerveld staat soms al in de DOM terwijl het nog verborgen is (de
  // PCI-loginpagina hydrateert traag): 8 van de 34 mislukte depot-runs in de week
  // vóór 2026-09-17 strandden op "locator resolved to hidden" na 15 s. Langer
  // wachten en anders één keer herladen kost hooguit een halve minuut van het
  // leesvenster; een mislukte login kost het depot de hele run.
  try {
    await page.locator(SEL_LOGIN_VELD).first().waitFor({ state: 'visible', timeout: 45000 })
  } catch {
    const blok = await detecteerBlok(page)
    console.warn(`[${depot.naam}] Loginveld niet zichtbaar na 45 s${blok.isBlok ? ' — ⛔ MOGELIJKE IP-BLOKKERING' : ''} (titel: "${blok.title}")`)
    if (blok.isBlok) console.error(`[${depot.naam}] Body: ${blok.snippet}`)
    // Met de pool helpt herladen niet: dit IP is geblokkeerd. Meteen afbreken, zodat
    // de sessie het als blokkade afsluit en met het volgende IP opnieuw begint.
    if (blok.isBlok && proxyPoolAan()) throw new ProxyBlokkadeError(`Loginpagina geblokkeerd: ${blok.title || blok.snippet.slice(0, 80)}`)
    await page.reload({ waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
    await page.locator(SEL_LOGIN_VELD).first().waitFor({ state: 'visible', timeout: 45000 })
  }
  await page.locator(SEL_LOGIN_VELD).first().fill(depot.username)
  await page.locator('input[type="password"]').first().fill(depot.password)
  await page.locator('button[data-trn-key="login.butlogin"]').click()
  // Wacht tot we van de loginpagina af zijn. NIET op '**pnl-oompd**' wachten:
  // de login-URL bevat die string zelf (in de redirect-param) → vals-positief.
  await page.waitForFunction(() => !window.location.hostname.includes('loginpostnl'), { timeout: 90000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {})
  if (page.url().includes('loginpostnl')) throw new Error(`Login mislukt. URL na login: ${page.url()}`)
  console.log(`[${depot.naam}] Ingelogd, URL:`, page.url())
}

// Opent een sessie; is het IP geblokkeerd, dan meteen opnieuw met het volgende IP
// uit de pool (tot MAX_BLOKKADES_PER_OPEN). Andere fouten gaan direct door.
async function openDepotSessie(depot) {
  for (let poging = 1; ; poging++) {
    try {
      return await openDepotSessieEenmaal(depot)
    } catch (err) {
      if (!(err instanceof ProxyBlokkadeError) || poging >= MAX_BLOKKADES_PER_OPEN) throw err
      console.warn(`[${depot.naam}] ⛔ IP geblokkeerd (${err.message}) — opnieuw met het volgende IP (${poging}/${MAX_BLOKKADES_PER_OPEN})`)
    }
  }
}

// Opent browser + context (met opgeslagen sessie indien aanwezig) + page,
// navigeert naar het depot en logt in indien nodig. Mislukt dat, dan wordt het
// proxy-gebruik hier al afgesloten (fout of blokkade) en de browser gesloten.
async function openDepotSessieEenmaal(depot) {
  const launchOptions = { headless: CONFIG.headless, slowMo: CONFIG.slowMo, args: ['--disable-dev-shm-usage'] }
  if (process.env.CHROMIUM_EXECUTABLE_PATH) launchOptions.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  const sessie = await kiesProxy(supabase, { worker: 'postnl-ritmonitor', depot })
  if (sessie) {
    launchOptions.proxy = sessie.proxy
    console.log(`[${depot.naam}] Proxy: ${sessie.label}`)
  }
  let browser = null
  let page = null
  try {
    browser = await chromium.launch(launchOptions)
    const geopend = await openInBrowser(browser, depot)
    page = geopend.page
    return { browser, ...geopend, sessie }
  } catch (err) {
    await sluitProxyAf(supabase, sessie, await uitkomstBijFout(err, page ?? err.page), err.message)
    await browser?.close().catch(() => {})
    throw err
  }
}

async function openInBrowser(browser, depot) {

  // serviceWorkers blokkeren: de Mendix service-worker veroorzaakt anders
  // herlaad-/chrome-error-loops vlak na de OAuth-redirect.
  // timezoneId expliciet zetten: zonder dit rendert Mendix "Tijdstip laatste
  // actie" client-side in de systeem-tijdzone van de scrape-browser i.p.v.
  // NL-lokale tijd — gaf een structureel 2 uur (CEST) verschil met wat een
  // mens op de site ziet, en dat plantte zich door in postnl_eind_werktijd
  // (via nlTijdstipNaarIso, die de tekst juist als NL-lokaal interpreteert).
  const contextOptions = { serviceWorkers: 'block', timezoneId: CONFIG.timezone }
  try {
    const fsSync = await import('node:fs')
    if (depot.storageState && fsSync.existsSync(depot.storageState)) contextOptions.storageState = depot.storageState
  } catch {}

  // Video-opname van de sessie — op verzoek, zodat je kan meekijken in de
  // browser zonder zelf POSTNL_HEADLESS=false te hoeven draaien. Bewaard via
  // bewaarSessieVideo() na afloop (overwrite-latest per depot, zie migration_v156).
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessie-video-'))
  contextOptions.recordVideo = { dir: videoDir, size: { width: 1280, height: 720 } }

  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()

  try {
    const response = await page.goto(depot.url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => null)
    if (isBlokStatus(response) && proxyPoolAan()) throw new ProxyBlokkadeError('HTTP 403 op het portaal')
    if (page.url().includes('loginpostnl') || page.url().includes('/login') || page.url().includes('/authorize')) {
      await loginPostnl(page, depot)
    }
  } catch (err) {
    err.page = page // voor uitkomstBijFout(): blokkadepagina herkennen vóór het sluiten
    throw err
  }
  return { context, page }
}

// Koppelt chauffeur_id aan postnl_chauffeur — en corrigeert 'm ook als 'ie al
// gezet was (geen .is('chauffeur_id', null) meer, sinds 2026-08-24). Een rit
// mag nooit een andere chauffeur_id hebben dan wie PostNL's eigen data zegt
// dat er reed — dat veld bepaalt wie voor de stops betaald krijgt. Zonder
// deze correctie bleef een rit voor altijd aan de eerst-gekoppelde chauffeur
// hangen, ook als er in werkelijkheid een chauffeurwissel was (bv. rit 333 op
// 12 aug 2026: chauffeur_id wees naar Mulubrhan Haile terwijl postnl_chauffeur
// al lang "Saboune, Y." zei — nooit gecorrigeerd doordat de oude .is(null)
// -guard elke volgende sync blokkeerde).
//
// Dit botst niet met de oorspronkelijke reden voor die guard (issue #71: een
// handmatige herindeling via RitForm/RitDetail mag niet worden teruggedraaid)
// — .eq('postnl_chauffeur', u.postnl_naam) matcht sowieso nooit een rit met
// postnl_chauffeur = null, en dat is precies het geval bij @Home/freelance-
// ritten (geen PostNL-account, dus nooit een postnl_chauffeur-waarde) waar
// handmatige chauffeur-wissel voor bedoeld is. Regulier gescrapete ritten
// hébben altijd een postnl_chauffeur-waarde zodra ze in de Ritmonitor-grid
// verschijnen, en daar is die waarde leidend.
async function koppelChauffeurs() {
  const klantId = KLANT_ID
  const { data: users } = await supabase
    .from('users').select('id, postnl_naam')
    .eq('klant_id', klantId)
    .not('postnl_naam', 'is', null).neq('postnl_naam', '')
  if (!users?.length) return
  let totaal = 0
  for (const u of users) {
    // .or(...) matcht alleen rijen die écht een andere chauffeur_id nodig
    // hebben (null, of een andere waarde) — puur om onnodige writes en een
    // opgeblazen "X bijgewerkt"-log te vermijden. Niet nodig voor correctheid:
    // de DB-trigger trg_notify_rit_toegewezen (migration_v139) no-opt zelf al
    // bij een ongewijzigde waarde, dus een overbodige write zou sowieso geen
    // dubbele pushmelding veroorzaken.
    const { data } = await supabase.from('ritten')
      .update({ chauffeur_id: u.id })
      .eq('klant_id', klantId)
      .eq('postnl_chauffeur', u.postnl_naam)
      .or(`chauffeur_id.is.null,chauffeur_id.neq.${u.id}`)
      .select('id')
    totaal += data?.length ?? 0
  }
  if (totaal > 0) console.log(`Chauffeurs gekoppeld/gecorrigeerd: ${totaal} ritten bijgewerkt`)
}

// ---- Ritmonitor-specifiek ---------------------------------------

// Navigeert naar Planning → Ritmonitor. De Riteigenaar-grid (M&A Transport)
// is daar al geselecteerd — daar NIET op klikken, anders deselecteer je 'm.
async function openRitmonitor(page, depot) {
  const depotUrl = depot.url
  const planningLoc = () => page.locator('a.mx-name-menuBar1-2, a[title="Planning"]').first()
  const isOAuth = () => page.url().includes('loginpostnl') || page.url().includes('/authorize')

  // Mendix start de OAuth-redirect soms pas ná de goto (tijdens het laden van de app),
  // waardoor een URL-check na goto het mist. Oplossing: poll elke seconde totdat het
  // Planning-menu zichtbaar is of OAuth gedetecteerd wordt — dan herlogin en ga door.
  async function waitForPlanning(maxMs = 90000) {
    const deadline = Date.now() + maxMs
    let herlogins = 0
    while (Date.now() < deadline) {
      if (isOAuth()) {
        if (herlogins >= 3) throw new Error(`Planning-menu niet bereikbaar na ${herlogins} herlogins`)
        herlogins++
        console.log(`[${depot.naam}] OAuth-redirect gedetecteerd (herlogin ${herlogins})...`)
        await loginPostnl(page, depot)
        await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
        await page.waitForTimeout(2000)
        continue
      }
      if (await planningLoc().isVisible()) return
      await page.waitForTimeout(1000)
    }
    throw new Error(`Planning-menu niet zichtbaar na ${maxMs / 1000}s (url: ${page.url()})`)
  }

  await page.goto(depotUrl, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => {})
  await page.waitForTimeout(2000)
  await waitForPlanning()

  await planningLoc().click()
  await page.waitForTimeout(600)
  await page.locator('a[title="Ritmonitor"]').first().click()
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
  await page.waitForTimeout(1500)
}

// Geeft { rijen, leegBevestigd }. leegBevestigd = PostNL zegt zelf dat de lijst
// leeg is: overview-grid gevonden, eigen riteigenaar links geselecteerd (Mendix-
// klasse 'selected') en de teller van die grid "0 tot 0 van 0" — twee keer, 2 s
// na elkaar. PostNL haalt afgemelde ritten uit de Ritmonitor, dus 's avonds is de
// lijst echt leeg (sessievideo 19-10 21:00 Waddinxveen, floatops/matransport#357).
// 0 rijen zonder die bevestiging = niet uitgelezen.
async function leesRitmonitor(page) {
  const eerste = await leesRitmonitorEenmaal(page)
  if (eerste.rijen.length > 0 || !eerste.leegVolgensTeller) return { rijen: eerste.rijen, leegBevestigd: false }
  await page.waitForTimeout(2000)
  const tweede = await leesRitmonitorEenmaal(page)
  return { rijen: tweede.rijen, leegBevestigd: tweede.rijen.length === 0 && tweede.leegVolgensTeller }
}

async function leesRitmonitorEenmaal(page) {
  const result = await page.evaluate(() => {
    function cel(row, cls) {
      return row.querySelector(`td.${cls}`)?.getAttribute('title')?.trim() || ''
    }
    // De overview-grid is de tabel met kolomkop "Stops te doen" (column16).
    // Zo onderscheiden we 'm van de Riteigenaar-grid (column5) links.
    const tables = Array.from(document.querySelectorAll('.mx-grid-content table'))
    const target = tables.find(t => t.querySelector('th[title="Stops te doen"]'))
    if (!target) return { rows: [], leegVolgensTeller: false, debug: 'Ritmonitor overview-grid niet gevonden' }

    // Teller van de overview-grid zelf ("0 tot 0 van 0"), niet die van de
    // Riteigenaar-grid links (die heeft z'n eigen "1 tot 1 van 1").
    const gridWidget = target.closest('.mx-grid')
    const teller = gridWidget?.textContent.replace(/\s+/g, ' ').match(/(\d+)\s*tot\s*(\d+)\s*van\s*(\d+)/)
    const totaalVolgensTeller = teller ? Number(teller[3]) : null
    const eigenaarTabel = tables.find(t => t !== target && /riteigenaar/i.test(t.closest('.mx-grid')?.textContent || ''))
    const eigenaarGeselecteerd = !!eigenaarTabel?.querySelector('tbody tr.selected')

    // Brievenbuss kolom dynamisch opzoeken via header-titel — het kolomnummer
    // kan per Mendix-instantie verschillen van de Overview-shift-grid.
    const brievenbussCol = (() => {
      const th = Array.from(target.querySelectorAll('thead th')).find(
        h => /brievenbuss/i.test(h.getAttribute('title') || h.textContent || '')
      )
      return th ? Array.from(th.classList).find(c => c.startsWith('mx-name-column')) : null
    })()

    const trs = Array.from(target.querySelectorAll('tbody tr[data-id]'))
    const mapped = trs.map(row => ({
      kanaal:          cel(row, 'mx-name-column1'),
      ritnaam:         cel(row, 'mx-name-column2'),
      chauffeur:       cel(row, 'mx-name-column3'),
      laatsteActie:    cel(row, 'mx-name-column15'),
      stopsTotaal:     cel(row, 'mx-name-column6'),
      stopsTeDoen:     cel(row, 'mx-name-column16'),
      brievenbusstops: brievenbussCol ? cel(row, brievenbussCol) : '',
    }))
    const f = mapped[0]
    const leegVolgensTeller = totaalVolgensTeller === 0 && eigenaarGeselecteerd
    return { rows: mapped, leegVolgensTeller, debug: `${mapped.length} rijen, teller=${totaalVolgensTeller}, eigenaar=${eigenaarGeselecteerd}, eerste={ritnaam:"${f?.ritnaam}",totaal:"${f?.stopsTotaal}",teDoen:"${f?.stopsTeDoen}",brievenbuss:"${f?.brievenbusstops}",col:"${brievenbussCol}"}` }
  })
  console.log(`[DEBUG ritmonitor] ${result.debug}`)

  const rijen = result.rows
    .filter(r => r.ritnaam && /^\d{3,4}/.test(r.ritnaam) && toNumber(r.stopsTotaal) !== null)
    .map(r => {
      const ritnummer = normaliseerRitnummer(r.ritnaam.match(/^\d+/)?.[0] || '')
      return {
        ritnummer,
        ritnaam:         r.ritnaam,
        chauffeur:       r.chauffeur || null,
        kanaal:          r.kanaal || null,
        laatsteActie:    r.laatsteActie || null,
        stopsTotaal:     toNumber(r.stopsTotaal),
        stopsTeDoen:     toNumber(r.stopsTeDoen),
        brievenbusstops: toNumber(r.brievenbusstops),
        // Ad-ritten (avond, kanaal AD) krijgen geen shiftlabel — er is geen
        // shift_tijden-data voor avondritten, en het eerste ritnummer-cijfer
        // zou anders per ongeluk een echte shift-badge/-tijd suggereren.
        shift:           isAdKanaal(r.kanaal) ? null : (ritnummer.charAt(0) || null),
      }
    })
  return { rijen, leegVolgensTeller: result.leegVolgensTeller }
}

async function opslaanMonitorInSupabase(rijen, datum, depotNaam, leegBevestigd = false) {
  const nu = new Date().toISOString()
  const klantId = KLANT_ID

  const { data: bestaande } = await supabase
    .from('ritten')
    .select('id, ritnummer, status, postnl_stops_totaal, postnl_stops_te_doen, postnl_start_werktijd, postnl_eind_werktijd, postnl_monitor_opgehaald, postnl_laatste_actie')
    .eq('datum', datum).eq('depot', depotNaam)

  // Eerste rij per genormaliseerd ritnummer (dedup zoals de hoofd-sync).
  const bestaandeMap = new Map()
  for (const r of bestaande ?? []) {
    const key = String(parseInt(r.ritnummer, 10))
    if (!bestaandeMap.has(key)) bestaandeMap.set(key, r)
  }

  const teUpdaten = []
  const teInserten = []
  const logRijen = []
  const runContext = {
    klant_id: klantId,
    depot: depotNaam,
    datum,
    rijen_gelezen: rijen.length,
    lege_lijst_bevestigd: leegBevestigd,
    bestaande_ritten: bestaande?.length ?? 0,
  }

  for (const rit of rijen) {
    const existing = bestaandeMap.get(rit.ritnummer)

    // Een 0-meting pas vertrouwen als "klaar" zodra de vóórgaande poll dat ook al liet zien.
    // Bij een net aangemaakte rij toont de Mendix-grid de "stops te doen"-cel soms eenmalig
    // foutief 0 voordat de echte waarde laadt — zonder deze bevestiging wordt de rit dan
    // veel te vroeg als afgerond gemarkeerd (eind_werktijd vlak na start_werktijd).
    const stopsTeDoenBevestigdNul = rit.stopsTeDoen === 0 && existing?.postnl_stops_te_doen === 0

    const velden = {
      postnl_stops_totaal:      rit.stopsTotaal,
      postnl_stops_te_doen:     rit.stopsTeDoen,
      postnl_laatste_actie:     rit.laatsteActie,
      postnl_kanaal:            rit.kanaal,
      postnl_chauffeur:         rit.chauffeur,
      postnl_monitor_opgehaald: nu,
      ...(rit.brievenbusstops !== null && { postnl_briefbusstops: rit.brievenbusstops }),
      // Status op basis van ritmonitor: ritmonitor is leidend zodra stops_te_doen bekend is.
      ...(rit.stopsTeDoen !== null && {
        status: stopsTeDoenBevestigdNul ? 'gereden' : 'bezig',
      }),
      // Zelfherstellend: `shift` wordt alleen bij het aanmaken van een rij gezet
      // (zie teInserten hieronder), nooit meer bij latere updates — een bestaande
      // ad-rit-rij die vóór deze fix is aangemaakt houdt anders voor altijd zijn
      // oude/foute shiftcijfer. Op elke poll opnieuw op null zetten voor ad-ritten
      // corrigeert dat vanzelf voor elke nog actief gepollde rit.
      ...(isAdKanaal(rit.kanaal) && { shift: null }),
    }

    // Starttijd: eerste sync waarbij chauffeur een stop heeft afgeleverd.
    // Reserve-ritten (isReserveRitnummer) hebben geen shift_tijden-begintijd
    // (die tabel kent alleen shift 1-6) — voor hen gebruiken we daarom niet het
    // loutere detectiemoment, maar de eerst gelezen "laatste actie"-tijd zelf.
    // Ad-ritten (isAdKanaal, avond) hebben een vaste begintijd van 17:00 — er
    // is geen shift_tijden-data voor avondritten om op terug te vallen.
    if (
      rit.stopsTeDoen !== null &&
      rit.stopsTotaal !== null &&
      rit.stopsTeDoen < rit.stopsTotaal &&
      !existing?.postnl_start_werktijd
    ) {
      if (isReserveRitnummer(rit.ritnummer)) {
        velden.postnl_start_werktijd = nlTijdstipNaarIso(datum, rit.laatsteActie, new Date(nu).getTime()) || nu
      } else if (isAdKanaal(rit.kanaal)) {
        velden.postnl_start_werktijd = shiftTijdNaarIso(datum, '17:00') || nu
      } else {
        velden.postnl_start_werktijd = nu
      }
    }

    // Eindtijd = het laatste "Tijdstip laatste actie" dat PostNL die dag voor deze rit
    // registreerde (zie nieuweEindtijd). Op elke poll, ongeacht status of "stops te
    // doen" — ook ná 'gereden' loopt hij door zolang de rit in de grid staat. Vanaf de
    // poll waarop de rit start (ook als de starttijd deze poll pas gezet wordt).
    //
    // Zolang status niet 'gereden' is, is dit een voorlopige waarde (chauffeur kan
    // nog bezig zijn); de front-end toont dat onderscheid — zie RITTEN_ARCHITECTUUR.md.
    const eindIso = nieuweEindtijd({
      gestart: Boolean(existing?.postnl_start_werktijd || velden.postnl_start_werktijd),
      huidigeEindIso: existing?.postnl_eind_werktijd ?? null,
      laatsteActieIso: nlTijdstipNaarIso(datum, rit.laatsteActie, new Date(nu).getTime()),
    })
    if (eindIso) velden.postnl_eind_werktijd = eindIso

    // Diagnostisch loggen: wat las de worker + welke beslissing nam hij voor deze rit.
    // Alleen als er iets veranderde t.o.v. de vorige lezing — sinds het herhaald
    // lezen (CONFIG.vensterSec) zou elke identieke herhaling het logboek anders
    // zes keer zo snel laten groeien zonder informatie toe te voegen.
    const actie = !existing ? 'nieuw'
      : stopsTeDoenBevestigdNul ? 'eind-nul'
      : velden.postnl_start_werktijd ? 'start-gezet'
      : velden.postnl_eind_werktijd ? 'eind-bijgewerkt'
      : 'gelezen'
    const veranderd = !existing
      || existing.postnl_stops_totaal !== rit.stopsTotaal
      || existing.postnl_stops_te_doen !== rit.stopsTeDoen
      || (existing.postnl_laatste_actie ?? null) !== (rit.laatsteActie ?? null)
      || (velden.status != null && existing.status !== velden.status)
      || Boolean(velden.postnl_start_werktijd || velden.postnl_eind_werktijd)
    if (veranderd) logRijen.push({
      ...runContext,
      ritnummer:     rit.ritnummer,
      stops_totaal:  rit.stopsTotaal,
      stops_te_doen: rit.stopsTeDoen,
      laatste_actie: rit.laatsteActie,
      actie,
    })

    if (existing) {
      teUpdaten.push({ id: existing.id, velden })
    } else {
      // Rit nog niet via Dagplanning aangemaakt → minimale rij zodat het live toch toont.
      teInserten.push({
        datum,
        status:    'gepland',
        shift:     rit.shift,
        ritnummer: rit.ritnummer,
        depot:     depotNaam,
        klant_id:  klantId,
        postnl_ritnaam: rit.ritnaam,
        ...velden,
      })
    }
  }

  // ── Verdwenen-uit-grid → afronden (veilig, met dubbele-miss-bevestiging) ──
  // PostNL haalt een rit uit de Ritmonitor-grid zodra de chauffeur klaar is.
  // Zo'n rit bereikt "te doen = 0" vaak nooit (onbezorgbare stops blijven staan),
  // dus de nul-detectie hierboven pakt 'm niet — zonder deze pass blijft hij eeuwig
  // op zijn laatste "te doen"-waarde hangen en toont "bezig · N te gaan" terwijl de
  // chauffeur allang klaar is (de bug bij o.a. rit 640).
  //
  // Waarom de oude simpele "verdwenen → gereden" ooit is verwijderd: een half-geladen
  // Mendix-grid liet bezige ritten eenmalig verdwijnen → die werden dan vals afgerond.
  // Daarom eisen we nu dat de rit al MEERDERE polls niet meer gezien is, af te leiden
  // uit de ouderdom van postnl_monitor_opgehaald (die ververst elke keer dat we 'm
  // lezen). Een transient half-geladen grid herstelt de volgende poll → timer reset.
  const AFWEZIG_DREMPEL_MIN = 20   // ≈ 3 gemiste polls bij de 7-min-cron
  const gelezenNummers = new Set(rijen.map(r => r.ritnummer))

  // Alleen als deze scrape rijen opleverde, of PostNL's teller een lege lijst
  // bevestigde (zie leesRitmonitor). Een onbevestigde lege lijst kan een
  // mislukte/half-geladen grid zijn; dan niets afronden.
  if (rijen.length > 0 || leegBevestigd) {
    for (const [key, r] of bestaandeMap) {
      if (gelezenNummers.has(key)) continue                    // nog in de grid
      // 'gereden' is de enige "al afgerond"-check — postnl_eind_werktijd staat
      // inmiddels vrijwel altijd al gevuld (continue update hierboven, zie
      // 2026-08-24), dus die kan niet meer als "al klaar"-signaal dienen.
      if (r.status === 'gereden') continue                     // al afgerond
      if (!r.postnl_start_werktijd) continue                   // nooit begonnen
      if (r.postnl_stops_totaal == null) continue
      // Was hij echt onderweg? (voortgang gemaakt, niet nog volledig "te doen")
      if (!(r.postnl_stops_te_doen != null && r.postnl_stops_te_doen < r.postnl_stops_totaal)) continue
      // Dubbele-miss-bevestiging via ouderdom van de laatste meting.
      const opgehaald = r.postnl_monitor_opgehaald ? new Date(r.postnl_monitor_opgehaald).getTime() : 0
      if ((Date.now() - opgehaald) / 60000 < AFWEZIG_DREMPEL_MIN) continue

      // Eindtijd: de continue update hierboven heeft de laatste registratie al
      // opgeslagen; hier alleen nog aanvullen als dat om wat voor reden niet gebeurd is.
      // Nooit een zelf afgeleide tijd (vroeger: het moment waarop we de rit het laatst
      // zagen, als de registratie "onplausibel" leek) — de eindtijd bepaalt de
      // uitbetaling en is uitsluitend wat PostNL registreerde. Is er geen registratie,
      // dan blijft hij leeg en valt het op in Financiën.
      const eindIso = nieuweEindtijd({
        gestart: true,
        huidigeEindIso: r.postnl_eind_werktijd,
        laatsteActieIso: nlTijdstipNaarIso(datum, r.postnl_laatste_actie, new Date(nu).getTime()),
      })

      teUpdaten.push({ id: r.id, velden: {
        status: 'gereden',
        ...(eindIso && { postnl_eind_werktijd: eindIso }),
        postnl_monitor_opgehaald: nu,
      } })
      logRijen.push({
        ...runContext,
        ritnummer:     key,
        stops_totaal:  r.postnl_stops_totaal,
        stops_te_doen: r.postnl_stops_te_doen,
        laatste_actie: r.postnl_laatste_actie ?? null,
        actie:         'verdwenen-afgerond',
      })
    }
  }

  console.log(`[${depotNaam}] Ritmonitor-run: ${rijen.length} gelezen, ${bestaande?.length ?? 0} bestaand`)

  await Promise.all([
    ...teUpdaten.map(({ id, velden }) => supabase.from('ritten').update(velden).eq('id', id)),
    teInserten.length ? supabase.from('ritten').insert(teInserten) : Promise.resolve(),
    logRijen.length ? supabase.from('ritmonitor_log').insert(logRijen) : Promise.resolve(),
  ])

  console.log(`[${depotNaam}] Ritmonitor ${datum}: bijgewerkt ${teUpdaten.length}, nieuw ${teInserten.length}`)
}

// Sessie-video naar worker-sessies (credentials-shared/src/sessieVideo.js).
// Geslaagde sessie: {depot}-latest.webm, elke run overschreven. Mislukte of na
// fouten vervangen sessie: fout/{depot}-{tijdstip}.webm, 30 dagen bewaard
// (floatops/matransport#360). Pas aanroepen ná context.close().
async function bewaarSessieVideo(video, depotNaam, mislukt = false) {
  if (!mislukt) return bewaarVideo(supabase, video, latestPad(KLANT_ID, 'postnl-ritmonitor', depotNaam), `[${depotNaam}] `)
  const pad = await bewaarVideo(supabase, video, foutPad(KLANT_ID, 'postnl-ritmonitor', depotNaam), `[${depotNaam}] `)
  if (pad) await ruimOudeFoutVideosOp(supabase, KLANT_ID, 'postnl-ritmonitor')
  return pad
}

async function syncMonitorDepot(depot) {
  const vandaag = vandaagNl()
  console.log(`[${depot.naam}] Ritmonitor sync voor ${vandaag}`)

  // Eén PostNL-sessie per login tegelijk (#361): wacht als de dagplanning nu met
  // deze login bezig is. De wachttijd gaat af van het leesvenster, zodat de run
  // niet langer duurt (anders slaat de volgende cron-run over op de flock).
  const wachtStart = Date.now()
  const slot = await pakSessieSlot(supabase, {
    klantId: KLANT_ID, depot: depot.naam, worker: 'postnl-ritmonitor',
    seconden: CONFIG.vensterSec + 180, maxWachtMs: 150_000, label: `[${depot.naam}] `,
  })
  const gewacht = Date.now() - wachtStart

  let browser, context, page, sessie
  try {
    ;({ browser, context, page, sessie } = await openDepotSessie(depot))
  } catch (err) {
    await slot.los()
    throw err
  }
  let rijenAantal = 0
  let lezingen = 0
  let sessieLezingen = 0 // lezingen van de huidige proxy-sessie
  let fout = null
  let laatsteLeegBevestigd = false // laatste geslaagde lezing: lijst bevestigd leeg
  const foutVideoPaths = [] // video's van sessies die na fouten vervangen zijn
  const deadline = Date.now() + CONFIG.vensterSec * 1000 - gewacht

  // Verse browsersessie als opnieuw navigeren niet meer helpt (stale Mendix-
  // sessie, "Execution context destroyed" na een redirect). Zelfde escalatie als
  // `herstelMetNieuweSessie()` in de route-TVI-scraper. Op GitHub Actions blijft het
  // IP binnen één run hetzelfde, dus daar lost dit een IP-blokkade níet op; met de
  // proxy-pool (VPS) krijgt de nieuwe sessie wél een ander IP.
  const vervangSessie = async (reden, uitkomst = 'fout') => {
    console.warn(`[${depot.naam}] [NIEUWE-SESSIE] Browser vervangen (${reden})...`)
    await sluitProxyAf(supabase, sessie, uitkomst, reden)
    const oudeVideo = page.video()
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
    const pad = await bewaarSessieVideo(oudeVideo, depot.naam, true)
    if (pad) foutVideoPaths.push(pad)
    ;({ browser, context, page, sessie } = await openDepotSessie(depot))
    sessieLezingen = 0
    await page.waitForTimeout(1000)
  }

  try {
    await page.waitForTimeout(1000)
    // Herhaald lezen tot het venster om is (zie CONFIG.vensterSec). Elke lezing
    // navigeert opnieuw naar de Ritmonitor via het bewezen pad (openRitmonitor:
    // inclusief OAuth-herlogin) i.p.v. een onbekende ververs-knop in de grid.
    // Een mislukte lezing beëindigt het venster niet meer (zie CONFIG.maxFoutenAchtereen).
    let foutenAchtereen = 0
    for (;;) {
      try {
        await openRitmonitor(page, depot)
        const { rijen, leegBevestigd } = await leesRitmonitor(page)
        laatsteLeegBevestigd = leegBevestigd
        lezingen++
        sessieLezingen++
        foutenAchtereen = 0
        console.log(`[${depot.naam}] Ritmonitor lezing ${lezingen}: ${rijen.length} ritten gelezen${leegBevestigd ? ' (lege lijst bevestigd door PostNL)' : ''}`)
        await opslaanMonitorInSupabase(rijen, vandaag, depot.naam, leegBevestigd)
        rijenAantal = Math.max(rijenAantal, rijen.length)
      } catch (error) {
        foutenAchtereen++
        console.error(`[${depot.naam}] Lezing ${lezingen + 1} mislukt (${foutenAchtereen}/${CONFIG.maxFoutenAchtereen} achter elkaar): ${error.message.split('\n')[0]}`)
        // Geblokkeerd IP (alleen met de pool): niet wachten en opnieuw proberen op
        // hetzelfde IP, maar direct een sessie met het volgende IP.
        if (proxyPoolAan() && await uitkomstBijFout(error, page) === 'blokkade') {
          console.warn(`[${depot.naam}] ⛔ IP-BLOKKERING tijdens lezen — direct naar het volgende IP`)
          try {
            await vervangSessie(`blokkade: ${error.message.split('\n')[0]}`, 'blokkade')
            continue
          } catch (sessieErr) {
            if (lezingen === 0) throw sessieErr
            console.error(`[${depot.naam}] Nieuwe sessie ook mislukt: ${sessieErr.message.split('\n')[0]}`)
            break
          }
        }
        if (foutenAchtereen >= CONFIG.maxFoutenAchtereen) {
          if (lezingen === 0) throw error
          console.error(`[${depot.naam}] Te veel fouten achter elkaar — stop met herhalen (${lezingen} lezing(en) behouden)`)
          break
        }
        // Wacht kort en probeer opnieuw; halverwege de pogingen eerst een verse
        // sessie, want blijven klikken in een kapotte sessie levert niets op.
        const wachtMs = Math.min(CONFIG.foutWachtSec * 1000, deadline - Date.now())
        if (wachtMs <= 0) { if (lezingen === 0) throw error; break }
        await new Promise(r => setTimeout(r, wachtMs))
        if (foutenAchtereen >= Math.ceil(CONFIG.maxFoutenAchtereen / 2)) {
          try {
            await vervangSessie(error.message.split('\n')[0])
          } catch (sessieErr) {
            if (lezingen === 0) throw sessieErr
            console.error(`[${depot.naam}] Nieuwe sessie ook mislukt: ${sessieErr.message.split('\n')[0]}`)
            break
          }
        }
        continue
      }
      if (Date.now() + CONFIG.intervalSec * 1000 > deadline) break
      await page.waitForTimeout(CONFIG.intervalSec * 1000)
    }

    if (depot.storageState) await context.storageState({ path: depot.storageState })
  } catch (error) {
    console.error(`[${depot.naam}] Ritmonitor sync mislukt:`, error)
    fout = error
  }

  // Video pas na context.close() ophalen — Playwright rondt het bestand pas
  // dan af, ervoor kan het nog onvolledig op schijf staan. Is de sessie tussendoor
  // vervangen, dan staat de eerdere al in fout/ (zie vervangSessie).
  // Proxy-gebruik van de laatste sessie afsluiten. Een fout ná minstens één
  // geslaagde lezing telt als 'ok' voor het IP: het portaal was bereikbaar.
  await sluitProxyAf(supabase, sessie,
    fout && sessieLezingen === 0 ? await uitkomstBijFout(fout, page) : 'ok',
    fout?.message ?? `${sessieLezingen} lezing(en)`)

  const video = page.video()
  await context.close().catch(() => {})
  await browser.close().catch(() => {})
  await slot.los()
  // Depot mislukt zonder één geslaagde lezing: deze sessie is de fout, dus archiveren.
  const videoPath = await bewaarSessieVideo(video, depot.naam, !!fout && lezingen === 0)

  if (fout) { fout.videoPath = videoPath; fout.foutVideoPaths = foutVideoPaths; fout.lezingen = lezingen; throw fout }
  return { rijen: rijenAantal, lezingen, videoPath, foutVideoPaths, leegBevestigd: laatsteLeegBevestigd }
}

// Gestructureerd run-niveau-logboek in `worker_run_log` (migration_v150) —
// ontstaan uit een troubleshoot-sessie waarin de PM2-console-logs structureel
// geen ritmonitor-activiteit bleken te tonen (onverklaard, los probleem) en er
// geen enkel run-niveau-overzicht bestond ("draait dit eigenlijk nog?"). Eén
// rij per run: INSERT bij start, UPDATE bij einde. Een gecrashte run die nooit
// de UPDATE haalt blijft zichtbaar als "gestart maar nooit afgerond" — net zo'n
// signaal als een expliciete fout. Best-effort: een logging-fout mag de
// eigenlijke sync nooit blokkeren.
// GitHub Actions zet deze env-vars automatisch (server-url/repo/run-id) — geeft
// een directe link terug naar de Actions-log van deze run, zodat je bij een
// mislukte run niet meer handmatig door `gh run list` hoeft te zoeken naar het
// juiste tijdstip. null buiten GitHub Actions (bv. lokaal testen).
function githubRunUrl() {
  const { GITHUB_SERVER_URL, GITHUB_REPOSITORY, GITHUB_RUN_ID } = process.env
  if (!GITHUB_SERVER_URL || !GITHUB_REPOSITORY || !GITHUB_RUN_ID) return null
  return `${GITHUB_SERVER_URL}/${GITHUB_REPOSITORY}/actions/runs/${GITHUB_RUN_ID}`
}

async function startRunLog() {
  try {
    // supabase-js gooit NIET bij een databasefout maar geeft { error } terug; zonder
    // deze check verdween een mislukte insert (bv. onbekende klant_id) geruisloos en
    // bleef de wachtdog blind voor deze run. Gevonden 2026-09-20 bij de stack-b-proefrun.
    const { data, error } = await supabase.from('worker_run_log')
      .insert({ worker_naam: 'postnl-ritmonitor', klant_id: KLANT_ID, run_url: githubRunUrl() })
      .select('id').single()
    if (error) throw new Error(`${error.code ?? ''} ${error.message}`.trim())
    return data?.id ?? null
  } catch (error) {
    console.error('startRunLog mislukt (sync gaat gewoon door):', error.message)
    return null
  }
}

async function eindeRunLog(runLogId, velden) {
  if (!runLogId) return
  try {
    let { error } = await supabase.from('worker_run_log').update({ afgerond_at: new Date().toISOString(), ...velden }).eq('id', runLogId)
    // Omgeving zonder de kolom leeg_onbevestigd (migratie #357 nog niet
    // gepromoveerd, bv. Stack B): zonder die kolom afsluiten i.p.v. de run op
    // 'gestart' te laten hangen.
    if (error && /leeg_onbevestigd/.test(error.message ?? '')) {
      const { leeg_onbevestigd, ...rest } = velden
      ;({ error } = await supabase.from('worker_run_log').update({ afgerond_at: new Date().toISOString(), ...rest }).eq('id', runLogId))
    }
    if (error) throw new Error(`${error.code ?? ''} ${error.message}`.trim())
  } catch (error) {
    console.error('eindeRunLog mislukt:', error.message)
  }
}

async function syncRitmonitor() {
  const runLogId = await startRunLog()
  const DEPOTS = await getDepots(supabase, KLANT_ID, 'postnl')
  // Met de proxy-pool geen opgeslagen sessie hergebruiken: die cookies horen bij
  // een ander IP, en het bewezen patroon (GitHub Actions) is elke run vers inloggen.
  if (proxyPoolAan()) for (const d of DEPOTS) d.storageState = null
  // Publieke repo: vanaf hier geen depotnamen, logins of URL's meer in de run-log.
  installeerNeutraleConsole({ klantId: KLANT_ID, depots: DEPOTS })
  if (DEPOTS.length === 0) {
    await eindeRunLog(runLogId, { status: 'mislukt', foutmelding: 'Geen depots geconfigureerd' })
    throw new Error('Geen depots geconfigureerd (klant_credentials leeg voor deze klant)')
  }

  // Per-depot isoleren: een transiente time-out bij één depot (trage Mendix-
  // grid / sessie-redirect) mag de hele 10-min-run niet laten falen wanneer de
  // andere depots wél slagen. Alleen falen als ALLE depots faalden.
  //
  // De foutmelding gaat hier bewust ook naar worker_run_log (depot + error.message),
  // niet alleen naar console.error — tijdens een instabiele periode (VPS-crash-loop,
  // zie 12 aug 2026) kan de console-log wegvallen vóórdat 'ie geflushed is, terwijl
  // een DB-write via een losse request altijd aankomt of hard faalt (geen stille
  // dataverlies-situatie zoals bij een gebufferde stdout-stream).
  //
  // Depots draaien tegelijk (elk een eigen browser), niet na elkaar: sinds het
  // herhaald lezen (CONFIG.vensterSec) duurt één depot bijna het hele venster,
  // en na elkaar zou de run de 7-min-cron en de 10-min-timeout overschrijden.
  const mislukt = []
  let rijenTotaal = 0
  const videoPaths = []
  // Lezingen per depot gaan naar worker_run_log.lezingen — de wachtdog
  // check_ritmonitor_eindtijd() (matransport) alarmeert als het er < 3 worden.
  const lezingenPerDepot = {}
  // Depots die deze run 0 ritten gaven zonder bevestigde lege lijst = niet
  // uitgelezen. De wachtdog check_ritmonitor_eindtijd() (matransport, #357)
  // alarmeert als een depot hier 3 runs op rij in staat.
  const leegOnbevestigd = []
  const uitkomsten = await Promise.allSettled(DEPOTS.map(depot => syncMonitorDepot(depot)))
  uitkomsten.forEach((uitkomst, i) => {
    const depot = DEPOTS[i]
    if (uitkomst.status === 'fulfilled') {
      const { rijen, lezingen, videoPath, foutVideoPaths, leegBevestigd } = uitkomst.value
      if (rijen === 0 && !leegBevestigd) leegOnbevestigd.push(depot.naam)
      rijenTotaal += rijen
      lezingenPerDepot[depot.naam] = lezingen
      console.log(`[${depot.naam}] ${lezingen} lezingen in deze run`)
      if (videoPath) videoPaths.push({ depot: depot.naam, storage_path: videoPath })
      for (const p of foutVideoPaths) videoPaths.push({ depot: depot.naam, storage_path: p, soort: 'vervangen_na_fout' })
    } else {
      const error = uitkomst.reason
      mislukt.push({ depot: depot.naam, fout: error.message })
      leegOnbevestigd.push(depot.naam)
      lezingenPerDepot[depot.naam] = error.lezingen ?? 0
      if (error.videoPath) videoPaths.push({ depot: depot.naam, storage_path: error.videoPath })
      for (const p of error.foutVideoPaths ?? []) videoPaths.push({ depot: depot.naam, storage_path: p, soort: 'vervangen_na_fout' })
      console.error(`[${depot.naam}] Ritmonitor mislukt (andere depots gaan door):`, error.message)
    }
  })

  if (mislukt.length === DEPOTS.length) {
    await eindeRunLog(runLogId, {
      status: 'mislukt', depots_ok: 0, depots_mislukt: mislukt, rijen_gelezen: rijenTotaal, lezingen: lezingenPerDepot, leeg_onbevestigd: leegOnbevestigd,
      foutmelding: `Alle depots faalden: ${mislukt.map(m => `${m.depot} (${m.fout})`).join('; ')}`,
      video_paths: videoPaths.length ? videoPaths : null,
    })
    throw new Error(`Ritmonitor: alle depots faalden (${mislukt.map(m => m.depot).join(', ')})`)
  }

  await koppelChauffeurs()
  const depotsOk = DEPOTS.length - mislukt.length
  await eindeRunLog(runLogId, {
    status: mislukt.length ? 'deels_mislukt' : 'ok',
    depots_ok: depotsOk,
    depots_mislukt: mislukt.length ? mislukt : null,
    rijen_gelezen: rijenTotaal,
    lezingen: lezingenPerDepot,
    leeg_onbevestigd: leegOnbevestigd,
    video_paths: videoPaths.length ? videoPaths : null,
  })
  if (mislukt.length) {
    console.warn(`Ritmonitor: gedeeltelijk gesynchroniseerd — overgeslagen: ${mislukt.map(m => m.depot).join(', ')}`)
  } else {
    console.log('Ritmonitor: alle depots gesynchroniseerd')
  }
}

// ---- Entrypoint -------------------------------------------------

const runOnce = process.argv.includes('--once') || process.env.RUN_ONCE === 'true'

if (runOnce) {
  syncRitmonitor().catch(err => { console.error(err); process.exit(1) })
} else {
  // Optionele eigen cron (naast/zonder Supabase pg_cron): zet MONITOR_CRON.
  if (process.env.MONITOR_CRON) {
    cron.schedule(process.env.MONITOR_CRON, () => {
      syncRitmonitor().catch(err => console.error(err))
    }, { timezone: CONFIG.timezone })
  }

  let bezig = false
  const port = Number(process.env.MONITOR_PORT || 3002)
  const workerSecret = process.env.WORKER_SECRET

  http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')

    if (req.method === 'POST' && req.url === '/sync-monitor') {
      if (workerSecret && req.headers['x-worker-secret'] !== workerSecret) {
        res.writeHead(401); res.end(JSON.stringify({ error: 'Ongeldige secret' })); return
      }
      if (bezig) { res.writeHead(409); res.end(JSON.stringify({ error: 'Monitor al bezig' })); return }
      bezig = true
      syncRitmonitor().catch(err => console.error(err)).finally(() => { bezig = false })
      res.writeHead(200); res.end(JSON.stringify({ success: true }))

    } else if (req.method === 'GET' && req.url === '/health') {
      res.writeHead(200); res.end(JSON.stringify({ ok: true, bezig }))

    } else {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Niet gevonden' }))
    }
  }).listen(port, () => {
    console.log(`Ritmonitor-worker actief op poort ${port}. Endpoint: POST /sync-monitor`)
  })
}
