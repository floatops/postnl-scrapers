// Dag en shift kiezen in de Dagplanning, en wachten op de data zelf (floatops/matransport#562).
//
// Waarom niet de wachtfunctie van de planner (volgMendix.wacht): die wacht tot er geen enkele
// /xas/-vraag meer openstaat. Op 02-11 bleef er bij Den Hoorn telkens één openstaan, waardoor elke
// eerste poging na 30 s faalde met "PostNL reageerde niet". Hier wachten we tot het antwoord met
// de gevraagde data binnen is (Shift-objecten na een dag, RideNumber-objecten na een shift).
//
// Ook: de keuzelijst met dagen wordt pas gelezen als hij gevuld is. Op 02-11 werd hij direct na
// het openen gelezen, nog leeg, waarna de dagplanning Waddinxveen 6 uur lang stil oversloeg.
// Een ontbrekende dag is nu een fout (`dagOntbreekt`), nooit een stille overslag.
import { SEL_DAG } from './login.js'
import { objectenOver } from './mendix.js'

export const SEL_SHIFTS = '.mx-name-Shift_Grid_1'

const slaap = (ms) => new Promise(r => setTimeout(r, ms))

// Alle Mendix-antwoorden van een pagina in één lijst (volgorde van binnenkomst).
export function verzamelAntwoorden(page) {
  const antwoorden = []
  page.on('response', (res) => {
    if (res.url().includes('/xas/')) res.json().then(j => antwoorden.push(j)).catch(() => {})
  })
  return antwoorden
}

// Is er sinds `vanaf` een antwoord binnengekomen met dit objecttype?
export function heeftObject(antwoorden, vanaf, objectType) {
  for (let i = vanaf; i < antwoorden.length; i++) {
    const a = antwoorden[i]
    for (const o of [...(a?.objects ?? []), ...(a?.partialObjects ?? []), ...(a?.mxobjects ?? [])]) {
      if (JSON.stringify(o).includes(`"${objectType}"`)) return true
    }
  }
  return false
}

export async function wachtOpObject(antwoorden, vanaf, objectType, ms) {
  const eind = Date.now() + ms
  while (Date.now() < eind) {
    if (heeftObject(antwoorden, vanaf, objectType)) return true
    await slaap(250)
  }
  return false
}

// Wacht tot er `stilMs` geen nieuw antwoord meer binnenkwam (hooguit `ms`). Kijkt naar
// binnengekomen antwoorden, niet naar openstaande vragen (bij Den Hoorn blijft er één openstaan).
export async function wachtTotStil(antwoorden, { stilMs = 2000, ms = 15_000 } = {}) {
  const eind = Date.now() + ms
  let aantal = antwoorden.length
  let sinds = Date.now()
  while (Date.now() < eind) {
    await slaap(250)
    if (antwoorden.length !== aantal) { aantal = antwoorden.length; sinds = Date.now() }
    else if (Date.now() - sinds >= stilMs) return true
  }
  return false
}

// De antwoorden van de gekozen dag. `geopend` = aantal antwoorden vóór het openen van de
// Dagplanning, `vanaf` = wat kiesDag teruggaf. Stond er eerst een andere dag open (rond middernacht
// de volgende dag), dan komen ritten van die dag soms pas ná het wisselen binnen (Den Hoorn 03-11:
// rit 114 van 03-11 in het venster van 02-11). Die ritten waren dan al vóór het wisselen gemeld:
// `negeer` bevat ze, zodat de lezer ze overslaat.
export function dagVenster(antwoorden, { geopend, vanaf }) {
  if (vanaf == null) return { antwoorden: antwoorden.slice(geopend), negeer: new Set() }
  const vooraf = antwoorden.slice(geopend, vanaf)
  return {
    antwoorden: antwoorden.slice(vanaf),
    negeer: new Set([...objectenOver(vooraf, 'OperationalPlanning.Ride').keys(), ...objectenOver(vooraf, 'OperationalPlanning.RideNumber').keys()]),
  }
}

// De dagen in de keuzelijst, pas als die gevuld is (hooguit `ms`).
export async function dagenInKeuzelijst(page, ms = 20_000) {
  await page.waitForFunction((sel) => {
    const el = document.querySelector(sel)
    return el && el.options.length > 0
  }, SEL_DAG, { timeout: ms }).catch(() => {})
  return page.locator(SEL_DAG).first().evaluate(el => [...el.options].map(o => o.label.trim()).filter(Boolean)).catch(() => [])
}

// Kiest de dag (label "DD-MM-JJJJ") en wacht tot de shifts van die dag binnen zijn.
// Geeft { vanaf }: de index in `antwoorden` waar de data van deze dag begint als er opnieuw
// gekozen moest worden, anders null (dan stond de dag al open). Gebruik het met dagVenster.
// Rond middernacht staat de volgende dag al standaard open: eerst die dag laten uitladen, dan pas
// wisselen (03-11 00:10: de aantallen van 03-11 kwamen zo in de ritten van 02-11).
export async function kiesDag(page, label, antwoorden, { ms = 20_000 } = {}) {
  const staatErin = await page.waitForFunction(({ sel, l }) => {
    const el = document.querySelector(sel)
    return el && [...el.options].some(o => o.label.trim() === l)
  }, { sel: SEL_DAG, l: label }, { timeout: ms }).then(() => true, () => false)
  if (!staatErin) throw Object.assign(new Error(`Dag ${label} staat niet in de keuzelijst van PostNL`), { dagOntbreekt: true })
  const keuzelijst = page.locator(SEL_DAG).first()
  const huidig = await keuzelijst.evaluate(el => el.options[el.selectedIndex]?.label.trim()).catch(() => null)
  let vanaf = null
  if (huidig !== label) {
    await wachtTotStil(antwoorden, { ms })
    vanaf = antwoorden.length
    await keuzelijst.selectOption({ label })
    await wachtOpObject(antwoorden, vanaf, 'OperationalPlanning.Shift', ms)
  }
  await page.locator(`${SEL_SHIFTS} tbody tr td`).first().waitFor({ state: 'visible', timeout: ms })
  return { vanaf }
}

// De shifts zoals het scherm ze toont ("01", "03", …), niet een vaste lijst.
export async function shiftsOpScherm(page) {
  return (await page.locator(`${SEL_SHIFTS} tbody tr td`).allInnerTexts())
    .map(t => t.trim()).filter(t => /^\d{1,2}$/.test(t))
}

// Kiest een shift en wacht tot de ritten (RideNumber) binnen zijn. Een al gekozen shift niet
// opnieuw aanklikken (dat zet hem uit): zijn ritten kwamen al binnen met de dag.
// Geeft 'ok', 'al_gekozen' of 'geen_ritten' (geen ritten-antwoord binnen `ms`: een lege shift).
export async function kiesShift(page, shift, antwoorden, { ms = 12_000 } = {}) {
  const tekst = new RegExp(`^\\s*${String(shift).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)
  const rij = page.locator(`${SEL_SHIFTS} tr`).filter({ has: page.locator('td', { hasText: tekst }) }).first()
  await rij.waitFor({ state: 'visible', timeout: ms })
  if (await rij.evaluate(el => el.classList.contains('selected')).catch(() => false)) return 'al_gekozen'
  const vanaf = antwoorden.length
  await rij.click()
  return (await wachtOpObject(antwoorden, vanaf, 'OperationalPlanning.RideNumber', ms)) ? 'ok' : 'geen_ritten'
}
