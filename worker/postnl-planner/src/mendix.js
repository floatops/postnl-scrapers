// Bedienen van de Dagplanning van OOM PD Process. Alle schermnamen staan hier bij elkaar;
// uitleg en valkuilen: ../POSTNL_PLANNER.md.
import { stopsUit, rittenUit, uniekeMeldingen } from './logica.js'

export const SCHERM = {
  dag: 'select.form-control',
  shiftsLinks: '.mx-name-Shift_Grid_1',
  rittenLinks: '.mx-name-Rit_Grid',
  shiftsRechts: '.mx-name-Shift_Grid2',
  rittenRechts: '.mx-name-Rit_Grid1',
  postcodesNee: 'div.mx-name-radioButtons1 input[type="radio"][value="false"]',
  stops: '.mx-name-dataGrid21',
  // Mendix heeft meldingen (.mx-dialog) en pop-up-pagina's (.mx-window/.modal-dialog).
  dialoog: '.mx-dialog:visible, .mx-window:visible, .modal-dialog:visible',
  sluitDialoog: '.mx-dialog button.close, .mx-window button.close, .modal-dialog button.close',
  chauffeur: '.mx-name-referenceSelector1 select',
  afmelden: '[data-button-id="l.General.PostNL_MainTopBar.signoutButton1"]',
}

const STIL_MS = 300

// Eén volger per pagina. De sessiehouder houdt een pagina uren open en vraagt bij elke taak een
// volger: een nieuwe per aanroep stapelde listeners op die elk antwoord voor altijd bewaarden, tot
// de heap na een paar uur vol was (exit 134, matransport#573). Daarom ook: antwoorden alleen
// bewaren zolang er een actie loopt.
const volgers = new WeakMap()

// Volgt het verkeer naar /xas/: wanneer is Mendix klaar, en wat stuurde het terug?
export function volgMendix(page) {
  if (!volgers.has(page)) volgers.set(page, maakVolger(page))
  return volgers.get(page)
}

// Een /xas/-verzoek zonder antwoord telt na zo lang niet meer mee. Vangnet: lange acties van
// Mendix zelf tonen de voortgangsbalk, en daar blijft wacht() gewoon op wachten.
export const VERWEESD_MS = 20_000

// Zo lang hooguit wachten op het uitlezen van antwoorden die al binnen zijn. Een antwoord van een
// document dat intussen weg is (PostNL herlaadde de app na een fout 460) geeft in Playwright nooit
// een body: zonder grens bleef Plannen daar 4,5 min op hangen tot de taaklimiet (05-11 09:53,
// matransport#598).
export const LEZEN_MS = 5_000

