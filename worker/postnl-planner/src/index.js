// postnl-planner — leest de Dagplanning en verplaatst stops in PostNL (floatops/matransport#557).
//
// De app zet een opdracht in planning_taken en start deze worker via de VPS. De worker pakt de
// oudste opdracht van deze klant op en werkt alles af wat er staat. Uitleg: ../POSTNL_PLANNER.md.
//
// Veiligheid: echt verplaatsen gebeurt alleen met PLANNER_ECHT=ja. Zonder die instelling
// selecteert de worker de stops, controleert hij alles en stopt hij vóór de dubbelklik.
import 'dotenv/config'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { getDepots } from '../../credentials-shared/src/index.js'
import { installeerNeutraleConsole } from '../../credentials-shared/src/publiekLog.js'
import { kiesProxy, sluitProxyAf, detecteerBlok, isBlokStatus, uitkomstBijFout, proxyPoolAan, ProxyBlokkadeError } from '../../credentials-shared/src/proxyPool.js'
import { bewaarVideo, latestPad, foutPad, ruimOudeFoutVideosOp } from '../../credentials-shared/src/sessieVideo.js'
import { pakSessieSlot } from '../../credentials-shared/src/sessieSlot.js'
import {
  adresSleutel, deadlineUitTekst, gebruikerBijNaam, isWeigering, ritnummerVan, redenNietUitvoeren, rijenVoorStops, selectieKlopt, stopNaarRij,
} from './logica.js'
import {
  afmelden, kiesChauffeur, kiesDag, kiesShift, klikStopRij, leesChauffeurKeuze, leesDeadlineTekst, leesShifts, leesStopTabel, openRit, sluitDialoog,
  verplaatsNaar, volgMendix,
} from './mendix.js'

const WORKER = 'postnl-planner'
const ECHT = process.env.PLANNER_ECHT === 'ja'
const MAX_BLOKKADES = Number(process.env.PROXY_MAX_BLOKKADES || 3)
const headless = String(process.env.POSTNL_HEADLESS ?? 'true').toLowerCase() !== 'false'

function vereis(naam) {
  const w = process.env[naam]
  if (!w) throw new Error(`Ontbrekende env variabele: ${naam}`)
  return w
}

