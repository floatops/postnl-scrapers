// postnl-planner — leest de Dagplanning en verplaatst stops in PostNL (floatops/matransport#557).
//
// De app zet een opdracht in planning_taken en start deze worker via de VPS. De worker pakt de
// oudste opdracht van deze klant op en werkt alles af wat er staat. Uitleg: ../POSTNL_PLANNER.md.
//
// Draait de sessiehouder (postnl-sessie, matransport#562), dan voert die de opdracht uit in zijn
// open sessie: hij importeert `verwerk` en geeft zijn eigen pagina mee (optie `metSessie`). Dit
// script is dan alleen het vangnet (sessiehouder niet actief, vóór 05:25, na 23:00, zondag).
//
// Veiligheid: echt verplaatsen gebeurt alleen met PLANNER_ECHT=ja. Zonder die instelling
// selecteert de worker de stops, controleert hij alles en stopt hij vóór de dubbelklik. Alleen
// naar een geautoriseerde doelrit dubbelklikt hij wel: die weigert PostNL zelf.
import 'dotenv/config'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import fs from 'node:fs/promises'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { getDepots } from '../../credentials-shared/src/index.js'
import { installeerNeutraleConsole } from '../../credentials-shared/src/publiekLog.js'
import { kiesProxy, sluitProxyAf, detecteerBlok, isBlokStatus, uitkomstBijFout, proxyPoolAan, ProxyBlokkadeError } from '../../credentials-shared/src/proxyPool.js'
import { bewaarVideo, latestPad, foutPad, ruimOudeFoutVideosOp, depotSlug, nlTijdstempel, BUCKET } from '../../credentials-shared/src/sessieVideo.js'
import { pakSessieSlot } from '../../credentials-shared/src/sessieSlot.js'
import {
  RIT_VELDEN, STOP_VELDEN, adresPaar, kiesGewenst, schoonAdres, schoonPostcode, straatUitRegister, verschil, adresSleutel, deadlineUitTekst, foutVoorPlanner, teOudeTraces, traceAan, gebruikerBijNaam, isWeigering, ritnummerVan, redenNietUitvoeren, rijenVoorStops, shiftReden, shiftsVan, selectieKlopt, stopNaarRij,
} from './logica.js'
import {
  afmelden, kiesChauffeur, kiesDag, kiesShift, klikStopRij, leesChauffeurKeuze, leesDeadlineTekst, leesShifts, leesStopTabel, openRit, sluitDialoog,
  verplaatsNaar, volgMendix,
} from './mendix.js'
import { zetTijdInLog } from '../../credentials-shared/src/tijdLog.js'

zetTijdInLog()   // datum en tijd op elke logregel (matransport#599)

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
// Wat de planner in de balk ziet. Mag een opdracht nooit laten mislukken.
async function zetStap(id, stap, voortgang) {
  if (!id) return   // verversen door de sessiehouder: geen opdracht, geen balk
  const { error } = await supabase.from('planning_taken').update({ stap, ...(voortgang != null && { voortgang: Math.round(voortgang) }) }).eq('id', id)
  if (error) console.warn('stap niet bijgewerkt:', error.message)
}

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
  // Pas na het inloggen: zo komt het wachtwoord nooit in de trace.
  if (traceAan()) await page.context().tracing.start({ screenshots: true, snapshots: true }).catch(() => {})
  // Vlak na het inloggen komt een klik op het menu soms niet aan en blijft PostNL op de
  // startpagina staan (02-11 06:26, op de video). Dan nog eens.
  const planning = page.locator('a.mx-name-menuBar1-2, a[title="Planning"]').first()
  await planning.waitFor({ state: 'visible', timeout: 60_000 })
  for (let poging = 1; ; poging++) {
    await planning.click()
    await page.locator('a.mx-name-menuBar1-2-0, a[title="Dagplanning"]').first().click({ timeout: 10_000 }).catch(() => {})
    const open = await page.locator('select.form-control').first().waitFor({ state: 'visible', timeout: 20_000 }).then(() => true, () => false)
    if (open) break
    if (poging >= 3) throw new Error('Dagplanning ging niet open in PostNL')
    await page.waitForTimeout(2_000)
  }
  await page.waitForLoadState('networkidle', { timeout: 15_000 }).catch(() => {})
}

