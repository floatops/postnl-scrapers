// Bedienen van RVA (Route Volgorde Applicatie, PostNL). Alle schermnamen staan hier bij elkaar;
// uitleg en valkuilen: ../POSTNL_RVA.md.
//
// Knoppen eerst op data-button-id (de paginanaam zit erin, stabieler dan alleen mx-name), anders
// op tekst. Elke handeling loopt via mendix.actie(): wachten tot PostNL klaar is en de antwoorden
// teruggeven. Een venster sluiten we met Annuleren of het kruisje, nooit met de hoofdknop, tenzij
// het de bevestiging is die we zelf bedoelen.
import { WEEKDAGEN, revisiesUit } from './lezen.js'
import { regelSleutel, regelLabel, vindRegel } from './plan.js'

export const RVA_URL = 'https://pnl-rva.p15.cldsvc.net/'

const DAGNAAM = { Ma: 'Maandag', Di: 'Dinsdag', Wo: 'Woensdag', Do: 'Donderdag', Vr: 'Vrijdag', Za: 'Zaterdag' }
export const dagnaam = (d) => DAGNAAM[d] ?? d

const VIEW = 'p.PlanningData.TripWeekday_View_DnDNew'
export const SCHERM = {
  menuRittenoverzicht: '.mx-name-menuBar1-0',
  overzicht: '.mx-name-dataGrid2_2',
  titel: '.mx-name-dataView1 h2.mx-name-text1, h2.mx-name-text1',
  regels: '.mx-name-drag_dropContainer1 table.mx-name-table2',
  volgordeVak: '.mx-name-textBox1 input',
  richting: '.mx-name-badge2',
  schaar: '.mx-name-staticImage2',
  venster: '.modal-dialog',
  vensterKruisje: 'button[aria-label="sluiten"], button.close',
  wijzig: [`[data-button-id="${VIEW}.actionButton6"]`, 'Wijzig'],
  opslaan: [`[data-button-id="${VIEW}.actionButton2"]`, 'Opslaan'],
  annuleer: [`[data-button-id="${VIEW}.actionButton5"]`, 'Annuleer'],
  kopieerWeekdag: [`[data-button-id="${VIEW}.actionButton7"]`, 'Kopieer weekdag'],
  revisies: [`[data-button-id="${VIEW}.actionButton9"]`, 'Revisies'],
  excelExport: [`[data-button-id="${VIEW}.actionButton11"]`, 'Excel export'],
  menuOnderbreking: [`[data-button-id="${VIEW}.actionButton10"]`, 'Nieuwe plaatsgebonden onderbreking'],
  menuKnip: [`[data-button-id="${VIEW}.actionButton19"]`, 'Knips maken'],
  menuSamenvoegen: [`[data-button-id="${VIEW}.actionButton16"]`, 'Knips samenvoegen'],
  knipOpslaan: '[data-button-id="p.PlanningData.SequenceAddress_Cut.SaveButton"]',
  knipAnnuleren: '[data-button-id="p.PlanningData.SequenceAddress_Cut.CancelButton"]',
  samenOpslaan: '[data-button-id="p.PlanningData.SequenceAddress_Merge.SaveButton"]',
  samenAnnuleren: '[data-button-id="p.PlanningData.SequenceAddress_Merge.CancelButton"]',
  samenOmhoog: '.mx-name-actionButton3',
  samenOmlaag: '.mx-name-actionButton4',
  onderbrekingMinuten: '.mx-name-comboBox1',
  onderbrekingOpslaan: '[data-button-id="p.PlanningData.TripBreak_Placebound_NewEdit.actionButton1"]',
  onderbrekingVerwijder: '[data-button-id="p.PlanningData.TripBreak_Placebound_NewEdit.actionButton3"]',
  onderbrekingAnnuleer: '[data-button-id="p.PlanningData.TripBreak_Placebound_NewEdit.actionButton2"]',
  kopieerOpslaan: '[data-button-id="p.PlanningData.TripWeekday_Copy.actionButton1"]',
  kopieerAnnuleer: '[data-button-id="p.PlanningData.TripWeekday_Copy.actionButton2"]',
  kopieerOk: '[data-button-id="p.PlanningData.TripWeekday_CopyNotification.actionButton1"]',
  revisieTerug: '[data-button-id="p.PlanningData.Snapshot_Overview.actionButton2"]',
}

export class RvaFout extends Error {
  constructor(soort, bericht) { super(bericht); this.soort = soort }
}

// Een knop uit SCHERM: [selector, tekst]. De selector gaat voor, de tekst is het vangnet.
function knop(scope, [selector, tekst]) {
  return scope.locator(selector).or(scope.getByRole('button', { name: tekst, exact: true })).first()
}
const zichtbaar = (loc) => loc.isVisible().catch(() => false)

