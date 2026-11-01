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
  dialoog: 'div.mx-dialog',
  sluitDialoog: 'div.mx-dialog button.close',
  chauffeur: '.mx-name-referenceSelector1 select',
  afmelden: '[data-button-id="l.General.PostNL_MainTopBar.signoutButton1"]',
}

const STIL_MS = 300

// Volgt het verkeer naar /xas/: wanneer is Mendix klaar, en wat stuurde het terug?
export function volgMendix(page) {
  let open = 0
  let laatsteActiviteit = Date.now()
  const antwoorden = []
  const lezen = new Set()
  const isXas = (url) => url.includes('/xas/')

  page.on('request', (req) => { if (isXas(req.url())) { open++; laatsteActiviteit = Date.now() } })
  const klaar = (req) => { if (isXas(req.url())) { open = Math.max(0, open - 1); laatsteActiviteit = Date.now() } }
  page.on('requestfinished', klaar)
  page.on('requestfailed', klaar)
  page.on('response', (res) => {
    if (!isXas(res.url())) return
    const taak = res.json().then(j => antwoorden.push(j)).catch(() => {})
    lezen.add(taak)
    taak.finally(() => lezen.delete(taak))
  })

  async function wacht(maxMs = 30_000) {
    const start = Date.now()
    for (;;) {
      const stil = open === 0 && Date.now() - laatsteActiviteit >= STIL_MS
      const voortgang = await page.locator('.mx-progress, .mx-underlay.mx-progress-underlay').first().isVisible().catch(() => false)
      if (stil && !voortgang) break
      if (Date.now() - start > maxMs) throw new Error('PostNL reageerde niet binnen de wachttijd')
      await page.waitForTimeout(100)
    }
    await Promise.allSettled([...lezen])
  }

  // Voert een handeling uit en geeft alle antwoorden terug die daardoor binnenkwamen.
  async function actie(fn, maxMs) {
    await wacht(maxMs)
    const vanaf = antwoorden.length
    await fn()
    await page.waitForTimeout(STIL_MS)
    await wacht(maxMs)
    return antwoorden.slice(vanaf)
  }

  return { wacht, actie }
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
  const bestaat = await dag.evaluate((el, l) => [...el.options].some(o => o.label.trim() === l), label)
  if (!bestaat) throw new Error(`Dag ${label} staat niet in de PostNL-planning.`)
  await mendix.actie(() => dag.selectOption({ label }))
}

export async function leesShifts(page) {
  return (await page.locator(`${SCHERM.shiftsLinks} tbody tr td`).allInnerTexts())
    .map(t => t.trim()).filter(t => /^\d{1,2}$/.test(t))
}

// Kiest links de shift en geeft de ritten terug. Opnieuw klikken zou hem uitzetten, en dan komt
// er geen lijst binnen: staat hij al aan, dan eerst een andere shift en terug.
export async function kiesShift(page, mendix, shift) {
  const rij = shiftRij(page, SCHERM.shiftsLinks, shift)
  await rij.waitFor({ state: 'visible', timeout: 15_000 })
  if (await isGeselecteerd(rij)) {
    const andere = (await leesShifts(page)).find(s => s !== shift)
    if (andere) await mendix.actie(() => shiftRij(page, SCHERM.shiftsLinks, andere).click())
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
  return stopsUit(antwoorden)
}

// De tabel zoals hij op het scherm staat. Kolommen op koptitel: de volgorde is niet vast.
export async function leesStopTabel(page) {
  return page.locator(SCHERM.stops).first().evaluate((grid) => {
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

export async function kiesChauffeur(page, mendix, naam) {
  const antwoorden = await mendix.actie(() => page.locator(SCHERM.chauffeur).first().selectOption({ label: naam }), 60_000)
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