// Alle ritten per shift, met de deadline uit de tekst op de pagina.
async function leesRitten(page, mendix, taak, { shifts = null } = {}) {
  const uit = []
  for (const shift of (await leesShifts(page)).filter(s => !shifts || shifts.includes(s))) {
    const ritten = await kiesShift(page, mendix, shift)
    const deadline = deadlineUitTekst(await leesDeadlineTekst(page), taak.datum)
    // Log zonder namen of adressen: alleen shift, aantal ritten en de tijd van PostNL.
    console.log(`Shift ${shift}: ${ritten.length} ritten, wijzigen tot ${deadline ? new Date(deadline).toLocaleTimeString('nl-NL', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Amsterdam' }) : 'onbekend'}`)
    for (const r of ritten) uit.push({ ...r, shift, deadline })
  }
  return uit
}

// Wanneer ritten of stops van een shift voor het laatst gecontroleerd zijn (ook als er niets
// veranderde). Mag een opdracht nooit laten mislukken.
async function zetVersheid(taak, shifts, velden) {
  if (!shifts.length) return
  const { error } = await supabase.from('planning_versheid').upsert(
    shifts.map(shift => ({ klant_id: KLANT_ID, depot: taak.depot, datum: taak.datum, shift, ...velden })),
    { onConflict: 'klant_id,depot,datum,shift' })
  if (error) console.warn('versheid niet bijgewerkt:', error.message)
}

// Alleen verschillen schrijven (#562). `inScope`: welke bestaande ritten deze ronde bekeken zijn;
// alleen die kunnen weg (de sessiehouder slaat ritten voorbij hun deadline over).
async function bewaarRitten(taak, ritten, { inScope = () => true } = {}) {
  const nu = new Date().toISOString()
  const bestaand = await db(supabase.from('planning_ritten').select(['rit_id', ...RIT_VELDEN].join(', '))
    .eq('klant_id', KLANT_ID).eq('depot', taak.depot).eq('datum', taak.datum), 'ritten lezen')
  // De chauffeurlijst staat alleen op een open rit. Ritten die deze ronde niet open waren
  // (andere shift, geen stops) houden wat ze hadden.
  const bekend = new Map(bestaand.map(r => [r.rit_id, r]))
  const rijen = ritten.map(r => ({
    ...r,
    // Na de autorisatie kan de deadline-tekst ontbreken: dan de bekende houden.
    deadline: r.deadline ?? bekend.get(r.rit_id)?.deadline ?? null,
    stops_gelezen: r.stops_gelezen ?? bekend.get(r.rit_id)?.stops_gelezen ?? null,
    chauffeur_wijzigbaar: r.chauffeur_wijzigbaar ?? bekend.get(r.rit_id)?.chauffeur_wijzigbaar ?? false,
    chauffeur_opties: r.chauffeur_opties ?? bekend.get(r.rit_id)?.chauffeur_opties ?? [],
    klant_id: KLANT_ID, depot: taak.depot, datum: taak.datum,
  }))
  const v = verschil(bestaand.filter(inScope), rijen, 'rit_id', RIT_VELDEN)
  const schrijf = [...v.nieuw, ...v.gewijzigd].map(r => ({ ...r, opgehaald_at: nu }))
  if (schrijf.length) await db(supabase.from('planning_ritten').upsert(schrijf, { onConflict: 'klant_id,rit_id' }), 'ritten bewaren')
  if (v.weg.length) {
    await db(supabase.from('planning_ritten').delete().eq('klant_id', KLANT_ID).eq('depot', taak.depot).eq('datum', taak.datum).in('rit_id', v.weg), 'oude ritten weghalen')
  }
  await zetVersheid(taak, [...new Set(ritten.map(r => r.shift))], { ritten_om: nu })
  return { nieuw: v.nieuw.length, gewijzigd: v.gewijzigd.length, weg: v.weg.length }
}

// planning_stops.postcode (matransport#587) komt op Stack B pas met de volgende promotie, en deze
// checkout draait voor beide stacks. Zonder die kolom bewaart de worker de stops zoals voorheen.
// Eén keer per proces gevraagd; alleen "kolom bestaat niet" (42703) telt, elke andere fout is luid.
let postcodeKolom = null
async function stopVelden() {
  if (postcodeKolom === null) {
    const { error } = await supabase.from('planning_stops').select('postcode').limit(1)
    if (error && error.code !== '42703') throw new Error(`stops lezen: ${error.message}`)
    postcodeKolom = !error
    if (!postcodeKolom) console.warn('planning_stops.postcode bestaat nog niet op deze stack: stops zonder postcode bewaard')
  }
  return postcodeKolom ? STOP_VELDEN : STOP_VELDEN.filter(v => v !== 'postcode')
}
const zonderPostcode = ({ postcode, ...rij }) => rij