// Eerst naar het midden van het scherm scrollen. Playwright scrolt een element net in beeld, en
// in een lange lijst valt het dan onder de vaste kopbalk van RVA: de klik komt niet aan (proef 03-11).
async function inBeeld(loc) {
  await loc.waitFor({ state: 'attached', timeout: 15_000 })
  await loc.evaluate(el => el.scrollIntoView({ block: 'center', inline: 'center' }))
  return loc
}

function venster(page, kop) {
  const v = page.locator(SCHERM.venster).filter({ visible: true })
  return kop ? v.filter({ hasText: kop }).last() : v.last()
}

async function wachtOpVenster(page, kop, ms = 15_000) {
  const v = venster(page, kop)
  await v.waitFor({ state: 'visible', timeout: ms }).catch(() => { throw new RvaFout('scherm', `Venster "${kop}" ging niet open`) })
  return v
}

// Sluit wat er open staat met het kruisje en geeft de tekst terug (voor de melding).
export async function sluitVenster(page, mendix) {
  const v = venster(page)
  if (!(await zichtbaar(v))) return null
  const tekst = (await v.innerText().catch(() => '')).trim()
  // Het kruisje van Mendix ligt wel bovenop, maar Playwright noemt het "niet zichtbaar" (Revisies,
  // proef 03-11). Dus geforceerd klikken (zoals een muisklik op die plek); lukt dat niet, Escape.
  await mendix.actie(() => v.locator(SCHERM.vensterKruisje).first().click({ force: true, timeout: 5_000 })).catch(() => {})
  if (await zichtbaar(v)) await mendix.actie(() => page.keyboard.press('Escape')).catch(() => {})
  await v.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => { throw new RvaFout('scherm', 'Venster ging niet dicht') })
  return tekst
}

// ── Navigeren ────────────────────────────────────────────────────────────────

export const isLoginPagina = (url) => /loginpostnl|\/login|\/authorize/.test(String(url ?? ''))

// Naar RVA tot het menu in beeld is. Inloggen doet de aanroeper (`login`), of in de proef de
// eigenaar zelf: dan wachten we tot `maxMs`. Geeft { ingelogd }: of er (opnieuw) ingelogd is.
export async function openRva(page, { login = null, maxMs = 90_000 } = {}) {
  if (!page.url().includes('pnl-rva')) await page.goto(RVA_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 }).catch(() => {})
  const tot = Date.now() + maxMs
  let logins = 0
  while (Date.now() < tot) {
    if (isLoginPagina(page.url()) && login) {
      if (logins++ >= 2) throw new RvaFout('login', 'RVA niet bereikbaar na twee keer inloggen')
      await login(page)
      continue
    }
    if (await zichtbaar(page.locator(SCHERM.menuRittenoverzicht).first())) return { ingelogd: logins > 0 }
    await page.waitForTimeout(1_000)
  }
  throw new RvaFout('login', `RVA niet in beeld na ${Math.round(maxMs / 1000)} s (url: ${page.url().split('?')[0]})`)
}

// De naam van het ingelogde account (rechtsboven).
export async function eigenAccount(page) {
  return (await page.locator('.mx-name-pop_upMenu1 .mx-name-text1').first().innerText().catch(() => '')).trim() || null
}

// Geeft de Mendix-antwoorden terug: daarin staan de ritten met hun nummer (lezen.rittenUit).
export async function naarRittenoverzicht(page, mendix) {
  const antwoorden = await mendix.actie(() => page.locator(SCHERM.menuRittenoverzicht).first().click())
  await page.locator(`${SCHERM.overzicht} [role="row"] [role="gridcell"]`).first().waitFor({ state: 'visible', timeout: 30_000 })
  await mendix.wacht()
  return antwoorden
}

// Het Rittenoverzicht zoals het in beeld staat: per rij de ritnaam, welke dagen erin staan, welke
// op slot staan (slotje = img in het tooltip-vak) en de verantwoordelijken.
export async function leesRittenoverzicht(page) {
  return page.locator(SCHERM.overzicht).first().evaluate((grid, dagen) => {
    const koppen = [...grid.querySelectorAll('[role="columnheader"]')].map(k => (k.getAttribute('title') || k.innerText || '').trim())
    const kolom = (t) => koppen.indexOf(t)
    const rijen = [...grid.querySelectorAll('[role="row"]')].filter(r => r.querySelector('[role="gridcell"]'))
    return rijen.map((rij, index) => {
      const cel = (k) => rij.querySelector(`[role="gridcell"][data-position^="${k},"]`)
      const dagenHier = dagen.filter(d => kolom(d) >= 0 && (cel(kolom(d))?.innerText || '').trim() === d)
      const opSlot = dagenHier.filter(d => cel(kolom(d))?.querySelector('img'))
      const verantw = cel(kolom('Ritverantwoordelijke'))?.querySelector('.widget-combobox-selected-items')?.innerText?.trim() ?? ''
      return { index, ritnaam: (cel(0)?.innerText || '').trim(), dagen: dagenHier, opSlot, verantwoordelijkenTekst: verantw }
    })
  }, WEEKDAGEN)
}

