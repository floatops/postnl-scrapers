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
  kiesProxy, sluitProxyAf, uitkomstBijFout,
  proxyPoolAan, ProxyBlokkadeError,
} from '../../credentials-shared/src/proxyPool.js'
import { bewaarVideo, latestPad, foutPad, ruimOudeFoutVideosOp } from '../../credentials-shared/src/sessieVideo.js'
import { pakSessieSlot, sessiehouderHeeftAlles } from '../../credentials-shared/src/sessieSlot.js'
import { schrijfDagplanning, markeerGereden as markeerRittenGereden, beschikbareKolommen } from '../../credentials-shared/src/postnl/schrijver.js'
import { vandaagNl as vandaagNlGedeeld } from '../../credentials-shared/src/postnl/tekst.js'
import { naarDepot, openDagplanning } from '../../credentials-shared/src/postnl/login.js'
import { dagplanningRitten } from '../../credentials-shared/src/postnl/ritten.js'
import { startRunLog as startRunLogGedeeld, eindeRunLog as eindeRunLogGedeeld } from '../../credentials-shared/src/runLog.js'
import { verzamelAntwoorden, dagenInKeuzelijst, kiesDag, dagVenster, shiftsOpScherm, kiesShift } from '../../credentials-shared/src/postnl/dagplanningScherm.js'
import { zetTijdInLog } from '../../credentials-shared/src/tijdLog.js'

zetTijdInLog()   // datum en tijd op elke logregel (matransport#599)

// Proxy per browsersessie: zie credentials-shared/src/proxyPool.js. Op de VPS
// (PROXY_POOL=true) krijgt elke sessie het volgende IP uit de eigen pool en wordt
// elke blokkade gelogd; op GitHub Actions het oude gedrag (optioneel PROXY_SERVER).
// Hoe vaak een depot een ander IP probeert als het huidige geblokkeerd blijkt.
const MAX_BLOKKADES_PER_DEPOT = Number(process.env.PROXY_MAX_BLOKKADES || 3)

const CONFIG = {
  cronTime: process.env.CRON_TIME || '0 23 * * *',
  timezone: process.env.TZ || 'Europe/Amsterdam',
  headless: String(process.env.POSTNL_HEADLESS ?? 'true').toLowerCase() !== 'false',
  slowMo: Number(process.env.POSTNL_SLOWMO || 0),
  storageState: process.env.POSTNL_STORAGE_STATE || '.postnl-auth-state.json',
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
  return vandaagNlGedeeld(new Date(), CONFIG.timezone)
}

// Converts DD-MM-YYYY label to YYYY-MM-DD
function labelNaarDatum(label) {
  const [dag, maand, jaar] = label.split('-')
  if (!dag || !maand || !jaar) return null
  return `${jaar}-${maand.padStart(2, '0')}-${dag.padStart(2, '0')}`
}

// Lezen gebeurt sinds floatops/matransport#562 uit de Mendix-antwoorden met de gedeelde lezer
// (credentials-shared/src/postnl/ritten.js), net als de sessiehouder; schrijven met de gedeelde
// schrijver (schrijver.js: sleutel ritnummer + kanaal, klantfilter, niets verwijderen). Inloggen
// en de Dagplanning openen met credentials-shared/src/postnl/login.js.

const dagLabel = (datum) => { const [j, m, d] = datum.split('-'); return `${d}-${m}-${j}` }
const eersteRegel = (e) => String(e?.message ?? e).split(/\r?\n/)[0]
let kolommenCache = null

const startRunLog = () => startRunLogGedeeld(supabase, { worker: 'postnl-dagplanning', klantId: KLANT_ID })
const eindeRunLog = (id, velden) => eindeRunLogGedeeld(supabase, id, velden)

// Sessie-video's van deze run, per depot de laatste (een retry overschrijft
// hetzelfde pad). Gaat als video_paths mee in worker_run_log.
const sessieVideos = new Map()
function videoPaths() {
  return sessieVideos.size ? [...sessieVideos.values()] : null
}