// De officiële straat per adres, uit geocode_cache (matransport#600). Per proces onthouden: de
// planning leest dezelfde adressen elke ronde. Mag een lezing nooit tegenhouden: lukt het niet binnen
// STRATEN_MS, dan blijft de opgeschoonde straat van de afzender staan en is het de volgende keer weer
// aan de beurt.
const STRATEN = new Map()
const STRATEN_MAX = 100_000
const STRATEN_MS = 10_000
// Na één time-out of fout 10 minuten niet meer vragen: anders wacht elke rit opnieuw 10 s, en een
// shift van 30 ritten past dan niet meer in de taaklimiet van plannen (300 s).
const STRATEN_PAUZE_MS = 10 * 60_000
let stratenUitTot = 0
let stratenOvergeslagen = 0
async function haalStraten(paren) {
  for (let i = 0; i < paren.length; i += 100) {
    const stuk = paren.slice(i, i + 100)
    const postcodes = [...new Set(stuk.map(p => p.split('|')[0]))]
    const rijen = []
    for (let van = 0; ; van += 1000) {
      const data = await db(supabase.from('geocode_cache').select('postcode, huisnummer, weergavenaam')
        .in('postcode', postcodes).in('huisnummer', [...new Set(stuk.map(p => p.split('|')[1]))]).eq('gevonden', true).eq('verdacht', false).like('bron', 'postcode+huisnr%')
        .order('id').range(van, van + 999), 'straten lezen')
      rijen.push(...data)
      if (data.length < 1000) break
    }
    const gevonden = straatUitRegister(rijen)
    for (const p of stuk) STRATEN.set(p, gevonden.get(p) ?? null)
  }
}
async function vulStraten(stops) {
  const paren = [...new Set(stops.map(s => adresPaar(schoonPostcode(s.PostalCode), schoonAdres(s).huisnummer)))].filter(p => p && !STRATEN.has(p))
  if (!paren.length) return
  if (Date.now() < stratenUitTot) { stratenOvergeslagen++; return }
  if (stratenOvergeslagen) { console.log(`Officiële straten weer gelezen; ${stratenOvergeslagen} rit(ten) zonder overgeslagen`); stratenOvergeslagen = 0 }
  if (STRATEN.size + paren.length > STRATEN_MAX) STRATEN.clear()
  let timer
  try {
    await Promise.race([haalStraten(paren), new Promise((_, nee) => { timer = setTimeout(() => nee(new Error(`geen antwoord binnen ${STRATEN_MS / 1000} s`)), STRATEN_MS) })])
  } catch (e) {
    stratenUitTot = Date.now() + STRATEN_PAUZE_MS
    console.warn(`Officiële straten niet gelezen (${e.message}): ${STRATEN_PAUZE_MS / 60_000} min niet meer gevraagd, de straat die er al stond blijft`)
  } finally {
    clearTimeout(timer)
  }
}