function maakVolger(page) {
  // Open verzoeken met hun starttijd. Geen teller: een verzoek dat nooit een finished/failed krijgt,
  // hield die teller voor altijd op 1 (matransport#592, zie hieronder).
  const open = new Map()
  let laatsteActiviteit = Date.now()
  let acties = 0
  const antwoorden = []
  const lezen = new Set()
  const isXas = (url) => url.includes('/xas/')

  page.on('request', (req) => { if (isXas(req.url())) { open.set(req, Date.now()); laatsteActiviteit = Date.now() } })
  const klaar = (req) => { if (open.delete(req)) laatsteActiviteit = Date.now() }
  page.on('requestfinished', klaar)
  page.on('requestfailed', klaar)
  page.on('response', (res) => {
    // Nieuw document in het hoofdframe (goto, herladen): verzoeken van het oude document komen
    // nooit meer terug. Mendix stuurt bij het verlaten nog een fetch die in Playwright geen
    // finished én geen failed krijgt; daardoor liep na elk opnieuw openen elke wachtstap af
    // (05-11, matransport#592). Wat vóór het nieuwe document begon, hoort er niet bij.
    if (isHoofdDocument(page, res)) {
      open.clear()
      lezen.clear()   // hun body komt nooit meer (matransport#598)
      return
    }
    if (!isXas(res.url()) || !acties) return
    const taak = res.json().then(j => { if (acties) antwoorden.push(j) }).catch(() => {})
    lezen.add(taak)
    taak.finally(() => lezen.delete(taak))
  })

  const nogOpen = () => {
    const grens = Date.now() - VERWEESD_MS
    let n = 0
    for (const [req, om] of open) {
      if (om < grens) open.delete(req)
      else n++
    }
    return n
  }

  async function wacht(maxMs = 30_000) {
    const start = Date.now()
    for (;;) {
      const stil = nogOpen() === 0 && Date.now() - laatsteActiviteit >= STIL_MS
      const voortgang = await page.locator('.mx-progress, .mx-underlay.mx-progress-underlay').first().isVisible().catch(() => false)
      if (stil && !voortgang) break
      if (Date.now() - start > maxMs) throw new Error('PostNL reageerde niet binnen de wachttijd')
      await page.waitForTimeout(100)
    }
    await leesUit()
  }

  // Wacht op het uitlezen van de binnengekomen antwoorden, maar nooit langer dan LEZEN_MS.
  async function leesUit() {
    if (!lezen.size) return
    let t
    const grens = new Promise(r => { t = setTimeout(r, LEZEN_MS) })
    try { await Promise.race([Promise.allSettled([...lezen]), grens]) } finally { clearTimeout(t) }
  }

  // Voert een handeling uit en geeft alle antwoorden terug die daardoor binnenkwamen.
  async function actie(fn, maxMs) {
    await wacht(maxMs)
    acties++
    try {
      const vanaf = antwoorden.length
      await fn()
      await page.waitForTimeout(STIL_MS)
      await wacht(maxMs)
      return antwoorden.slice(vanaf)
    } finally {
      if (--acties === 0) antwoorden.length = 0
    }
  }

  return { wacht, actie }
}

function isHoofdDocument(page, res) {
  try {
    const req = res.request()
    return req.isNavigationRequest() && req.resourceType() === 'document' && res.frame() === page.mainFrame()
  } catch { return false }
}

const exact = (tekst) => new RegExp(`^\\s*${String(tekst).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`)

function shiftRij(page, grid, shift) {
  return page.locator(`${grid} tr`).filter({ has: page.locator('td', { hasText: exact(shift) }) }).first()
}

function ritRij(page, grid, ritnaam) {
  return page.locator(`${grid} tr`).filter({ has: page.locator('td', { hasText: exact(ritnaam) }) }).first()
}

const isGeselecteerd = (rij) => rij.evaluate(el => el.classList.contains('selected'))

export async function kiesDag(page, mendix, label) {
  const dag = page.locator(SCHERM.dag).first()
  await dag.waitFor({ state: 'visible', timeout: 30_000 })
  // Mendix vult de keuzelijst pas na het tekenen van de pagina: wachten tot de dag erin staat.
  await mendix.wacht()
  const bestaat = await page.waitForFunction(({ sel, l }) => {
    const el = document.querySelector(sel)
    return el && [...el.options].some(o => o.label.trim() === l)
  }, { sel: SCHERM.dag, l: label }, { timeout: 20_000 }).then(() => true, () => false)
  if (!bestaat) throw new Error(`Dag ${label} staat niet in de PostNL-planning.`)
  await mendix.actie(() => dag.selectOption({ label }))
  await page.locator(`${SCHERM.shiftsLinks} tbody tr td`).first().waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  await mendix.wacht()
}

export async function leesShifts(page) {
  return (await page.locator(`${SCHERM.shiftsLinks} tbody tr td`).allInnerTexts())
    .map(t => t.trim()).filter(t => /^\d{1,2}$/.test(t))
}