// Zelfde als bewaarSessieVideo() in postnl-ritmonitor (credentials-shared/src/
// sessieVideo.js): geslaagde poging = {depot}-latest.webm, mislukte poging =
// fout/{depot}-{tijdstip}.webm, 30 dagen bewaard (floatops/matransport#360).
// Pas aanroepen ná context.close().
async function bewaarSessieVideo(video, depotNaam, mislukt = false) {
  const pad = await bewaarVideo(supabase, video,
    mislukt ? foutPad(KLANT_ID, 'postnl-dagplanning', depotNaam) : latestPad(KLANT_ID, 'postnl-dagplanning', depotNaam),
    `[${depotNaam}] `)
  if (!pad) return null
  sessieVideos.set(pad, { depot: depotNaam, storage_path: pad, ...(mislukt && { soort: 'mislukte_poging' }) })
  if (mislukt) await ruimOudeFoutVideosOp(supabase, KLANT_ID, 'postnl-dagplanning')
  return pad
}

// Eén depot; is het IP geblokkeerd, dan meteen opnieuw met het volgende IP uit de
// pool i.p.v. te wachten op de volgende poging van syncMetRetry.
async function syncDepot(depot, ...args) {
  for (let poging = 1; ; poging++) {
    try {
      return await syncDepotEenmaal(depot, ...args)
    } catch (err) {
      if (!(err instanceof ProxyBlokkadeError) || poging >= MAX_BLOKKADES_PER_DEPOT) throw err
      console.warn(`[${depot.naam}] ⛔ IP geblokkeerd (${err.message}) — opnieuw met het volgende IP (${poging}/${MAX_BLOKKADES_PER_DEPOT})`)
    }
  }
}

async function syncDepotEenmaal(depot, markeerGereden = false, allesDatums = false, syncDatum = null) {
  const vandaag = vandaagNl()
  const logLabel = syncDatum ? `voor ${syncDatum}` : allesDatums ? '(alle datums)' : `voor ${vandaag}`
  console.log(`[${depot.naam}] Start sync ${logLabel}`)

  // Eén PostNL-sessie per login tegelijk (#361): de Ritmonitor houdt deze login
  // ~5 van elke 7 minuten vast; wachten tot hij klaar is. Tegelijk inloggen zette
  // de sessie terug naar de startpagina en gaf stil "0 ritten".
  const slot = await pakSessieSlot(supabase, {
    klantId: KLANT_ID, depot: depot.naam, worker: 'postnl-dagplanning',
    seconden: 180, maxWachtMs: 6 * 60_000, label: `[${depot.naam}] `, wijkVoorSessiehouder: true,
  })
  // De sessiehouder (#562) leest deze login al; bezet door een ander = overslaan, nooit tegelijk.
  if (slot.overgenomen) { console.log(`[${depot.naam}] Sessiehouder actief: niets te doen`); return 0 }
  if (slot.bezet) throw new Error('Sessie-slot bezet door een ander proces: deze poging overgeslagen')
  try {
    return await syncDepotMetSlot(depot, markeerGereden, allesDatums, syncDatum, vandaag)
  } finally {
    await slot.los()
  }
}