// Leest de stops van alle ritten van één shift. Ritten die in de planning geen stops hebben,
// worden ook niet geopend.
// Alleen verschillen (#562): per rit de gewijzigde of nieuwe stops, en na een volledige ronde de
// stops die er niet meer zijn. Alleen van de ritten in `ritten`: de sessiehouder geeft geen ritten
// mee die voorbij hun deadline zijn, en die blijven dus onaangeroerd.
// `deel`: alleen een paar ritten van de shift (na een doorvoer, matransport#578); de shift telt dan
// niet als helemaal gecontroleerd (planning_versheid). `stoppen()` true = ophouden vóór de volgende
// rit (er wacht een Plannen-opdracht); wat al gelezen is, blijft gewoon staan.
async function leesStopsVanShift(page, mendix, taak, shift, ritten, opVoortgang = async () => {}, { deel = false, stoppen = () => false, heleShift = false } = {}) {
  const eigen = ritten.filter(r => r.shift === shift)
  // De laatste lezing leest de hele shift, en daarna herstelt niets een lege lezing meer.
  if (heleShift && !eigen.length) throw new Error(`Shift ${shift} gaf geen ritten: lezing niet vertrouwd, niets verwijderd`)
  if (deel && !eigen.length) return { nieuw: 0, gewijzigd: 0, weg: 0, gestopt: false }
  await kiesShift(page, mendix, shift)
  const nu = new Date().toISOString()
  const velden = await stopVelden()
  // In stukken: een antwoord is hooguit 1000 rijen en shift 07 heeft er ruim 2000. Tot #600 telde de
  // rest elke ronde als 'nieuw' (770 onnodige schrijfacties per ronde), en bleven stops die uit een
  // rit verdwenen in de database staan: 'spookstops', waardoor Plannen een hele verplaatsing oversloeg.
  const bestaand = []
  for (let van = 0; ; van += 1000) {
    const stuk = await db(supabase.from('planning_stops').select(['stop_id', ...velden].join(', '))
      .eq('klant_id', KLANT_ID).eq('depot', taak.depot).eq('datum', taak.datum).eq('shift', shift)
      .order('stop_id').range(van, van + 999), 'stops lezen')
    bestaand.push(...stuk)
    if (stuk.length < 1000) break
  }
  const oudeStraat = new Map(bestaand.map(s => [s.stop_id, s.straat]))
  const gelezenRitten = new Set()
  const gezien = []
  const telling = { nieuw: 0, gewijzigd: 0, weg: 0, gestopt: false }
  const nietGelezen = new Set()
  let klaar = 0
  for (const rit of eigen) {
    if (stoppen()) { telling.gestopt = true; break }
    gelezenRitten.add(rit.rit_id)
    if (rit.stops > 0) {
      const stops = await openRit(page, mendix, rit.ritnaam)
      const eigenStops = stops
      // De kop zegt dat er stops zijn en het antwoord is leeg: een mislukte lezing, of een rit met
      // alleen postcodeblokken (die heeft geen stoptabel). Niet gooien, dat stopte de hele ronde
      // (#557), maar ook niets verwijderen: zijn stops blijven zoals ze zijn.
      if (!eigenStops.length) {
        console.warn(`Rit ${rit.ritnaam.slice(0, 4)}: kop ${rit.stops}, antwoord leeg: stops ongemoeid`)
        nietGelezen.add(rit.rit_id)
        gelezenRitten.delete(rit.rit_id)
        rit.stops_gelezen = 0
        await opVoortgang(++klaar / Math.max(1, eigen.length), eigen[klaar]?.ritnaam)
        continue
      }
      await vulStraten(eigenStops)
      const alle = eigenStops.map(s => stopNaarRij(s, { klantId: KLANT_ID, depot: taak.depot, datum: taak.datum, shift, ritId: rit.rit_id, opgehaaldAt: nu, straten: STRATEN }))
      // Kon het register niet gelezen worden, dan de straat die er al stond: anders wisselt hij elke
      // keer tussen officieel en opgeschoond, en schrijft elke ronde alle stops opnieuw. Vóór het
      // weglaten van de postcodekolom: de sleutel heeft de postcode nodig.
      for (const r of alle) {
        // Zonder geldig postcode-huisnummerpaar is er niets op te zoeken: dan geldt de opgeschoonde
        // straat, niet voor altijd de ruwe van vóór de schoonmaak.
        const paar = adresPaar(r.postcode, r.huisnummer)
        if (!paar || STRATEN.has(paar)) continue
        const oud = oudeStraat.get(r.stop_id)
        if (oud) r.straat = oud
      }
      const rijen = alle.map(r => (postcodeKolom ? r : zonderPostcode(r)))
      gezien.push(...rijen)
      // Per rit wegschrijven: de planner ziet elke rit zodra hij gelezen is. Alleen wat anders is.
      const v = verschil(bestaand, rijen, 'stop_id', velden)
      const schrijf = [...v.nieuw, ...v.gewijzigd]
      telling.nieuw += v.nieuw.length
      telling.gewijzigd += v.gewijzigd.length
      if (schrijf.length) {
        await db(supabase.from('planning_stops').upsert(schrijf, { onConflict: 'klant_id,stop_id' }), 'stops bewaren')
      }
      rit.stops_gelezen = eigenStops.length
      const opScherm = (await leesStopTabel(page).catch(() => [])).length
      console.log(`Rit ${rit.ritnaam.slice(0, 4)}: kop ${rit.stops}, antwoord ${eigenStops.length}, scherm ${opScherm}`)
      // De deadline kan per rit verschillen; de tekst bij de open rit gaat voor.
      const deadline = deadlineUitTekst(await leesDeadlineTekst(page), taak.datum)
      if (deadline) rit.deadline = deadline
      const keuze = await leesChauffeurKeuze(page)
      rit.chauffeur_wijzigbaar = keuze.wijzigbaar
      rit.chauffeur_opties = keuze.opties
    } else {
      rit.stops_gelezen = 0
    }
    await opVoortgang(++klaar / Math.max(1, eigen.length), eigen[klaar]?.ritnaam)
  }
  // Pas na een complete ronde: bij een fout onderweg blijft de vorige stand staan. Alleen stops van
  // ritten die deze ronde gelezen zijn (een rit zonder stops telt als gelezen).
  // Na een complete laatste lezing ook de stops van ritten die niet meer bestaan.
  if (heleShift && !telling.gestopt && !gezien.length && nietGelezen.size) throw new Error(`Shift ${shift}: geen enkele rit gaf stops, niets verwijderd`)
  const heel = heleShift && !telling.gestopt
  const weg = verschil(bestaand.filter(s => !nietGelezen.has(s.rit_id) && (heel || gelezenRitten.has(s.rit_id))), gezien, 'stop_id', velden).weg
  for (let i = 0; i < weg.length; i += 200) {
    await db(supabase.from('planning_stops').delete().eq('klant_id', KLANT_ID).in('stop_id', weg.slice(i, i + 200)), 'oude stops weghalen')
  }
  telling.weg = weg.length
  if (!deel && !telling.gestopt) await zetVersheid(taak, [shift], { stops_om: nu })
  return telling
}