// Kiest links de shift en geeft de ritten terug. Opnieuw klikken zou hem uitzetten, en dan komt
// er geen lijst binnen: staat hij al aan, dan eerst een andere shift en terug. Is er geen andere
// (één shift op de dag), dan uit en weer aan.
export async function kiesShift(page, mendix, shift) {
  const rij = shiftRij(page, SCHERM.shiftsLinks, shift)
  await rij.waitFor({ state: 'visible', timeout: 15_000 })
  if (await isGeselecteerd(rij)) {
    const andere = (await leesShifts(page)).find(s => s !== shift)
    await mendix.actie(() => (andere ? shiftRij(page, SCHERM.shiftsLinks, andere) : rij).click())
  }
  const antwoorden = await mendix.actie(() => rij.click())
  return rittenUit(antwoorden)
}

export async function leesDeadlineTekst(page) {
  const treffers = page.getByText(/Ritten kunnen tot \d{1,2}:\d{2} uur worden aangepast/)
  const n = await treffers.count()
  for (let i = 0; i < n; i++) {
    if (await treffers.nth(i).isVisible()) return (await treffers.nth(i).innerText()).trim()
  }
  return null
}

// Opent links een rit met Postcodes op Nee en geeft zijn stops terug.
export async function openRit(page, mendix, ritnaam) {
  const rij = ritRij(page, SCHERM.rittenLinks, ritnaam)
  await rij.waitFor({ state: 'visible', timeout: 15_000 })
  const antwoorden = await mendix.actie(() => rij.click())
  const nee = page.locator(SCHERM.postcodesNee).first()
  await nee.waitFor({ state: 'attached', timeout: 15_000 })
  if (!(await nee.isChecked())) {
    antwoorden.push(...await mendix.actie(() => nee.check({ force: true })))
    if (!(await nee.isChecked())) throw new Error(`Postcodes kon bij ${ritnaam} niet op Nee`)
  }
  await page.locator(`${SCHERM.stops} [role="row"]`).first().waitFor({ state: 'attached', timeout: 15_000 }).catch(() => {})
  // PostNL geeft de lijst in stukken: staat er nog een vervolg, dan is hij niet compleet.
  if (antwoorden.some(a => a.hasMoreItems === true && (a.partialObjects ?? []).some(o => o.objectType === 'OperationalPlanning.Stop'))) {
    throw new Error(`De stoplijst van ${ritnaam} is niet compleet opgehaald.`)
  }
  return stopsUit(antwoorden)
}

// De tabel zoals hij op het scherm staat. Kolommen op koptitel: de volgorde is niet vast.
// Een rit met alleen postcodeblokken heeft geen stoptabel: dan een lege lijst, niet wachten.
export async function leesStopTabel(page) {
  const tabel = page.locator(SCHERM.stops).first()
  if (!(await tabel.count())) return []
  return tabel.evaluate((grid) => {
    const koppen = [...grid.querySelectorAll('[role="columnheader"]')].map(k => (k.innerText || '').trim().toLowerCase())
    const kolom = (begin) => koppen.findIndex(k => k.startsWith(begin))
    const k = { tijd: kolom('tvi'), straat: kolom('straat'), nummer: kolom('huisnum'), toevoeging: kolom('toev') }
    const rijen = [...grid.querySelectorAll('.widget-datagrid-grid-body [role="row"]')]
    return rijen.map((rij, index) => {
      const cellen = [...rij.querySelectorAll('[role="gridcell"]')].map(c => (c.innerText || '').trim())
      return {
        index,
        tijd: cellen[k.tijd] ?? '',
        straat: cellen[k.straat] ?? '',
        nummer: cellen[k.nummer] ?? '',
        toevoeging: cellen[k.toevoeging] ?? '',
        straatKolom: k.straat,
        geselecteerd: rij.getAttribute('aria-selected') === 'true',
      }
    })
  })
}