// Het Rittenoverzicht toont 20 rijen per pagina ("1 to 20 of 40", gezien 04-11, matransport#573),
// met een zoekveld erboven. Tot 04-11 las de worker alleen pagina 1: de helft van de ritten ontbrak,
// en een rit op pagina 2 kon niet geopend worden.
const PAGINA = {
  zoek: 'input[aria-label="Zoeken"]',
  volgende: 'button[aria-label="Go to next page"]',
  eerste: 'button[aria-label="Go to first page"]',
  status: '.paging-status',
}
const knopAan = async (loc) => (await zichtbaar(loc)) && !(await loc.isDisabled().catch(() => true))

// Het zoekveld van het overzicht vullen (leeg = alles). false = er is geen zoekveld.
async function zoekInOverzicht(page, mendix, tekst) {
  const veld = page.locator(PAGINA.zoek).filter({ visible: true }).first()
  if (!(await veld.count())) return false
  if ((await veld.inputValue().catch(() => '')) === tekst) return true
  await mendix.actie(() => veld.fill(tekst))
  await page.waitForTimeout(800)
  await mendix.wacht()
  return true
}

// Wachten tot de eerste rij een andere is dan `voor` (na bladeren of zoeken), hooguit 10 s.
async function wachtOpAndereRijen(page, voor) {
  const tot = Date.now() + 10_000
  while (Date.now() < tot) {
    const n = await leesRittenoverzicht(page).catch(() => [])
    if (n[0]?.ritnaam && n[0].ritnaam !== voor) return
    await page.waitForTimeout(300)
  }
}

// Alle pagina's van het Rittenoverzicht: de rijen van het scherm en de Mendix-antwoorden. Zet het
// zoekveld eerst leeg en laat het overzicht daarna weer op pagina 1 staan.
export async function leesAlleRitten(page, mendix, { maxPaginas = 25 } = {}) {
  const antwoorden = await naarRittenoverzicht(page, mendix)
  await zoekInOverzicht(page, mendix, '')
  const rijen = []
  for (let i = 0; i < maxPaginas; i++) {
    const hier = await leesRittenoverzicht(page)
    rijen.push(...hier)
    const volgende = page.locator(PAGINA.volgende).first()
    if (!(await knopAan(volgende))) break
    antwoorden.push(...await mendix.actie(() => volgende.click()))
    await wachtOpAndereRijen(page, hier[0]?.ritnaam)
  }
  const eerste = page.locator(PAGINA.eerste).first()
  if (await knopAan(eerste)) await mendix.actie(() => eerste.click()).catch(() => {}) // bewust: alleen netjes achterlaten
  return { antwoorden, rijen, status: await page.locator(PAGINA.status).first().innerText().catch(() => null) }
}

// Vlak na het laden vult Mendix de rijen nog: even blijven kijken. Staat de rit niet op deze
// pagina, dan eerst het zoekveld (snel), anders pagina voor pagina vanaf het begin.
async function overzichtRij(page, ritnaam, weekdag, mendix = null) {
  const vind = async (ms) => {
    const tot = Date.now() + ms
    for (;;) {
      const rijen = await leesRittenoverzicht(page).catch(() => [])
      const rij = rijen.find(r => r.ritnaam === ritnaam && (!weekdag || r.dagen.includes(weekdag)))
      if (rij || Date.now() > tot) return rij ?? null
      await page.waitForTimeout(500)
    }
  }
  let rij = await vind(mendix ? 6_000 : 15_000)
  if (!rij && mendix && await zoekInOverzicht(page, mendix, ritnaam)) rij = await vind(8_000)
  if (!rij && mendix) {
    await zoekInOverzicht(page, mendix, '')
    const eerste = page.locator(PAGINA.eerste).first()
    if (await knopAan(eerste)) await mendix.actie(() => eerste.click())
    for (let i = 0; !rij && i < 25; i++) {
      rij = await vind(2_000)
      const volgende = page.locator(PAGINA.volgende).first()
      if (rij || !(await knopAan(volgende))) break
      const voor = (await leesRittenoverzicht(page).catch(() => []))[0]?.ritnaam
      await mendix.actie(() => volgende.click())
      await wachtOpAndereRijen(page, voor)
    }
  }
  if (!rij) throw new RvaFout('niet_gevonden', `Rit ${ritnaam}${weekdag ? ` op ${weekdag}` : ''} staat niet in het Rittenoverzicht`)
  return { rij, loc: page.locator(`${SCHERM.overzicht} [role="row"]`).filter({ has: page.locator('[role="gridcell"]') }).nth(rij.index) }
}