async function voerOphalenUit(page, mendix, taak) {
  await zetStap(taak.id, 'Dag kiezen in PostNL', 6)
  await kiesDag(page, mendix, dagLabel(taak.datum))
  await zetStap(taak.id, 'Ritten lezen', 8)
  const ritten = await leesRitten(page, mendix, taak)
  // De ritten staan meteen in de app; de stops komen er per rit achteraan.
  await bewaarRitten(taak, ritten)
  await zetStap(taak.id, `Stops lezen, shift ${taak.shift ?? ''}`.trim(), 10)
  // Bestaat de gevraagde shift op deze dag niet, dan de eerste die er wel is.
  const shifts = [...new Set(ritten.map(r => r.shift))]
  const shift = shifts.includes(taak.shift) ? taak.shift : shifts[0]
  if (!shift) throw new Error('Op deze dag staan geen ritten in PostNL.')
  await leesStopsVanShift(page, mendix, taak, shift, ritten,
    (deel, volgende) => zetStap(taak.id, volgende ? `Stops lezen: ${volgende}` : 'Afronden', Math.min(95, 10 + deel * 85)))
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

async function verplaatsEen(page, mendix, taak, v, ritten, opStap) {
  const bron = ritten.find(r => r.rit_id === v.van_rit_id)
  const doel = ritten.find(r => r.rit_id === v.naar_rit_id)
  if (!bron) return { status: 'overgeslagen', melding: 'De bronrit staat niet meer in de planning.' }
  const andereShift = shiftReden(bron, doel)
  if (andereShift) return { status: 'overgeslagen', melding: andereShift }

  await opStap(`${bron.ritnaam} openen`, 0.1)
  await kiesShift(page, mendix, bron.shift)
  const stops = await openRit(page, mendix, bron.ritnaam)
  const deadline = deadlineUitTekst(await leesDeadlineTekst(page), taak.datum) ?? bron.deadline
  const reden = redenNietUitvoeren({ doelRit: doel, deadline: doel?.deadline ?? deadline })
    ?? redenNietUitvoeren({ doelRit: bron, deadline })
  // Een geautoriseerde doelrit weigert PostNL zelf: die dubbelklik is veilig, en de planner ziet
  // de melding van PostNL. Al het andere wat niet mag, blijft hier hangen.
  const doelWeigertZelf = doel?.geautoriseerd === true
  if (reden && !doelWeigertZelf) return { status: 'overgeslagen', melding: reden }

  const { gewenst, nietMeer } = kiesGewenst(stops, v.stop_ids)
  // Staat een deel er niet meer (al verplaatst, of door PostNL verschoven): de rest gewoon doen, dat
  // wilde de planner. Tot #600 ging dan de hele verplaatsing niet door (06-11: 5 keer 15-31 stops om 1 of 2).
  if (!gewenst.length) {
    return { status: 'overgeslagen', melding: `${v.stop_ids.length} stop(s) staan niet meer in ${bron.ritnaam}. Haal de planning opnieuw op.` }
  }

  const { problemen } = rijenVoorStops(gewenst, await leesStopTabel(page))
  if (problemen.length) return { status: 'mislukt', melding: problemen.join('; ') }
  await opStap(`${gewenst.length} ${gewenst.length === 1 ? 'stop' : 'stops'} selecteren`, 0.3)
  if (!await selecteer(page, mendix, gewenst)) {
    return { status: 'mislukt', melding: 'De stops konden niet exact geselecteerd worden. Er is niets verplaatst.' }
  }
  if (!ECHT && !doelWeigertZelf) {
    return { status: 'overgeslagen', melding: `Proefstand: ${gewenst.length} stop(s) geselecteerd, niet verplaatst naar ${doel.ritnaam}.` }
  }

  await opStap(`Verplaatsen naar ${doel.ritnaam}`, 0.6)
  const meldingen = await verplaatsNaar(page, mendix, doel.shift, doel.ritnaam)
  const dialoog = await sluitDialoog(page, mendix)
  const weigering = meldingen.find(isWeigering)
  if (weigering) return { status: 'mislukt', melding: weigering.tekst }

  await opStap('Controleren', 0.8)
  // Controle: staan de adressen nu ook echt in de doelrit? De StopID kan veranderen.
  await kiesShift(page, mendix, doel.shift)
  const inDoel = new Set((await openRit(page, mendix, doel.ritnaam)).map(adresSleutel))
  const missen = gewenst.filter(s => !inDoel.has(adresSleutel(s)))
  if (missen.length) {
    return { status: 'mislukt', melding: `${missen.length} stop(s) staan na de actie niet in ${doel.ritnaam}${dialoog ? ` (PostNL: ${dialoog})` : ''}. Controleer dit in PostNL.` }
  }
  return { status: 'gelukt', melding: nietMeer ? `${gewenst.length} stop(s) verplaatst; ${nietMeer} stond(en) al niet meer in ${bron.ritnaam}.` : null }
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

async function wisselChauffeur(page, mendix, taak, v, ritten, opStap) {
  const rit = ritten.find(r => r.rit_id === v.van_rit_id)
  if (!rit) return { status: 'overgeslagen', melding: 'De rit staat niet meer in de planning.' }
  await opStap(`Chauffeur van ${rit.ritnaam}`, 0.2)
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

async function voerDoorvoerenUit(page, mendix, taak, gestopt = () => false) {
  const lijst = await db(supabase.from('planning_verplaatsingen').select('*')
    .eq('taak_id', taak.id).eq('status', 'wacht').order('created_at'), 'verplaatsingen lezen')
  await zetStap(taak.id, 'Dag kiezen in PostNL', 6)
  await kiesDag(page, mendix, dagLabel(taak.datum))
  await zetStap(taak.id, 'Ritten lezen', 8)
  // Alleen de shifts van deze wijzigingen (matransport#578): elke shift kiezen kost seconden.
  const ritten = await leesRitten(page, mendix, taak, { shifts: shiftsVan(lijst) })
  const geraakt = new Set()
  const geraakteRitten = new Set()
  let klaar = 0
  for (const v of lijst) {
    // De sessiehouder gaf deze opdracht op (over de taaklimiet, matransport#600). Vóór de volgende
    // wijziging ophouden: wat nog niet is aangeraakt wordt 'overgeslagen' (zetVerplaatsingenNaFout).
    if (gestopt()) throw new Error('De opdracht duurde te lang en is gestopt.')
    await zetVerplaatsing(v.id, { status: 'bezig' })
    const nummer = klaar
    const opStap = (tekst, deel) => zetStap(taak.id, lijst.length > 1 ? `${nummer + 1} van ${lijst.length}: ${tekst}` : tekst, 10 + ((nummer + deel) / lijst.length) * 75)
    let uitkomst
    try {
      uitkomst = v.soort === 'chauffeur'
        ? await wisselChauffeur(page, mendix, taak, v, ritten, opStap)
        : await verplaatsEen(page, mendix, taak, v, ritten, opStap)
    } catch (err) {
      console.error('Verplaatsing faalde:', err.message)
      // Onzeker: de dubbelklik kan al gegeven zijn. Daarom niet automatisch opnieuw.
      uitkomst = { status: 'mislukt', melding: 'Technische fout tijdens deze verplaatsing. Controleer deze stops in PostNL.' }
      await sluitDialoog(page, mendix).catch(() => {})
    }
    await zetVerplaatsing(v.id, uitkomst)
    tellingDoorvoer[uitkomst.status] = (tellingDoorvoer[uitkomst.status] ?? 0) + 1
    console.log(`Wijziging ${klaar + 1}/${lijst.length}: ${uitkomst.status}`)
    if (uitkomst.status === 'gelukt') {
      geraakt.add(v.shift); if (v.naar_shift) geraakt.add(v.naar_shift)
      geraakteRitten.add(v.van_rit_id); if (v.naar_rit_id) geraakteRitten.add(v.naar_rit_id)
    }
    klaar++
  }
  // De app moet de nieuwe stand zien: de ritlijst van de geraakte shifts (totalen, chauffeur) en de
  // stops van alleen de geraakte ritten (matransport#578). Tot dan elke rit van de shift: het
  // grootste deel van de 1–2 min. De rest ververst de sessiehouder vanzelf (taak plannen).
  if (geraakt.size) {
    await zetStap(taak.id, 'Planning bijwerken', 88)
    const nieuw = await leesRitten(page, mendix, taak, { shifts: [...geraakt] })
    const teLezen = nieuw.filter(r => geraakteRitten.has(r.rit_id))
    for (const shift of geraakt) await leesStopsVanShift(page, mendix, taak, shift, teLezen, undefined, { deel: true })
    await bewaarRitten(taak, nieuw, { inScope: r => geraakt.has(r.shift) })
  }
}

async function metSessie(depot, doorvoeren, werk) {
  // Eén sessie per login (matransport#361). Lezen mag bij een bezet slot gewoon wachten en
  // doorgaan; schrijven nooit: een botsing kan een half uitgevoerde verplaatsing geven.
  const slot = await pakSessieSlot(supabase, { klantId: KLANT_ID, depot: depot.naam, worker: WORKER, seconden: 180, maxWachtMs: 6 * 60_000, label: `[${depot.naam}] ` })
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
    const tracePad = traceAan() ? path.join(videoDir, 'trace.zip') : null
    if (tracePad) await context.tracing.stop({ path: tracePad }).catch(() => {})
    const video = page.video()
    await context.close().catch(() => {})
    await browser.close().catch(() => {})
    // Een doorvoer wijzigt PostNL: die video altijd 30 dagen bewaren, ook als alles goed ging.
    const bewaren = mislukt || doorvoeren
    const videoPad = await bewaarVideo(supabase, video,
      bewaren ? foutPad(KLANT_ID, WORKER, depot.naam, new Date(), doorvoeren ? '-doorvoeren' : '') : latestPad(KLANT_ID, WORKER, depot.naam), `[${depot.naam}] `).catch(() => null)
    if (bewaren) await ruimOudeFoutVideosOp(supabase, KLANT_ID, WORKER).catch(() => {})
    laatsteTrace = tracePad ? await bewaarTrace(tracePad, depot.naam, doorvoeren ? 'doorvoeren' : 'ophalen') : null
    await slot.los()
    await fs.rm(videoDir, { recursive: true, force: true }).catch(() => {})
    laatsteVideo = videoPad ? { depot: depot.naam, storage_path: videoPad, ...(mislukt && { soort: 'mislukte_poging' }), ...(doorvoeren && !mislukt && { soort: 'doorvoer' }) } : null
  }
}

let laatsteVideo = null
let laatsteTrace = null

// Best-effort, zoals de video: een trace mag een opdracht nooit laten mislukken. Ruimt de oude op.
async function bewaarTrace(lokaal, depotNaam, soort) {
  try {
    const map = `${KLANT_ID}/${WORKER}/trace`
    const pad = `${map}/${depotSlug(depotNaam)}-${soort}-${nlTijdstempel()}.zip`
    const { error } = await supabase.storage.from(BUCKET).upload(pad, await fs.readFile(lokaal), { contentType: 'application/zip', upsert: true })
    if (error) throw error
    console.log(`[${depotNaam}] Trace opgeslagen: ${pad}`)
    const { data } = await supabase.storage.from(BUCKET).list(map, { limit: 1000 })
    const weg = teOudeTraces((data ?? []).map(o => o.name))
    if (weg.length) await supabase.storage.from(BUCKET).remove(weg.map(n => `${map}/${n}`))
    return { depot: depotNaam, storage_path: pad, soort: 'trace' }
  } catch (err) {
    console.error('Trace-opslag mislukt (gaat gewoon door):', err.message)
    return null
  }
}
let tellingDoorvoer = {}

// Voor de sessiehouder (#562): de Plannen-tab bijwerken in zijn open sessie, alleen voor ritten die
// nog vóór hun deadline zijn (daarna kan er niet meer gepland worden). soort 'ritten': de koppen van
// de gegeven shifts; soort 'stops': ook de stops van die ritten. Geeft het aantal verschillen.
// `stoppen()`: true = tussen twee ritten ophouden, want er wacht een Plannen-opdracht (matransport#578).
// `naDeadline`: ook ritten voorbij hun deadline, voor de laatste lezing na de autorisatie (matransport#600).
export async function verversPlanning(page, mendix, { depot, datum, soort, shifts, nu = new Date(), stoppen = () => false, naDeadline = false }) {
  const taak = { id: null, depot, datum }
  const open = (r) => shifts.includes(r.shift) && (naDeadline || !r.deadline || new Date(r.deadline) > nu)
  await kiesDag(page, mendix, dagLabel(datum))
  const ritten = (await leesRitten(page, mendix, taak, { shifts })).filter(open)
  const uit = { ritten: null, stops: null, gestopt: false }
  if (soort === 'stops') {
    uit.stops = { nieuw: 0, gewijzigd: 0, weg: 0 }
    for (const shift of shifts) {
      const t = await leesStopsVanShift(page, mendix, taak, shift, ritten, undefined, { stoppen, heleShift: naDeadline })
      for (const k of Object.keys(uit.stops)) uit.stops[k] += t[k]
      if (t.gestopt) { uit.gestopt = true; break }
    }
  }
  // Na de stops: dan staan ook de chauffeurkeuze en de deadline per open rit erin.
  uit.ritten = await bewaarRitten(taak, ritten, { inScope: open })
  return uit
}

// `metSessie(depot, doorvoeren, werk)` levert de PostNL-pagina: standaard een eigen browser met
// login, slot en uitloggen; de sessiehouder geeft zijn open sessie. Geeft { fout, telling } terug
// (de opdracht zelf staat dan al op klaar of mislukt in planning_taken).
export async function verwerk(taak, { metSessie: sessie = metSessie, stapStart = 'Inloggen bij PostNL', gestopt = () => false } = {}) {
  const doorvoeren = taak.soort === 'doorvoeren'
  // Alleen oppakken wat nog wacht: de edge function kan hem net hebben afgeblazen.
  const opgepakt = await db(supabase.from('planning_taken').update({ status: 'bezig', gestart_at: new Date().toISOString() })
    .eq('id', taak.id).eq('status', 'wacht').select('id'), 'taak oppakken')
  if (!opgepakt.length) return { fout: null, telling: {}, overgeslagen: true }
  const { data: run } = await supabase.from('worker_run_log').insert({ worker_naam: WORKER, klant_id: KLANT_ID }).select('id').single()
  let fout = null
  tellingDoorvoer = {}
  laatsteVideo = null
  laatsteTrace = null
  try {
    await zetStap(taak.id, stapStart, 3)
    const depots = await getDepots(supabase, KLANT_ID, 'postnl')
    installeerNeutraleConsole({ klantId: KLANT_ID, depots })
    const depot = depots.find(d => d.naam === taak.depot)
    if (!depot) throw Object.assign(new Error(`Geen PostNL-inlog gevonden voor depot ${taak.depot}.`), { nietGestart: true })
    for (let poging = 1; ; poging++) {
      try {
        await sessie(depot, doorvoeren, (page, mendix) => (doorvoeren ? voerDoorvoerenUit(page, mendix, taak, gestopt) : voerOphalenUit(page, mendix, taak)))
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
    // Nog niet aangeraakt: overgeslagen. Stond er één op bezig, dan is dat onzeker.
    await zetVerplaatsingenNaFout(taak.id, fout)
  }
  await zetTaak(taak.id, {
    status: fout ? 'mislukt' : 'klaar', voortgang: fout ? undefined : 100,
    fout: fout ? foutVoorPlanner(fout.message) : null, afgerond_at: new Date().toISOString(),
  })
  if (run?.id) {
    await supabase.from('worker_run_log').update({
      status: fout ? 'mislukt' : tellingDoorvoer.mislukt ? 'deels_mislukt' : 'ok', afgerond_at: new Date().toISOString(),
      rijen_gelezen: Object.values(tellingDoorvoer).reduce((n, x) => n + x, 0),
      foutmelding: fout ? fout.message.slice(0, 500) : Object.keys(tellingDoorvoer).length ? JSON.stringify(tellingDoorvoer) : null,
      video_paths: [laatsteVideo, laatsteTrace].filter(Boolean).length ? [laatsteVideo, laatsteTrace].filter(Boolean) : null,
    }).eq('id', run.id)
  }
  return { fout, telling: tellingDoorvoer, runId: run?.id ?? null }
}

async function zetVerplaatsingenNaFout(taakId, fout) {
  await db(supabase.from('planning_verplaatsingen').update({ status: 'mislukt', melding: 'Onderbroken tijdens deze verplaatsing. Controleer deze stops in PostNL.' })
    .eq('taak_id', taakId).eq('status', 'bezig'), 'onderbroken verplaatsing')
  // De app toont geen concepten uit de database meer: als overgeslagen laten zien, met de reden.
  await db(supabase.from('planning_verplaatsingen').update({ status: 'overgeslagen', melding: `${foutVoorPlanner(fout.message)} Deze wijziging is niet uitgevoerd.` })
    .eq('taak_id', taakId).eq('status', 'wacht'), 'terug naar concept')
}

async function main() {
  const lijst = await db(supabase.from('planning_taken').select('*')
    .eq('klant_id', KLANT_ID).eq('status', 'wacht').order('aangemaakt_at'), 'opdrachten lezen')
  if (!lijst.length) { console.log('Geen openstaande opdracht'); return }
  for (const taak of lijst) await verwerk(taak)
}

// Alleen als script gestart (node src/index.js), niet bij import door de sessiehouder.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(() => process.exit(0)).catch((err) => { console.error(err); process.exit(1) })
}