// De chauffeur-keuzelijst bij de open rit. Bij een geautoriseerde rit staat hij op slot, en dan
// staat alleen de huidige chauffeur erin.
export async function leesChauffeurKeuze(page) {
  const keuze = page.locator(SCHERM.chauffeur).first()
  if (!(await keuze.count())) return { wijzigbaar: false, opties: [], huidig: null }
  return keuze.evaluate((el) => {
    const opties = [...el.options].filter(o => o.value && o.label.trim())
    return {
      wijzigbaar: !el.disabled,
      opties: opties.map(o => o.label.trim()),
      huidig: el.options[el.selectedIndex]?.label.trim() || null,
    }
  })
}

// PostNL slaat de keuze meteen op en vraagt dan of de chauffeur ook aan de komende ritten van
// het scenario gekoppeld moet worden (gezien op 02-11). Altijd "alleen vandaag": een wissel uit
// Plannen mag nooit andere dagen raken. Een ander venster dan dit: fout, niets aanklikken.
export const CHAUFFEUR_VRAAG = 'Wijzig chauffeur'
export const ALLEEN_VANDAAG = /alleen voor de rit van vandaag/i

export async function kiesChauffeur(page, mendix, naam) {
  const antwoorden = await mendix.actie(() => page.locator(SCHERM.chauffeur).first().selectOption({ label: naam }), 60_000)
  // Op de knop zelf zoeken: welk soort venster PostNL gebruikt, maakt dan niet uit (02-11: het
  // was geen .mx-dialog, en de vraag bleef open staan).
  const nee = page.getByRole('button', { name: ALLEEN_VANDAAG }).first()
  const gevraagd = await nee.waitFor({ state: 'visible', timeout: 10_000 }).then(() => true, () => false)
  if (gevraagd) {
    antwoorden.push(...await mendix.actie(() => nee.click(), 60_000))
    await nee.waitFor({ state: 'hidden', timeout: 15_000 })
  } else if (await page.getByText(CHAUFFEUR_VRAAG).first().isVisible().catch(() => false)) {
    throw new Error('PostNL stelde een onbekende vraag bij de chauffeurwissel')
  }
  return uniekeMeldingen(antwoorden)
}

export async function klikStopRij(page, mendix, rij, { ctrl = false } = {}) {
  const cel = page.locator(`${SCHERM.stops} [role="gridcell"][data-position="${rij.straatKolom},${rij.index}"]`)
  await cel.scrollIntoViewIfNeeded()
  await mendix.actie(() => cel.click(ctrl ? { modifiers: ['Control'] } : {}))
}

// Dubbelklik op de doelrit rechts: dit start de verplaatsing in PostNL.
export async function verplaatsNaar(page, mendix, doelShift, doelRitnaam) {
  const shift = shiftRij(page, SCHERM.shiftsRechts, doelShift)
  await shift.waitFor({ state: 'visible', timeout: 15_000 })
  if (!(await isGeselecteerd(shift))) await mendix.actie(() => shift.click())
  const rij = ritRij(page, SCHERM.rittenRechts, doelRitnaam)
  await rij.waitFor({ state: 'visible', timeout: 15_000 })
  const antwoorden = await mendix.actie(() => rij.dblclick(), 120_000)
  return uniekeMeldingen(antwoorden)
}

// Wat er in een dialoog staat, en sluiten met het kruisje. Nooit de hoofdknop: dat zou een
// eventuele bevestigingsvraag met ja beantwoorden.
export async function sluitDialoog(page, mendix) {
  const dialoog = page.locator(SCHERM.dialoog).first()
  if (!(await dialoog.isVisible().catch(() => false))) return null
  const tekst = (await dialoog.innerText().catch(() => '')).trim()
  await mendix.actie(() => page.locator(SCHERM.sluitDialoog).first().click()).catch(() => {})
  return tekst
}

// Uitloggen geeft ook eventuele vergrendelingen van deze sessie vrij.
export async function afmelden(page) {
  await page.locator(SCHERM.afmelden).first().click({ timeout: 5_000 }).catch(() => {})
  await page.waitForTimeout(1_500).catch(() => {})
}