async function syncDepotMetSlot(depot, markeerGereden, allesDatums, syncDatum, vandaag) {
  const launchOptions = { headless: CONFIG.headless, slowMo: CONFIG.slowMo, args: ['--disable-dev-shm-usage'] }
  if (process.env.CHROMIUM_EXECUTABLE_PATH) launchOptions.executablePath = process.env.CHROMIUM_EXECUTABLE_PATH
  const sessie = await kiesProxy(supabase, { worker: 'postnl-dagplanning', depot })
  if (sessie) {
    launchOptions.proxy = sessie.proxy
    console.log(`[${depot.naam}] Proxy: ${sessie.label}`)
  }
  let browser
  try {
    browser = await chromium.launch(launchOptions)
  } catch (err) {
    await sluitProxyAf(supabase, sessie, 'fout', err.message)
    throw err
  }

  const contextOptions = {}
  try {
    const fsSync = await import('node:fs')
    if (depot.storageState && fsSync.existsSync(depot.storageState)) contextOptions.storageState = depot.storageState
  } catch {}

  // Video-opname van de sessie, zoals bij postnl-ritmonitor: meekijken met wat
  // de browser zag bij een mislukte login of scrape.
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessie-video-'))
  contextOptions.recordVideo = { dir: videoDir, size: { width: 1280, height: 720 } }

  const context = await browser.newContext(contextOptions)
  const page = await context.newPage()
  let mislukt = false

  // Alle Mendix-antwoorden van deze sessie: daaruit leest de gedeelde lezer de ritten.
  const antwoorden = verzamelAntwoorden(page)

  try {
    await naarDepot(page, depot)
    console.log(`[${depot.naam}] Ingelogd, URL:`, page.url())
    await openDagplanning(page, depot)
    kolommenCache ??= await beschikbareKolommen(supabase)

    let teSyncen
    if (syncDatum) {
      teSyncen = [{ datum: syncDatum, label: dagLabel(syncDatum) }]
      console.log(`[${depot.naam}] Specifieke datum: ${syncDatum}`)
    } else if (allesDatums) {
      teSyncen = (await dagenInKeuzelijst(page))
        .map(label => ({ label, datum: labelNaarDatum(label) }))
        .filter(d => d.datum && d.datum <= vandaag)
        .sort((a, b) => a.datum.localeCompare(b.datum))
      console.log(`[${depot.naam}] Te syncen datums: ${teSyncen.map(d => d.label).join(', ')}`)
    } else {
      teSyncen = [{ datum: vandaag, label: dagLabel(vandaag) }]
    }

    let totaalGesynced = 0
    for (const { datum, label } of teSyncen) {
      // Per dag een schoon venster: alleen antwoorden en ritten van déze dag (dagVenster). Lukt een shift niet, dan de hele dag opnieuw met een nieuw venster:
      // een herladen pagina toont eerst de standaarddag, en die data mag er niet tussen komen.
      let ritten = null
      let shifts = []
      for (let poging = 1; poging <= 2 && !ritten; poging++) {
        const geopend = antwoorden.length
        try {
          await openDagplanning(page, depot)
          // Ontbreekt de dag, dan gooit kiesDag (dagOntbreekt): dat telt als fout, nooit stil overslaan.
          const { vanaf } = await kiesDag(page, label, antwoorden)
          // Shifts zoals PostNL ze vandaag toont, niet een vaste lijst.
          shifts = await shiftsOpScherm(page)
          for (const shift of shifts) {
            const uitkomst = await kiesShift(page, shift, antwoorden)
            if (uitkomst === 'geen_ritten') console.log(`[${depot.naam}] Shift ${shift}: geen ritten ontvangen (lege shift)`)
          }
          const venster = dagVenster(antwoorden, { geopend, vanaf })
          ritten = dagplanningRitten(venster.antwoorden, { negeer: venster.negeer }).filter(r => !r.datum || r.datum === datum)
        } catch (err) {
          if (err.dagOntbreekt || poging >= 2) throw err
          console.log(`[${depot.naam}] ${datum}: opnieuw na fout (${eersteRegel(err)})`)
        }
      }
      console.log(`[${depot.naam}] ${datum}: ${shifts.length} shift(s), ${ritten.length} ritten`)
      const isVerleden = datum < vandaag
      const uit = await schrijfDagplanning(supabase, {
        klantId: KLANT_ID, datum, depot: depot.naam, gelezen: ritten, kolommen: kolommenCache,
        statusNieuw: isVerleden ? 'gereden' : 'gepland',
      })
      // Niet stil: een rit zonder bekend kanaal is niet geschreven (een gok gaf #560).
      if (uit.kanaalOnbekend.length) throw new Error(`Kanaal onbekend voor rit(ten) ${uit.kanaalOnbekend.join(', ')}: niet geschreven`)
      if (uit.tegenstrijdig.length) throw new Error(`Twee verschillende versies van rit(ten) ${uit.tegenstrijdig.join(', ')}: niet geschreven`)
      if (markeerGereden && !isVerleden) {
        await markeerRittenGereden(supabase, { klantId: KLANT_ID, datum, depot: depot.naam })
        console.log(`[${depot.naam}] Ritten van ${datum} op Gereden gezet`)
      }
      console.log(`[${depot.naam}] ${datum}: bijgewerkt ${uit.bijgewerkt}, nieuw ${uit.nieuw}`)
      totaalGesynced += ritten.length
    }

    if (depot.storageState) await context.storageState({ path: depot.storageState })
    console.log(`[${depot.naam}] Sync klaar`)
    await sluitProxyAf(supabase, sessie, 'ok', `${totaalGesynced} ritten`)
    return totaalGesynced
  } catch (error) {
    console.error(`[${depot.naam}] Sync mislukt:`, error)
    mislukt = true
    await sluitProxyAf(supabase, sessie, await uitkomstBijFout(error, page), error.message)
    throw error
  } finally {
    const video = page.video()
    await context.close().catch(() => {})
    await browser.close()
    await bewaarSessieVideo(video, depot.naam, mislukt)
    await fs.rm(videoDir, { recursive: true, force: true }).catch(() => {})
  }
}