// Opent de rit-dag. Er zijn per route twee rijen (Ma, en Di–Za): we nemen de rij waar die dag in staat.
export async function openRitDag(page, mendix, ritnaam, weekdag) {
  if (!(await zichtbaar(page.locator(SCHERM.overzicht).first()))) await naarRittenoverzicht(page, mendix)
  const { rij, loc } = await overzichtRij(page, ritnaam, weekdag, mendix)
  const dagKnop = loc.locator('[role="gridcell"] [role="button"]').filter({ hasText: new RegExp(`^\\s*${weekdag}\\s*$`) }).first()
  // Het onzichtbare invoerveld van de keuzelijst Ritverantwoordelijke (kolom ernaast) ligt over
  // het midden van het dagvak en vangt de klik (proef 03-11). Dus op de tekst zelf klikken, en
  // lukt dat niet, de klik rechtstreeks naar het vak sturen.
  const antwoorden = await mendix.actie(async () => {
    await inBeeld(dagKnop)
    await dagKnop.locator('span').first().click({ timeout: 5_000 }).catch(() => dagKnop.dispatchEvent('click'))
  })
  const titel = `${ritnaam} - ${dagnaam(weekdag)}`
  await page.locator(SCHERM.titel).filter({ hasText: titel }).first().waitFor({ state: 'visible', timeout: 30_000 })
    .catch(() => { throw new RvaFout('scherm', `Rit-dag ${titel} ging niet open`) })
  await page.locator(SCHERM.regels).first().waitFor({ state: 'visible', timeout: 30_000 }).catch(() => {})
  await mendix.wacht()
  return { antwoorden, opSlot: rij.opSlot.includes(weekdag) }
}

// ── De rit-dag ───────────────────────────────────────────────────────────────

// De regels zoals ze in beeld staan, in dezelfde vorm als lezen.regelVan(). In de bewerkstand
// staat de volgorde in een invoervak, anders als tekst.
// Direct na Annuleer/Opslaan tekent Mendix bij een lange rit eerst lege regels en vult ze daarna
// (proef 03-11, 199 regels): wachten tot elke regel een straat heeft, anders lees je leeg.
export async function leesRegels(page, { maxMs = 15_000 } = {}) {
  const tot = Date.now() + maxMs
  for (;;) {
    const regels = await leesRegelsNu(page)
    if (regels.every(r => r.straat) || Date.now() > tot) return regels
    await page.waitForTimeout(300)
  }
}

async function leesRegelsNu(page) {
  return page.locator(SCHERM.regels).evaluateAll((tabellen) => tabellen.map((t) => {
    const tekst = (sel) => (t.querySelector(sel)?.innerText || '').trim()
    const getal = (s) => (s === '' ? null : Number(s))
    const vak = t.querySelector('.mx-name-textBox1 input')
    return {
      volgorde: getal(vak ? vak.value.trim() : (t.querySelector('td')?.innerText || '').trim()),
      postcode: tekst('.mx-name-text11'),
      plaats: tekst('.mx-name-text10'),
      straat: tekst('.mx-name-text7'),
      van: getal(tekst('.mx-name-text8')),
      tm: getal(tekst('.mx-name-text9')),
      evenOneven: tekst('.mx-name-text12'),
      richting: tekst('.mx-name-badge2'),
      oudeVolgorde: getal(tekst('.mx-name-text6')),
    }
  }))
}

export const inBewerkstand = async (page) => zichtbaar(knop(page, SCHERM.opslaan)) && !(await zichtbaar(knop(page, SCHERM.wijzig)))

// Mag dit account deze rit-dag bewerken? Alleen een ritverantwoordelijke ziet Wijzig (of zit al in de bewerkstand).
export const magWijzigen = async (page) => (await zichtbaar(knop(page, SCHERM.wijzig))) || inBewerkstand(page)

async function regelRij(page, sleutel) {
  const regels = await leesRegels(page)
  const regel = vindRegel(regels, sleutel)
  if (!regel) throw new RvaFout('niet_gevonden', 'Regel staat niet (meer) in deze rit-dag')
  const index = regels.findIndex(r => regelSleutel(r) === sleutel)
  return { regel, index, regels, loc: page.locator(SCHERM.regels).nth(index) }
}