const supabase = createClient(vereis('SUPABASE_URL'), vereis('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const KLANT_ID = vereis('KLANT_ID')

// supabase-js gooit niet bij een fout: elke schrijfactie hier moet luid falen.
async function db(belofte, wat) {
  const { data, error } = await belofte
  if (error) throw new Error(`${wat}: ${error.message}`)
  return data
}

const zetTaak = (id, velden) => db(supabase.from('planning_taken').update(velden).eq('id', id), 'taak bijwerken')
const zetVerplaatsing = (id, velden) => db(supabase.from('planning_verplaatsingen').update(velden).eq('id', id), 'verplaatsing bijwerken')

function dagLabel(datum) {
  const [j, m, d] = datum.split('-')
  return `${d}-${m}-${j}`
}

async function login(page, depot) {
  try {
    await page.locator('input[type="text"], input[type="email"]').first().waitFor({ timeout: 45_000 })
  } catch (err) {
    const blok = await detecteerBlok(page)
    if (blok.isBlok && proxyPoolAan()) throw new ProxyBlokkadeError(`Loginpagina geblokkeerd: ${blok.title || 'onbekend'}`)
    throw err
  }
  await page.locator('input[type="text"], input[type="email"]').first().fill(depot.username)
  await page.locator('input[type="password"]').first().fill(depot.password)
  await page.locator('button[data-trn-key="login.butlogin"]').click()
  // Niet op de depot-URL wachten: de login-URL bevat die zelf in de redirect-parameter.
  await page.waitForFunction(() => !window.location.hostname.includes('loginpostnl'), { timeout: 90_000 }).catch(() => {})
  await page.waitForLoadState('networkidle', { timeout: 30_000 }).catch(() => {})
  if (page.url().includes('loginpostnl')) throw new Error('Inloggen bij PostNL is mislukt')
}

async function openDagplanning(page, depot) {
  const response = await page.goto(depot.url, { waitUntil: 'networkidle', timeout: 60_000 }).catch(() => null)
  if (isBlokStatus(response) && proxyPoolAan()) throw new ProxyBlokkadeError('HTTP 403 op het portaal')
  if (page.url().includes('loginpostnl') || page.url().includes('/authorize')) await login(page, depot)
  const planning = page.locator('a.mx-name-menuBar1-2, a[title="Planning"]').first()
  await planning.waitFor({ state: 'visible', timeout: 60_000 })
  await planning.click()
  await page.locator('a.mx-name-menuBar1-2-0, a[title="Dagplanning"]').first().click()
  await page.locator('select.form-control').first().waitFor({ state: 'visible', timeout: 30_000 })
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
}

// Alle ritten per shift, met de deadline uit de tekst op de pagina.
async function leesRitten(page, mendix, taak) {
  const uit = []
  for (const shift of await leesShifts(page)) {
    const ritten = await kiesShift(page, mendix, shift)
    const deadline = deadlineUitTekst(await leesDeadlineTekst(page), taak.datum)
    for (const r of ritten) uit.push({ ...r, shift, deadline })
  }
  return uit
}

async function bewaarRitten(taak, ritten) {
  const nu = new Date().toISOString()
  if (ritten.length) {
    await db(supabase.from('planning_ritten').upsert(
      ritten.map(r => ({ ...r, klant_id: KLANT_ID, depot: taak.depot, datum: taak.datum, opgehaald_at: nu })),
      { onConflict: 'klant_id,rit_id' }), 'ritten bewaren')
  }
  await db(supabase.from('planning_ritten').delete()
    .eq('klant_id', KLANT_ID).eq('depot', taak.depot).eq('datum', taak.datum).lt('opgehaald_at', nu), 'oude ritten weghalen')
}

// Leest de stops van alle ritten van één shift. Ritten die in de planning geen stops hebben,
// worden ook niet geopend.
async function leesStopsVanShift(page, mendix, taak, shift, ritten, opVoortgang = async () => {}) {
  await kiesShift(page, mendix, shift)
  const eigen = ritten.filter(r => r.shift === shift)
  const nu = new Date().toISOString()
  let klaar = 0
  for (const rit of eigen) {
    if (rit.stops > 0) {
      const stops = await openRit(page, mendix, rit.ritnaam)
      const eigenStops = stops
      // Per rit wegschrijven: de planner ziet elke rit zodra hij gelezen is.
      if (eigenStops.length) {
        await db(supabase.from('planning_stops').upsert(
          eigenStops.map(s => stopNaarRij(s, { klantId: KLANT_ID, depot: taak.depot, datum: taak.datum, shift, ritId: rit.rit_id, opgehaaldAt: nu })),
          { onConflict: 'klant_id,stop_id' }), 'stops bewaren')
      }
      if (eigenStops.length !== rit.stops) console.log(`${rit.rit_id}: kop ${rit.stops} stops, lijst ${eigenStops.length}`)
      // De deadline kan per rit verschillen; de tekst bij de open rit gaat voor.
      const deadline = deadlineUitTekst(await leesDeadlineTekst(page), taak.datum)
      if (deadline) rit.deadline = deadline
      const keuze = await leesChauffeurKeuze(page)
      rit.chauffeur_wijzigbaar = keuze.wijzigbaar
      rit.chauffeur_opties = keuze.opties
    }
    await opVoortgang(++klaar / Math.max(1, eigen.length))
  }
  // Pas na een complete ronde: bij een fout onderweg blijft de vorige stand staan.
  await db(supabase.from('planning_stops').delete()
    .eq('klant_id', KLANT_ID).eq('depot', taak.depot).eq('datum', taak.datum).eq('shift', shift).lt('opgehaald_at', nu), 'oude stops weghalen')
}

async function voerOphalenUit(page, mendix, taak) {
  await kiesDag(page, mendix, dagLabel(taak.datum))
  const ritten = await leesRitten(page, mendix, taak)
  // De ritten staan meteen in de app; de stops komen er per rit achteraan.
  await bewaarRitten(taak, ritten)
  await zetTaak(taak.id, { voortgang: 10 })
  // Bestaat de gevraagde shift op deze dag niet, dan de eerste die er wel is.
  const shifts = [...new Set(ritten.map(r => r.shift))]
  const shift = shifts.includes(taak.shift) ? taak.shift : shifts[0]
  if (!shift) throw new Error('Op deze dag staan geen ritten in PostNL.')
  await leesStopsVanShift(page, mendix, taak, shift, ritten,
    (deel) => zetTaak(taak.id, { voortgang: Math.min(95, 10 + Math.round(deel * 85)) }))
  await bewaarRitten(taak, ritten)
}

// Selecteert precies deze stops. Blijkt een losse klik de vorige selectie te vervangen, dan
// opnieuw met Ctrl. Klopt het daarna nog niet, dan stopt de verplaatsing. De tabel wordt elke
// keer opnieuw gelezen: PostNL kan tot de deadline adressen toevoegen, en dan schuiven de rijen.
async function selecteer(page, mendix, stops) {
  for (const metCtrl of [false, true]) {
    for (const stop of stops) {
      const { gevonden, problemen } = rijenVoorStops([stop], await leesStopTabel(page))
      if (problemen.length) throw new Error(problemen[0])
      if (!gevonden[0].geselecteerd) await klikStopRij(page, mendix, gevonden[0], { ctrl: metCtrl })
    }
    const tabel = await leesStopTabel(page)
    if (selectieKlopt(tabel, stops)) return true
    // Iets anders staat ook aan, of de selectie is verschoven: alles uitzetten en opnieuw.
    for (const rij of tabel.filter(r => r.geselecteerd)) await klikStopRij(page, mendix, rij, { ctrl: true })
  }
  return false
}

async function verplaatsEen(page, mendix, taak, v, ritten) {
  const bron = ritten.find(r => r.rit_id === v.van_rit_id)
  const doel = ritten.find(r => r.rit_id === v.naar_rit_id)
  if (!bron) return { status: 'overgeslagen', melding: 'De bronrit staat niet meer in de planning.' }

  await kiesShift(page, mendix, bron.shift)
  const stops = await openRit(page, mendix, bron.ritnaam)
  const deadline = deadlineUitTekst(await leesDeadlineTekst(page), taak.datum) ?? bron.deadline
  const reden = redenNietUitvoeren({ doelRit: doel, deadline: doel?.deadline ?? deadline })
    ?? redenNietUitvoeren({ doelRit: bron, deadline })
  if (reden) return { status: 'overgeslagen', melding: reden }

  const gewenst = stops.filter(s => v.stop_ids.includes(s.guid))
  if (gewenst.length !== v.stop_ids.length) {
    return { status: 'overgeslagen', melding: `${v.stop_ids.length - gewenst.length} stop(s) staan niet meer in ${bron.ritnaam}. Haal de planning opnieuw op.` }
  }

  const { problemen } = rijenVoorStops(gewenst, await leesStopTabel(page))
  if (problemen.length) return { status: 'mislukt', melding: problemen.join('; ') }
  if (!await selecteer(page, mendix, gewenst)) {
    return { status: 'mislukt', melding: 'De stops konden niet exact geselecteerd worden. Er is niets verplaatst.' }
  }
  if (!ECHT) {
    return { status: 'overgeslagen', melding: `Proefstand: ${gewenst.length} stop(s) geselecteerd, niet verplaatst naar ${doel.ritnaam}.` }
  }

  const meldingen = await verplaatsNaar(page, mendix, doel.shift, doel.ritnaam)
  const dialoog = await sluitDialoog(page, mendix)
  const weigering = meldingen.find(isWeigering)
  if (weigering) return { status: 'mislukt', melding: weigering.tekst }

  // Controle: staan de adressen nu ook echt in de doelrit? De StopID kan veranderen.
  await kiesShift(page, mendix, doel.shift)
  const inDoel = new Set((await openRit(page, mendix, doel.ritnaam)).map(adresSleutel))
  const missen = gewenst.filter(s => !inDoel.has(adresSleutel(s)))
  if (missen.length) {
    return { status: 'mislukt', melding: `${missen.length} stop(s) staan na de actie niet in ${doel.ritnaam}${dialoog ? ` (PostNL: ${dialoog})` : ''}. Controleer dit in PostNL.` }
  }
  return { status: 'gelukt', melding: null }
}

// Ritten-pagina meteen laten kloppen, niet pas na de volgende sync (om 05:40 zou dat tot 07:00
// duren). Een andere PostNL-naam beëindigt ook een met de hand gekozen chauffeur: dat regelt de
// trigger rit_chauffeur_handmatig (#362). Is de naam aan niemand gekoppeld, dan blijft de
// koppeling staan en toont Ritten de nieuwe PostNL-naam ernaast. Bestaat de rit nog niet, dan
// maakt de eerstvolgende sync hem met deze naam aan.
async function werkRittenBij(taak, ritnaam, naam) {
  const ritnummer = ritnummerVan(ritnaam)
  if (!ritnummer) return
  const gebruikers = await db(supabase.from('users').select('id, postnl_naam')
    .eq('klant_id', KLANT_ID).not('postnl_naam', 'is', null), 'gebruikers lezen')
  const chauffeurId = gebruikerBijNaam(gebruikers, naam)
  await db(supabase.from('ritten')
    .update({ postnl_chauffeur: naam, ...(chauffeurId && { chauffeur_id: chauffeurId }) })
    .eq('klant_id', KLANT_ID).eq('datum', taak.datum).eq('depot', taak.depot).eq('ritnummer', ritnummer), 'rit bijwerken')
}

async function wisselChauffeur(page, mendix, taak, v, ritten) {
  const rit = ritten.find(r => r.rit_id === v.van_rit_id)
  if (!rit) return { status: 'overgeslagen', melding: 'De rit staat niet meer in de planning.' }
  await kiesShift(page, mendix, rit.shift)
  await openRit(page, mendix, rit.ritnaam)
  const keuze = await leesChauffeurKeuze(page)
  if (!keuze.wijzigbaar) return { status: 'overgeslagen', melding: `PostNL staat bij ${rit.ritnaam} geen chauffeurwissel meer toe.` }
  if (!keuze.opties.includes(v.chauffeur)) return { status: 'overgeslagen', melding: `${v.chauffeur} staat niet in de PostNL-lijst.` }
  if (keuze.huidig === v.chauffeur) {
    await werkRittenBij(taak, rit.ritnaam, v.chauffeur)
    return { status: 'gelukt', melding: 'Stond al op deze chauffeur.' }
  }
  if (!ECHT) return { status: 'overgeslagen', melding: `Proefstand: ${rit.ritnaam} is niet gewisseld naar ${v.chauffeur}.` }

  const meldingen = await kiesChauffeur(page, mendix, v.chauffeur)
  const dialoog = await sluitDialoog(page, mendix)
  const weigering = meldingen.find(isWeigering)
  if (weigering) return { status: 'mislukt', melding: weigering.tekst }
  // Controle: opnieuw openen, de keuzelijst alleen zegt niet dat het is opgeslagen.
  await kiesShift(page, mendix, rit.shift)
  await openRit(page, mendix, rit.ritnaam)
  const na = await leesChauffeurKeuze(page)
  if (na.huidig !== v.chauffeur) {
    return { status: 'mislukt', melding: `De chauffeur staat na de actie op ${na.huidig ?? 'niemand'}${dialoog ? ` (PostNL: ${dialoog})` : ''}. Controleer dit in PostNL.` }
  }
  await werkRittenBij(taak, rit.ritnaam, v.chauffeur)
  return { status: 'gelukt', melding: null }
}

async function voerDoorvoerenUit(page, mendix, taak) {
  const lijst = await db(supabase.from('planning_verplaatsingen').select('*')
    .eq('taak_id', taak.id).eq('status', 'wacht').order('created_at'), 'verplaatsingen lezen')
  await kiesDag(page, mendix, dagLabel(taak.datum))
  const ritten = await leesRitten(page, mendix, taak)
  const geraakt = new Set()
  let klaar = 0
  for (const v of lijst) {
    await zetVerplaatsing(v.id, { status: 'bezig' })
    let uitkomst
    try {
      uitkomst = v.soort === 'chauffeur'
        ? await wisselChauffeur(page, mendix, taak, v, ritten)
        : await verplaatsEen(page, mendix, taak, v, ritten)
    } catch (err) {
      console.error('Verplaatsing faalde:', err.message)
      // Onzeker: de dubbelklik kan al gegeven zijn. Daarom niet automatisch opnieuw.
      uitkomst = { status: 'mislukt', melding: 'Technische fout tijdens deze verplaatsing. Controleer deze stops in PostNL.' }
      await sluitDialoog(page, mendix).catch(() => {})
    }
    await zetVerplaatsing(v.id, uitkomst)
    tellingDoorvoer[uitkomst.status] = (tellingDoorvoer[uitkomst.status] ?? 0) + 1
    console.log(`Wijziging ${klaar + 1}/${lijst.length}: ${uitkomst.status}`)
    if (uitkomst.status === 'gelukt') { geraakt.add(v.shift); if (v.naar_shift) geraakt.add(v.naar_shift) }
    await zetTaak(taak.id, { voortgang: Math.round((++klaar / lijst.length) * 85) })
  }
  // De app moet de nieuwe stand zien.
  if (geraakt.size) {
    const nieuw = await leesRitten(page, mendix, taak)
    for (const shift of geraakt) await leesStopsVanShift(page, mendix, taak, shift, nieuw)
    await bewaarRitten(taak, nieuw)
  }
}

async function metSessie(depot, doorvoeren, werk) {
  // Eén sessie per login (matransport#361). Lezen mag bij een bezet slot gewoon wachten en
  // doorgaan; schrijven nooit: een botsing kan een half uitgevoerde verplaatsing geven.
  const slot = await pakSessieSlot(supabase, { klantId: KLANT_ID, depot: depot.naam, worker: WORKER, seconden: 25 * 60, maxWachtMs: 6 * 60_000, label: `[${depot.naam}] ` })
  if (doorvoeren && !slot.gekregen) {
    throw Object.assign(new Error('PostNL is bezet door een andere sessie. Probeer het over een paar minuten opnieuw.'), { nietGestart: true })
  }
  const opties = { headless, args: ['--disable-dev-shm-usage'] }
  const sessie = await kiesProxy(supabase, { worker: WORKER, depot })
  if (sessie) opties.proxy = sessie.proxy
  const browser = await chromium.launch(opties)
  const videoDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sessie-video-'))
  const context = await browser.newContext({
    serviceWorkers: 'block', timezoneId: 'Europe/Amsterdam', viewport: { width: 1440, height: 900 },
    recordVideo: { dir: videoDir, size: { width: 1280, height: 720 } },
  })
  // Plaatjes en lettertypen zijn niet nodig om te lezen of te klikken: scheelt tijd en proxyverkeer.
  await context.route('**/*', (route) => (['image', 'font', 'media'].includes(route.request().resourceType()) ? route.abort() : route.continue()))
  const page = await context.newPage()
  const mendix = volgMendix(page)
  let mislukt = false
  try {
    await openDagplanning(page, depot)
    await werk(page, mendix)
    await sluitProxyAf(supabase, sessie, 'ok', doorvoeren ? 'doorvoeren' : 'ophalen')
  } catch (err) {
    mislukt = true
    await sluitProxyAf(supabase, sessie, await uitkomstBijFout(err, page), err.message)
    throw err
  } finally {
    await afmelden(page)
    const video = page.video()
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
    // Een doorvoer wijzigt PostNL: die video altijd 30 dagen bewaren, ook als alles goed ging.
    const bewaren = mislukt || doorvoeren
    const videoPad = await bewaarVideo(supabase, video,
      bewaren ? foutPad(KLANT_ID, WORKER, depot.naam, new Date(), doorvoeren ? '-doorvoeren' : '') : latestPad(KLANT_ID, WORKER, depot.naam), `[${depot.naam}] `).catch(() => null)
    if (bewaren) await ruimOudeFoutVideosOp(supabase, KLANT_ID, WORKER).catch(() => {})
    await slot.los()
    await fs.rm(videoDir, { recursive: true, force: true }).catch(() => {})
    laatsteVideo = videoPad ? { depot: depot.naam, storage_path: videoPad, ...(mislukt && { soort: 'mislukte_poging' }), ...(doorvoeren && !mislukt && { soort: 'doorvoer' }) } : null
  }
}

let laatsteVideo = null
let tellingDoorvoer = {}

async function verwerk(taak) {
  const doorvoeren = taak.soort === 'doorvoeren'
  // Alleen oppakken wat nog wacht: de edge function kan hem net hebben afgeblazen.
  const opgepakt = await db(supabase.from('planning_taken').update({ status: 'bezig', gestart_at: new Date().toISOString() })
    .eq('id', taak.id).eq('status', 'wacht').select('id'), 'taak oppakken')
  if (!opgepakt.length) return
  const { data: run } = await supabase.from('worker_run_log').insert({ worker_naam: WORKER, klant_id: KLANT_ID }).select('id').single()
  let fout = null
  tellingDoorvoer = {}
  try {
    const depots = await getDepots(supabase, KLANT_ID, 'postnl')
    installeerNeutraleConsole({ klantId: KLANT_ID, depots })
    const depot = depots.find(d => d.naam === taak.depot)
    if (!depot) throw Object.assign(new Error(`Geen PostNL-inlog gevonden voor depot ${taak.depot}.`), { nietGestart: true })
    for (let poging = 1; ; poging++) {
      try {
        await metSessie(depot, doorvoeren, (page, mendix) => (doorvoeren ? voerDoorvoerenUit : voerOphalenUit)(page, mendix, taak))
        break
      } catch (err) {
        if (!(err instanceof ProxyBlokkadeError) || poging >= MAX_BLOKKADES) throw err
        console.warn(`IP geblokkeerd, opnieuw (${poging}/${MAX_BLOKKADES})`)
      }
    }
  } catch (err) {
    fout = err
    console.error('Opdracht mislukt:', err.message)
  }

  if (doorvoeren && fout) {
    // Nog niet aangeraakt: terug naar concept. Stond er één op bezig, dan is dat onzeker.
    await zetVerplaatsingenNaFout(taak.id, fout)
  }
  await zetTaak(taak.id, {
    status: fout ? 'mislukt' : 'klaar', voortgang: fout ? undefined : 100,
    fout: fout ? fout.message.slice(0, 300) : null, afgerond_at: new Date().toISOString(),
  })
  if (run?.id) {
    await supabase.from('worker_run_log').update({
      status: fout ? 'mislukt' : tellingDoorvoer.mislukt ? 'deels_mislukt' : 'ok', afgerond_at: new Date().toISOString(),
      rijen_gelezen: Object.values(tellingDoorvoer).reduce((n, x) => n + x, 0),
      foutmelding: fout ? fout.message.slice(0, 500) : Object.keys(tellingDoorvoer).length ? JSON.stringify(tellingDoorvoer) : null,
      video_paths: laatsteVideo ? [laatsteVideo] : null,
    }).eq('id', run.id)
  }
}

async function zetVerplaatsingenNaFout(taakId, fout) {
  await db(supabase.from('planning_verplaatsingen').update({ status: 'mislukt', melding: 'Onderbroken tijdens deze verplaatsing. Controleer deze stops in PostNL.' })
    .eq('taak_id', taakId).eq('status', 'bezig'), 'onderbroken verplaatsing')
  await db(supabase.from('planning_verplaatsingen').update({ status: 'concept', taak_id: null, melding: fout.message.slice(0, 200) })
    .eq('taak_id', taakId).eq('status', 'wacht'), 'terug naar concept')
}

async function main() {
  const lijst = await db(supabase.from('planning_taken').select('*')
    .eq('klant_id', KLANT_ID).eq('status', 'wacht').order('aangemaakt_at'), 'opdrachten lezen')
  if (!lijst.length) { console.log('Geen openstaande opdracht'); return }
  for (const taak of lijst) await verwerk(taak)
}

main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