// Per depot apart (#562): een fout bij het ene depot laat het andere gewoon doorgaan. Dat kan
// sinds de gedeelde schrijver niets meer verwijdert en een rit veilig opnieuw schrijft
// (sleutel ritnummer + kanaal); tot dan sloeg een fout bij Den Hoorn Waddinxveen over.
// `alleen`: alleen deze depots (de herkansing doet alleen wat faalde).
async function syncPostnlStops(markeerGereden = false, allesDatums = false, syncDatum = null, alleen = null) {
  const alleDepots = await getDepots(supabase, KLANT_ID, 'postnl')
  // Met de proxy-pool geen opgeslagen sessie hergebruiken: die cookies horen bij een ander IP.
  if (proxyPoolAan()) for (const d of alleDepots) d.storageState = null
  if (alleDepots.length === 0) throw new Error('Geen depots geconfigureerd (klant_credentials leeg voor deze klant)')
  // Publieke repo: vanaf hier geen depotnamen, logins of URL's meer in de run-log.
  installeerNeutraleConsole({ klantId: KLANT_ID, depots: alleDepots })
  const depots = alleen ? alleDepots.filter(d => alleen.includes(d.naam)) : alleDepots
  console.log(`Start PostNL sync voor ${depots.map(d => d.naam).join(', ')}`)
  const depotsOk = []
  const mislukt = []
  let ritenTotaal = 0
  for (const depot of depots) {
    try {
      ritenTotaal += (await syncDepot(depot, markeerGereden, allesDatums, syncDatum)) ?? 0
      depotsOk.push(depot.naam)
    } catch (error) {
      console.error(`[${depot.naam}] Mislukt (andere depots gaan door): ${String(error.message).split('\n')[0]}`)
      mislukt.push({ depot: depot.naam, fout: String(error.message).slice(0, 300) })
    }
  }
  return { depotsOk, mislukt, ritenTotaal, depotsTotaal: alleDepots.length }
}

const runOnce = process.argv.includes('--once') || process.env.RUN_ONCE === 'true'
const runAll  = process.argv.includes('--all')  || process.env.RUN_ALL  === 'true'
const runDatum = process.argv.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || process.env.SYNC_DATUM || null

