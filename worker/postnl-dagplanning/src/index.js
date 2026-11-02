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
import { naarDepot, openDagplanning, SEL_DAG } from '../../credentials-shared/src/postnl/login.js'
import { dagplanningRitten } from '../../credentials-shared/src/postnl/ritten.js'
import { startRunLog as startRunLogGedeeld, eindeRunLog as eindeRunLogGedeeld } from '../../credentials-shared/src/runLog.js'
// Dag en shift kiezen in de Dagplanning: de schermfuncties van de planner, niet nog een kopie.
import { volgMendix, kiesDag, leesShifts, kiesShift } from '../../postnl-planner/src/mendix.js'

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
    seconden: 600, maxWachtMs: 6 * 60_000, label: `[${depot.naam}] `, wijkVoorSessiehouder: true,
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
  const antwoorden = []
  page.on('response', (res) => { if (res.url().includes('/xas/')) res.json().then(j => antwoorden.push(j)).catch(() => {}) })
  const mendix = volgMendix(page)

  try {
    await naarDepot(page, depot)
    console.log(`[${depot.naam}] Ingelogd, URL:`, page.url())
    await openDagplanning(page, depot)
    kolommenCache ??= await beschikbareKolommen(supabase)
    const beschikbaar = await page.locator(SEL_DAG).first().evaluate(el => Array.from(el.options).map(o => o.label.trim()).filter(Boolean)).catch(() => [])

    let teSyncen
    if (syncDatum) {
      teSyncen = [{ datum: syncDatum, label: dagLabel(syncDatum) }]
      console.log(`[${depot.naam}] Specifieke datum: ${syncDatum}`)
    } else if (allesDatums) {
      teSyncen = beschikbaar
        .map(label => ({ label, datum: labelNaarDatum(label) }))
        .filter(d => d.datum && d.datum <= vandaag)
        .sort((a, b) => a.datum.localeCompare(b.datum))
      console.log(`[${depot.naam}] Te syncen datums: ${teSyncen.map(d => d.label).join(', ')}`)
    } else {
      teSyncen = [{ datum: vandaag, label: dagLabel(vandaag) }]
    }

    let totaalGesynced = 0
    for (const { datum, label } of teSyncen) {
      if (!beschikbaar.includes(label)) {
        console.log(`[${depot.naam}] Datum ${label} niet in de keuzelijst, overgeslagen`)
        continue
      }
      const vanaf = antwoorden.length
      await openDagplanning(page, depot)
      await kiesDag(page, mendix, label)
      // Shifts zoals PostNL ze vandaag toont, niet een vaste lijst.
      const shifts = await leesShifts(page)
      const nietUitgelezen = []
      for (const shift of shifts) {
        try {
          await kiesShift(page, mendix, shift)
        } catch (err) {
          console.log(`[${depot.naam}] Shift ${shift}: opnieuw na fout (${eersteRegel(err)})`)
          try {
            await openDagplanning(page, depot)
            await kiesDag(page, mendix, label)
            await kiesShift(page, mendix, shift)
          } catch (err2) {
            console.log(`[${depot.naam}] Shift ${shift}: overgeslagen na fout: ${eersteRegel(err2)}`)
            nietUitgelezen.push(shift)
          }
        }
      }
      await mendix.wacht().catch(() => {})

      // Een shift die niet uitgelezen kon worden maakt de hele poging mislukt: anders meldde de
      // run stil "0 ritten" met status ok (#361). syncMetRetry probeert het opnieuw.
      if (nietUitgelezen.length) throw new Error(`Shift(s) ${nietUitgelezen.join(', ')} niet uitgelezen voor ${datum}`)

      const ritten = dagplanningRitten(antwoorden.slice(vanaf)).filter(r => !r.datum || r.datum === datum)
      console.log(`[${depot.naam}] ${datum}: ${shifts.length} shift(s), ${ritten.length} ritten`)
      const isVerleden = datum < vandaag
      const uit = await schrijfDagplanning(supabase, {
        klantId: KLANT_ID, datum, depot: depot.naam, gelezen: ritten, kolommen: kolommenCache,
        statusNieuw: isVerleden ? 'gereden' : 'gepland',
      })
      // Niet stil: een rit zonder bekend kanaal is niet geschreven (een gok gaf #560).
      if (uit.kanaalOnbekend.length) throw new Error(`Kanaal onbekend voor rit(ten) ${uit.kanaalOnbekend.join(', ')}: niet geschreven`)
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

async function syncPostnlStops(markeerGereden = false, allesDatums = false, syncDatum = null) {
  const actieveDepots = await getDepots(supabase, KLANT_ID, 'postnl')
  // Met de proxy-pool geen opgeslagen sessie hergebruiken: die cookies horen bij
  // een ander IP, en het bewezen patroon (GitHub Actions) is elke run vers inloggen.
  if (proxyPoolAan()) for (const d of actieveDepots) d.storageState = null
  if (actieveDepots.length === 0) throw new Error('Geen depots geconfigureerd (klant_credentials leeg voor deze klant)')
  // Publieke repo: vanaf hier geen depotnamen, logins of URL's meer in de run-log.
  installeerNeutraleConsole({ klantId: KLANT_ID, depots: actieveDepots })
  console.log(`Start PostNL sync voor ${actieveDepots.map(d => d.naam).join(', ')}`)
  const depotsOk = []
  let ritenTotaal = 0
  for (const depot of actieveDepots) {
    try {
      const aantal = await syncDepot(depot, markeerGereden, allesDatums, syncDatum)
      depotsOk.push(depot.naam)
      ritenTotaal += aantal ?? 0
    } catch (error) {
      // Geen per-depot-isolatie (bewust anders dan postnl-ritmonitor) — één
      // mislukte depot laat syncMetRetry de HELE poging opnieuw proberen,
      // want dagplanning's dedup/insert-logica is niet idempotent-veilig
      // genoeg om een halve batch achter te laten en later bij te werken.
      // Wel context aan de error hangen zodat de run-log ziet hoe ver we kwamen.
      error.depotsOk = depotsOk
      error.depotsTotaal = actieveDepots.length
      error.ritenTotaal = ritenTotaal
      error.depotNaam = depot.naam
      throw error
    }
  }
  // Chauffeurs koppelen doet de database (#562), niet meer dit script.
  console.log('Alle depots gesynchroniseerd')
  return { depotsOk, ritenTotaal, depotsTotaal: actieveDepots.length }
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
  for (let poging = 1; poging <= pogingen; poging++) {
    try {
      const { depotsOk, ritenTotaal } = await syncPostnlStops(markeer, allesDatums, syncDatum)
      await eindeRunLog(runLogId, { status: 'ok', depots_ok: depotsOk.length, rijen_gelezen: ritenTotaal, video_paths: videoPaths() })
      return
    } catch (err) {
      console.error(`Poging ${poging}/${pogingen} mislukt:`, err.message)
      if (poging < pogingen) {
        const wacht = poging * 30000
        console.log(`Wacht ${wacht / 1000}s voor volgende poging...`)
        await new Promise(r => setTimeout(r, wacht))
      } else {
        await eindeRunLog(runLogId, {
          status: 'mislukt',
          depots_ok: err.depotsOk?.length ?? 0,
          depots_mislukt: err.depotNaam ? [{ depot: err.depotNaam, fout: err.message }] : null,
          rijen_gelezen: err.ritenTotaal ?? null,
          foutmelding: err.message,
          video_paths: videoPaths(),
        })
        process.exit(1)
      }
    }
  }
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