// Wijzig. Staat de rit-dag al in de bewerkstand (een vorige poging van dit account), dan eerst
// Annuleer: anders gaan we verder op halve wijzigingen. Zit er een slot van een ander op, dan
// toont PostNL een melding en blijft Wijzig staan: fout 'vergrendeld', niets doen.
export async function startWijzig(page, mendix) {
  if (await inBewerkstand(page)) await annuleer(page, mendix)
  // Geen Wijzig-knop = dit account mag deze rit niet bewerken: het moet bij de rit als
  // Ritverantwoordelijke staan (Rittenoverzicht). Welke namen dat zijn, verschilt per klant.
  if (!(await zichtbaar(knop(page, SCHERM.wijzig)))) {
    throw new RvaFout('geen_rechten', 'Geen Wijzig-knop: het account staat niet als Ritverantwoordelijke bij deze rit')
  }
  const antwoorden = await mendix.actie(() => knop(page, SCHERM.wijzig).click())
  // Vlak na een Opslaan (de basisrevisie) ververst RVA de pagina nog: wachten tot de bewerkstand
  // er echt is, niet meteen kijken (proef 03-11: vals 'vergrendeld').
  await knop(page, SCHERM.opslaan).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
  if (await inBewerkstand(page)) return antwoorden
  // Nog één keer proberen: de eerste klik kan in het verversen gevallen zijn.
  if (await zichtbaar(knop(page, SCHERM.wijzig))) {
    antwoorden.push(...await mendix.actie(() => knop(page, SCHERM.wijzig).click()))
    await knop(page, SCHERM.opslaan).waitFor({ state: 'visible', timeout: 15_000 }).catch(() => {})
    if (await inBewerkstand(page)) return antwoorden
  }
  const melding = await sluitVenster(page, mendix)
  throw new RvaFout('vergrendeld', `Wijzigen kan niet${melding ? `: ${melding.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`)
}

export async function opslaan(page, mendix) {
  const antwoorden = await mendix.actie(() => knop(page, SCHERM.opslaan).click(), 60_000)
  await knop(page, SCHERM.wijzig).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => {})
  if (!(await zichtbaar(knop(page, SCHERM.wijzig)))) {
    const melding = await sluitVenster(page, mendix)
    throw new RvaFout('opslaan', `Opslaan lukte niet${melding ? `: ${melding.replace(/\s+/g, ' ').slice(0, 160)}` : ''}`)
  }
  return antwoorden
}

export async function annuleer(page, mendix) {
  const antwoorden = await mendix.actie(() => knop(page, SCHERM.annuleer).click(), 60_000)
  await knop(page, SCHERM.wijzig).waitFor({ state: 'visible', timeout: 20_000 })
  return antwoorden
}

// Volgorde: nummer in het vak typen en het vak verlaten (Mendix verwerkt bij het verlaten).
export async function zetVolgorde(page, mendix, sleutel, nummer) {
  const { loc } = await regelRij(page, sleutel)
  const vak = loc.locator(SCHERM.volgordeVak).first()
  return mendix.actie(async () => {
    await (await inBeeld(vak)).fill(String(nummer))
    await vak.press('Tab')
  })
}

export async function zetRichting(page, mendix, sleutel, richting) {
  const { regel, loc } = await regelRij(page, sleutel)
  if (regel.richting === richting) return []
  const antwoorden = await mendix.actie(async () => (await inBeeld(loc.locator(SCHERM.richting).first())).click())
  const na = await regelRij(page, sleutel)
  if (na.regel.richting !== richting) throw new RvaFout('controle', `Richting van ${regelLabel(na.regels, sleutel)} is niet ${richting} geworden`)
  return antwoorden
}

// Rechtsklik op de regel en een keuze uit het menu dat eronder openklapt.
async function regelMenu(page, mendix, sleutel, item) {
  const { loc } = await regelRij(page, sleutel)
  await mendix.actie(async () => (await inBeeld(loc.locator('.mx-name-container8, .mx-name-text7').first())).click({ button: 'right' }))
  const keuze = knop(page, item)
  await keuze.waitFor({ state: 'attached', timeout: 10_000 }).then(() => inBeeld(keuze)).catch(() => {})
  await keuze.waitFor({ state: 'visible', timeout: 10_000 }).catch(() => { throw new RvaFout('scherm', `Menu-keuze "${item[1]}" verscheen niet`) })
  return mendix.actie(() => keuze.click())
}

// Knippen: in "Adressen knippen" de t/m van de (laatste) regel aanpassen. PostNL maakt zelf de
// rest-regel aan. Opslaan in het venster past alleen de kladversie aan.
export async function knip(page, mendix, sleutel, tm) {
  const antwoorden = await regelMenu(page, mendix, sleutel, SCHERM.menuKnip)
  const v = await wachtOpVenster(page, 'Adressen knippen')
  const tmVakken = v.locator('.mx-name-textBox2 input')
  const voor = await tmVakken.count()
  antwoorden.push(...await mendix.actie(async () => {
    const vak = tmVakken.last()
    await vak.fill(String(tm))
    await vak.press('Tab')
  }))
  if ((await tmVakken.count()) <= voor) {
    await mendix.actie(() => v.locator(SCHERM.knipAnnuleren).first().click()).catch(() => {})
    throw new RvaFout('controle', 'Knippen: PostNL maakte geen rest-regel aan')
  }
  antwoorden.push(...await mendix.actie(() => v.locator(SCHERM.knipOpslaan).first().click()))
  await v.waitFor({ state: 'hidden', timeout: 15_000 })
  return antwoorden
}

// De rij van dit deel in het venster "Adressen samenvoegen", op de cellen onder "Huisnr. vanaf"
// en "Huisnr. t/m" (hasText ziet de cellen aan elkaar geplakt, zonder spatie ertussen). Of null.
export async function samenvoegRij(v, regel) {
  const index = await v.locator('[role="grid"]').first().evaluate((grid, { van, tm }) => {
    const koppen = [...grid.querySelectorAll('[role="columnheader"]')].map(k => (k.getAttribute('title') || '').trim())
    const kv = koppen.indexOf('Huisnr. vanaf')
    const kt = koppen.indexOf('Huisnr. t/m')
    const rs = [...grid.querySelectorAll('[role="row"]')].filter(r => r.querySelector('[role="gridcell"]'))
    const cel = (r, k) => (r.querySelectorAll('[role="gridcell"]')[k]?.innerText || '').trim()
    return rs.findIndex(r => cel(r, kv) === String(van) && cel(r, kt) === String(tm))
  }, { van: regel.van, tm: regel.tm })
  return index < 0 ? null : v.locator('[role="row"]').filter({ has: v.page().locator('[role="gridcell"]') }).nth(index)
}

// Samenvoegen: in "Adressen samenvoegen" staan alle delen van deze straat (zelfde even/oneven).
// ↓ voegt een deel samen met het deel eronder, ↑ met het deel erboven.
export async function voegSamen(page, mendix, sleutel, richting = 'onder') {
  const { regel } = await regelRij(page, sleutel)
  const antwoorden = await regelMenu(page, mendix, sleutel, SCHERM.menuSamenvoegen)
  const v = await wachtOpVenster(page, 'Adressen samenvoegen')
  const rij = await samenvoegRij(v, regel)
  const pijl = rij?.locator(richting === 'boven' ? SCHERM.samenOmhoog : SCHERM.samenOmlaag).first()
  if (!rij) {
    await mendix.actie(() => v.locator(SCHERM.samenAnnuleren).first().click()).catch(() => {})
    throw new RvaFout('niet_gevonden', 'Samenvoegen: dit deel staat niet in het venster')
  }
  if (!(await zichtbaar(pijl))) {
    await mendix.actie(() => v.locator(SCHERM.samenAnnuleren).first().click()).catch(() => {})
    throw new RvaFout('controle', `Samenvoegen naar ${richting} kan niet bij dit deel`)
  }
  antwoorden.push(...await mendix.actie(() => pijl.click()))
  antwoorden.push(...await mendix.actie(() => v.locator(SCHERM.samenOpslaan).first().click()))
  await v.waitFor({ state: 'hidden', timeout: 15_000 })
  return antwoorden
}

// Keuzelijst-widget (geen <select>): openen, de opties lezen, één kiezen. Zonder tekst: de eerste.
async function kiesOptie(page, mendix, widget, tekst) {
  await mendix.actie(() => widget.locator('input[role="combobox"], .form-control').first().click())
  const opties = page.locator('[role="option"]').filter({ visible: true })
  const lijst = (await opties.allInnerTexts()).map(t => t.trim())
  const i = tekst == null ? (lijst.length ? 0 : -1) : lijst.findIndex(t => t === String(tekst))
  if (i < 0) {
    await page.keyboard.press('Escape')
    throw new RvaFout('controle', `Keuze "${tekst}" bestaat niet (wel: ${lijst.join(', ') || 'niets'})`)
  }
  return mendix.actie(() => opties.nth(i).click())
}

// Plaatsgebonden onderbreking na deze regel, met de minuten uit de keuzelijst van PostNL.
export async function onderbreking(page, mendix, sleutel, minuten) {
  const antwoorden = await regelMenu(page, mendix, sleutel, SCHERM.menuOnderbreking)
  const v = await wachtOpVenster(page, 'plaatsgebonden onderbreking')
  try {
    antwoorden.push(...await kiesOptie(page, mendix, v.locator(SCHERM.onderbrekingMinuten).first(), minuten))
  } catch (err) {
    await mendix.actie(() => v.locator(SCHERM.onderbrekingAnnuleer).first().click()).catch(() => {})
    throw err
  }
  antwoorden.push(...await mendix.actie(() => v.locator(SCHERM.onderbrekingOpslaan).first().click()))
  await v.waitFor({ state: 'hidden', timeout: 15_000 })
  return antwoorden
}

// Bestaande onderbreking na deze regel weghalen: hetzelfde venster, knop Verwijder.
export async function verwijderOnderbreking(page, mendix, sleutel) {
  const antwoorden = await regelMenu(page, mendix, sleutel, SCHERM.menuOnderbreking)
  const v = await wachtOpVenster(page, 'plaatsgebonden onderbreking')
  // Een bestaande onderbreking opent met de minuten ingevuld; leeg = er is er geen. De gekozen
  // waarde staat als tekst in de keuzelijst (caption), niet in het invoerveld (live 03-11).
  const keuze = v.locator(SCHERM.onderbrekingMinuten).first()
  const minuten = ((await keuze.locator('.widget-combobox-caption-text').first().innerText().catch(() => ''))
    || (await keuze.locator('input').first().inputValue().catch(() => ''))).trim()
  if (!minuten) {
    await mendix.actie(() => v.locator(SCHERM.onderbrekingAnnuleer).first().click()).catch(() => {})
    throw new RvaFout('niet_gevonden', 'Er staat geen onderbreking na deze regel')
  }
  antwoorden.push(...await mendix.actie(() => v.locator(SCHERM.onderbrekingVerwijder).first().click()))
  // PostNL vraagt "Weet je het zeker?" (Annuleer / Ja), gezien in de proef van 03-11.
  const bevestig = await wachtOpVenster(page, 'Bevestiging')
  antwoorden.push(...await mendix.actie(() => bevestig.getByRole('button', { name: 'Ja', exact: true }).click()))
  await v.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => { throw new RvaFout('scherm', 'Venster onderbreking ging niet dicht na Verwijder') })
  return antwoorden
}

// ── Buiten de bewerkstand ────────────────────────────────────────────────────

// Kopieer weekdag: precies de dagen in `naar` aan, de rest uit. Slaat direct op bij PostNL.
export async function kopieerWeekdag(page, mendix, naar) {
  const antwoorden = await mendix.actie(() => knop(page, SCHERM.kopieerWeekdag).click())
  const v = await wachtOpVenster(page, 'kopiëren naar een andere dag')
  const namen = naar.map(dagnaam)
  for (const naam of Object.values(DAGNAAM)) {
    const rij = v.locator('.mx-name-WeekdaySwitch').filter({ hasText: new RegExp(`^\\s*${naam}\\s*$`) }).first()
    if (!(await rij.count())) {
      if (namen.includes(naam)) throw new RvaFout('controle', `${naam} staat niet in het kopieer-venster`)
      continue
    }
    // De checkbox is een verborgen hulpvak (sr-only); klikken op de zichtbare schakelaar.
    const schakelaar = rij.locator('[role="switch"]').first()
    const stand = async () => {
      const aria = await schakelaar.getAttribute('aria-checked').catch(() => null)
      return aria != null ? aria === 'true' : rij.locator('input[type="checkbox"]').first().isChecked()
    }
    if ((await stand()) !== namen.includes(naam)) antwoorden.push(...await mendix.actie(() => schakelaar.click()))
    if ((await stand()) !== namen.includes(naam)) throw new RvaFout('controle', `Schakelaar ${naam} staat niet goed`)
  }
  antwoorden.push(...await mendix.actie(() => v.locator(SCHERM.kopieerOpslaan).first().click(), 60_000))
  const info = await wachtOpVenster(page, 'Informatie', 30_000)
  const tekst = (await info.innerText().catch(() => '')).trim()
  antwoorden.push(...await mendix.actie(() => info.locator(SCHERM.kopieerOk).first().click()))
  return { antwoorden, melding: tekst.replace(/\s+/g, ' ') }
}

// De revisielijst zoals in beeld: gemaakt op (tekst), door, actief. Laat het venster open.
export async function openRevisies(page, mendix) {
  const antwoorden = await mendix.actie(() => knop(page, SCHERM.revisies).click())
  const v = await wachtOpVenster(page, 'Revisies')
  await v.locator('[role="row"] [role="gridcell"]').first().waitFor({ state: 'visible', timeout: 15_000 })
  const rijen = await v.locator('[role="row"]').filter({ has: page.locator('[role="gridcell"]') }).evaluateAll(rs => rs.map(r => {
    const c = [...r.querySelectorAll('[role="gridcell"]')].map(x => (x.innerText || '').trim())
    return { gemaaktOp: c[0], door: c[1], actief: c[2] === 'Ja' }
  }))
  return { antwoorden, rijen, venster: v }
}

// De revisies met hun inhoud (regels). De inhoud komt pas binnen ná het openen van het venster,
// dus alle antwoorden opvangen tot het stil is. Sluit het venster weer.
export async function leesRevisies(page, mendix) {
  const opgevangen = []
  const luister = (r) => { if (r.url().includes('/xas/')) r.json().then(j => opgevangen.push(j)).catch(() => {}) }
  page.on('response', luister)
  try {
    const { antwoorden, rijen } = await openRevisies(page, mendix)
    await page.waitForTimeout(2_000)
    await mendix.wacht()
    await sluitVenster(page, mendix)
    return { rijen, revisies: revisiesUit([...antwoorden, ...opgevangen]) }
  } finally {
    page.off('response', luister)
  }
}

// Zet de revisie met deze tijd ("dd-mm-jjjj hh:mm") terug. Twee revisies in dezelfde minuut:
// niet eenduidig, dan niets doen.
export async function zetRevisieTerug(page, mendix, gemaaktOpTekst) {
  const { antwoorden, rijen, venster: v } = await openRevisies(page, mendix)
  const treffers = rijen.filter(r => r.gemaaktOp === gemaaktOpTekst)
  if (treffers.length !== 1) {
    await sluitVenster(page, mendix)
    throw new RvaFout('controle', `Revisie ${gemaaktOpTekst} ${treffers.length ? 'staat er meer dan één keer' : 'niet gevonden'}`)
  }
  const rij = v.locator('[role="row"]').filter({ has: page.locator('[role="gridcell"]') }).nth(rijen.indexOf(treffers[0]))
  antwoorden.push(...await mendix.actie(() => rij.locator(SCHERM.revisieTerug).first().click()))
  const bevestig = await wachtOpVenster(page, 'Bevestiging')
  antwoorden.push(...await mendix.actie(() => bevestig.getByRole('button', { name: 'Doorgaan', exact: true }).click(), 60_000))
  await v.waitFor({ state: 'hidden', timeout: 15_000 }).catch(() => {})
  await sluitVenster(page, mendix)
  return antwoorden
}

// De keuzelijst Ritverantwoordelijke van een rij openen: alle namen en welke aan staan.
async function openVerantwoordelijken(page, mendix, ritnaam, weekdag) {
  if (!(await zichtbaar(page.locator(SCHERM.overzicht).first()))) await naarRittenoverzicht(page, mendix)
  const { loc } = await overzichtRij(page, ritnaam, weekdag, mendix)
  const widget = loc.locator('.mx-name-comboBox3').first()
  const antwoorden = await mendix.actie(async () => (await inBeeld(widget.locator('input[role="combobox"]').first())).click())
  const opties = page.locator('[role="option"]').filter({ visible: true })
  await opties.first().waitFor({ state: 'visible', timeout: 10_000 }).catch(() => {})
  const lijst = await opties.evaluateAll(os => os.map(o => ({ naam: (o.innerText || '').trim(), aan: o.getAttribute('aria-selected') === 'true' })))
  return { antwoorden, opties, lijst }
}

export async function leesVerantwoordelijken(page, mendix, ritnaam, weekdag) {
  const { lijst } = await openVerantwoordelijken(page, mendix, ritnaam, weekdag)
  await page.keyboard.press('Escape')
  return { gekozen: lijst.filter(o => o.aan).map(o => o.naam), alle: lijst.map(o => o.naam) }
}

// Ritverantwoordelijken in het Rittenoverzicht. Elke klik slaat direct op bij PostNL.
export async function zetVerantwoordelijken(page, mendix, ritnaam, weekdag, namen) {
  const { antwoorden, opties, lijst } = await openVerantwoordelijken(page, mendix, ritnaam, weekdag)
  const onbekend = namen.filter(n => !lijst.some(o => o.naam === n))
  if (onbekend.length) {
    await page.keyboard.press('Escape')
    throw new RvaFout('controle', `${onbekend.length} naam/namen staan niet in de keuzelijst`)
  }
  for (const [i, o] of lijst.entries()) {
    if (o.aan !== namen.includes(o.naam)) antwoorden.push(...await mendix.actie(() => opties.nth(i).click()))
  }
  await page.keyboard.press('Escape')
  await mendix.wacht()
  return antwoorden
}

// Excel export: het bestand dat PostNL aanbiedt opslaan in `map`.
export async function excelExport(page, mendix, map) {
  const download = page.waitForEvent('download', { timeout: 60_000 })
  await mendix.actie(() => knop(page, SCHERM.excelExport).click())
  const d = await download.catch(() => { throw new RvaFout('scherm', 'Excel export: geen download binnen 60 s') })
  const pad = `${map}/${d.suggestedFilename()}`
  await d.saveAs(pad)
  return pad
}