async function syncMetRetry(markeer, allesDatums = false, syncDatum = null, pogingen = 3) {
  // De sessiehouder (#562) heeft elke login: dan is dit vangnet-script niet nodig (geen run-log).
  // Een expliciete datum of --all (handmatig herstel) draait wel, met het slot zoals altijd.
  if (!allesDatums && !syncDatum) {
    const depots = await getDepots(supabase, KLANT_ID, 'postnl')
    if (await sessiehouderHeeftAlles(supabase, KLANT_ID, depots.map(d => d.naam))) {
      console.log('Sessiehouder actief voor alle depots: niets te doen')
      return
    }
  }
  const runLogId = await startRunLog()
  sessieVideos.clear()
  const ok = new Set()
  let teDoen = null
  let laatste = []
  let ritenTotaal = 0
  let totaal = 0
  for (let poging = 1; poging <= pogingen; poging++) {
    let uit
    try {
      uit = await syncPostnlStops(markeer, allesDatums, syncDatum, teDoen)
    } catch (err) {
      // Alleen bij een fout vóór de depots (bv. geen inloggegevens): dan heeft herkansen geen zin.
      await eindeRunLog(runLogId, { status: 'mislukt', foutmelding: err.message, video_paths: videoPaths() })
      console.error(err.message)
      process.exit(1)
    }
    uit.depotsOk.forEach(d => ok.add(d))
    ritenTotaal += uit.ritenTotaal
    totaal = uit.depotsTotaal
    laatste = uit.mislukt
    if (!laatste.length) break
    teDoen = laatste.map(m => m.depot)
    if (poging < pogingen) {
      const wacht = poging * 30000
      console.log(`Poging ${poging}/${pogingen}: ${teDoen.join(', ')} mislukt — opnieuw over ${wacht / 1000}s, alleen die`)
      await new Promise(r => setTimeout(r, wacht))
    }
  }
  const status = !laatste.length ? 'ok' : ok.size ? 'deels_mislukt' : 'mislukt'
  await eindeRunLog(runLogId, {
    status, depots_ok: ok.size, rijen_gelezen: ritenTotaal,
    depots_mislukt: laatste.length ? laatste : null,
    ...(status === 'mislukt' ? { foutmelding: `Alle depots faalden: ${laatste.map(m => `${m.depot} (${m.fout})`).join('; ')}` } : {}),
    video_paths: videoPaths(),
  })
  console.log(status === 'ok' ? 'Alle depots gesynchroniseerd' : `Dagplanning ${status}: ${laatste.map(m => m.depot).join(', ')} niet gelukt (van ${totaal})`)
  // Exit 1 alleen als geen enkel depot lukte, net als de ritmonitor (de proefperiode kijkt hiernaar).
  if (status === 'mislukt') process.exit(1)
}

if (runOnce || runAll || runDatum) {
  const markeer = process.env.MARKEER_GEREDEN === 'true'
  syncMetRetry(markeer, runAll, runDatum)
} else {
  // Cron: elke avond automatisch — zet ritten op Gereden
  cron.schedule(CONFIG.cronTime, () => {
    syncPostnlStops(true).catch(err => console.error(err))
  }, { timezone: CONFIG.timezone })

  // HTTP server: POST /sync, POST /sync-all, POST /optimaliseer-rit
  let bezig = false
  const port = Number(process.env.PORT || 3001)
  const workerSecret = process.env.WORKER_SECRET

  function leesBody(req) {
    return new Promise((resolve) => {
      let body = ''
      req.on('data', chunk => { body += chunk })
      req.on('end', () => {
        try { resolve(JSON.parse(body || '{}')) } catch { resolve({}) }
      })
    })
  }

  http.createServer(async (req, res) => {
    res.setHeader('Content-Type', 'application/json')

    if (req.method === 'POST' && (req.url === '/sync' || req.url === '/sync-all')) {
      if (bezig) { res.writeHead(409); res.end(JSON.stringify({ error: 'Sync al bezig' })); return }
      const allesDatums = req.url === '/sync-all'
      bezig = true
      syncPostnlStops(false, allesDatums).catch(err => console.error(err)).finally(() => { bezig = false })
      res.writeHead(200); res.end(JSON.stringify({ success: true, allesDatums }))

    } else {
      res.writeHead(404); res.end(JSON.stringify({ error: 'Niet gevonden' }))
    }
  }).listen(port, () => {
    console.log(`PostNL worker actief. Cron: ${CONFIG.cronTime}, HTTP: poort ${port}`)
  })
}
