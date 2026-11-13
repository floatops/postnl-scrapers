import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { volgMendix, VERWEESD_MS, antwoordKnop, kiesChauffeur, leesChauffeurKeuze } from '../src/mendix.js'

// Genoeg van een Playwright-pagina voor volgMendix: events, geen voortgangsbalk, korte timeouts.
function nepPagina() {
  const page = new EventEmitter()
  page.locator = () => ({ first: () => ({ isVisible: async () => false }) })
  page.waitForTimeout = (ms) => new Promise(r => setTimeout(r, Math.min(ms, 5)))
  page.antwoord = (json) => {
    const req = { url: () => 'https://x/xas/' }
    page.emit('request', req)
    page.emit('response', { url: () => 'https://x/xas/', json: async () => json })
    page.emit('requestfinished', req)
  }
  return page
}

test('volgMendix: één volger per pagina, geen stapel listeners (matransport#573)', () => {
  const page = nepPagina()
  for (let i = 0; i < 50; i++) volgMendix(page)
  assert.equal(page.listenerCount('response'), 1)
  assert.equal(volgMendix(page), volgMendix(page))
})

test('volgMendix: actie geeft alleen de eigen antwoorden, daarbuiten wordt niets bewaard', async () => {
  const page = nepPagina()
  const m = volgMendix(page)
  page.antwoord({ buiten: 1 })
  const a = await m.actie(async () => { page.antwoord({ n: 1 }); page.antwoord({ n: 2 }) })
  assert.deepEqual(a, [{ n: 1 }, { n: 2 }])
  page.antwoord({ buiten: 2 })
  const b = await volgMendix(page).actie(async () => { page.antwoord({ n: 3 }) })
  assert.deepEqual(b, [{ n: 3 }])
})

// Mendix stuurt bij het verlaten van de pagina een fetch die nooit finished/failed krijgt.
function weesVerzoek(page) {
  page.emit('request', { url: () => 'https://x/xas/' })
}
function nieuwDocument(page) {
  const frame = {}
  page.mainFrame = () => frame
  const req = { isNavigationRequest: () => true, resourceType: () => 'document' }
  page.emit('response', { url: () => 'https://x/index.html', request: () => req, frame: () => frame })
}

test('volgMendix: na herladen telt een verweesd verzoek van het oude document niet mee (matransport#592)', async () => {
  const page = nepPagina()
  const m = volgMendix(page)
  weesVerzoek(page)
  await assert.rejects(m.wacht(200), /niet binnen de wachttijd/)
  nieuwDocument(page)
  await m.wacht(2_000)
  // En daarna blijft de volger gewoon werken.
  const a = await m.actie(async () => { page.antwoord({ n: 1 }) }, 2_000)
  assert.deepEqual(a, [{ n: 1 }])
})

test('volgMendix: een verzoek zonder antwoord telt na VERWEESD_MS niet meer mee', async (t) => {
  const page = nepPagina()
  const m = volgMendix(page)
  weesVerzoek(page)
  const echt = Date.now()
  t.mock.method(Date, 'now', () => echt + VERWEESD_MS + 1_000)
  await m.wacht(60_000)
})

test('volgMendix: een gewoon open verzoek houdt wacht() vast tot het antwoord er is', async () => {
  const page = nepPagina()
  const m = volgMendix(page)
  const req = { url: () => 'https://x/xas/' }
  page.emit('request', req)
  await assert.rejects(m.wacht(200), /niet binnen de wachttijd/)
  page.emit('requestfinished', req)
  await m.wacht(2_000)
})

// 05-11 09:53 (matransport#598): PostNL gaf een 460 en herlaadde de app midden in een actie. Het
// antwoord van het oude document kreeg nooit een body; wacht() bleef daarop 4,5 min hangen.
function antwoordZonderBody(page) {
  const req = { url: () => 'https://x/xas/' }
  page.emit('request', req)
  page.emit('response', { url: () => 'https://x/xas/', json: () => new Promise(() => {}) })
  page.emit('requestfinished', req)
}

test('volgMendix: een antwoord zonder body houdt actie() hooguit LEZEN_MS vast (matransport#598)', async () => {
  const { LEZEN_MS } = await import('../src/mendix.js')
  const page = nepPagina()
  const m = volgMendix(page)
  const begin = Date.now()
  const a = await m.actie(async () => { page.antwoord({ n: 1 }); antwoordZonderBody(page) }, 30_000)
  const duur = Date.now() - begin
  assert.deepEqual(a, [{ n: 1 }], 'wat wel binnenkwam, telt')
  assert.ok(duur < LEZEN_MS + 3_000, `actie duurde ${duur} ms`)
})

test('volgMendix: na een nieuw hoofddocument wordt niet meer op oude bodies gewacht (matransport#598)', async () => {
  const page = nepPagina()
  const m = volgMendix(page)
  const begin = Date.now()
  await m.actie(async () => {
    antwoordZonderBody(page)
    const frame = {}
    page.mainFrame = () => frame
    page.emit('response', { url: () => 'https://x/index.html', request: () => ({ isNavigationRequest: () => true, resourceType: () => 'document' }), frame: () => frame })
  }, 30_000)
  assert.ok(Date.now() - begin < 2_000, 'meteen klaar: het oude document is weg')
})

test('chauffeurvraag: de knop past op de echte teksten van PostNL (matransport#707, trace 11-11)', () => {
  const ja = 'Ja, koppel chauffeur voor deze &  nog komende ritten van dit scenario'
  const nee = 'Nee, koppel de chauffeur alleen voor de rit van vandaag'
  assert.ok(antwoordKnop(true).test(ja))
  assert.ok(!antwoordKnop(true).test(nee))
  assert.ok(antwoordKnop(false).test(nee))
  assert.ok(!antwoordKnop(false).test(ja))
  // Bij een lege chauffeur stelt PostNL een andere vraag (verwijderen): daar past geen van beide.
  for (const t of ['Ja, verwijder chauffeur voor deze &  nog komende ritten van dit scenario', 'Nee, verwijder de chauffeur alleen bij de rit van vandaag']) {
    assert.ok(!antwoordKnop(true).test(t) && !antwoordKnop(false).test(t))
  }
})

// Nagemaakt venster "Wijzig chauffeur" (matransport#707): knoppen met de echte teksten, en per knop
// wat een klik doet ('dicht' = venster weg, 'hangt' = klik gooit, venster blijft, 'niets' = blijft open).
const JA = 'Ja, koppel chauffeur voor deze &  nog komende ritten van dit scenario'
const NEE = 'Nee, koppel de chauffeur alleen voor de rit van vandaag'
function nepVraag({ knoppen = [JA, NEE], gedrag = {}, kruisje = 'dicht' } = {}) {
  const st = { open: true, geklikt: [] }
  const zichtbaar = re => st.open && knoppen.some(k => re.test(k))
  const loc = re => ({
    first() { return this },
    isVisible: async () => zichtbaar(re),
    waitFor: async ({ state }) => { if ((state === 'visible') !== zichtbaar(re)) throw new Error('timeout') },
    click: async () => {
      const k = knoppen.find(x => re.test(x))
      st.geklikt.push(k === JA ? 'ja' : 'nee')
      const g = gedrag[k === JA ? 'ja' : 'nee'] ?? 'dicht'
      if (g === 'hangt') throw new Error('Timeout 10000ms exceeded')
      if (g === 'dicht') st.open = false
    },
  })
  const page = {
    getByRole: (_r, { name }) => loc(name),
    getByText: () => ({ first: () => ({ isVisible: async () => st.open }) }),
    locator: sel => ({
      first: () => ({
        selectOption: async () => {},
        isVisible: async () => st.open,
        innerText: async () => 'Wijzig chauffeur',
        click: async () => { st.geklikt.push('kruisje'); if (kruisje === 'dicht') st.open = false },
      }),
    }),
  }
  const mendix = { actie: async (fn) => { await fn(); return [] } }
  return { page, mendix, st }
}

test('chauffeurvraag: ook de komende ritten klikt Ja (matransport#707)', async () => {
  const { page, mendix, st } = nepVraag()
  const uit = await kiesChauffeur(page, mendix, 'X', { ookKomend: true })
  assert.deepEqual(st.geklikt, ['ja'])
  assert.equal(uit.ookKomend, true)
  assert.deepEqual(uit.opmerkingen, [])
})

test('chauffeurvraag: standaard alleen vandaag', async () => {
  const { page, mendix, st } = nepVraag()
  const uit = await kiesChauffeur(page, mendix, 'X')
  assert.deepEqual(st.geklikt, ['nee'])
  assert.equal(uit.ookKomend, false)
})

test('chauffeurvraag: geen Ja-knop = terug op alleen vandaag, met reden, zonder fout', async () => {
  const { page, mendix, st } = nepVraag({ knoppen: [NEE] })
  const uit = await kiesChauffeur(page, mendix, 'X', { ookKomend: true })
  assert.deepEqual(st.geklikt, ['nee'])
  assert.equal(uit.ookKomend, false)
  assert.match(uit.opmerkingen.join(' '), /komende ritten zijn niet aangepast/)
})

test('chauffeurvraag: klik op Ja hangt en het venster blijft = alleen vandaag, zonder fout', async () => {
  const { page, mendix, st } = nepVraag({ gedrag: { ja: 'hangt' } })
  const uit = await kiesChauffeur(page, mendix, 'X', { ookKomend: true })
  assert.deepEqual(st.geklikt, ['ja', 'nee'])
  assert.equal(uit.ookKomend, false)
  assert.match(uit.opmerkingen.join(' '), /reageerde niet/)
})

test('chauffeurvraag: geen knop doet iets = dicht met het kruisje, zonder fout', async () => {
  const { page, mendix, st } = nepVraag({ gedrag: { ja: 'niets', nee: 'niets' } })
  const uit = await kiesChauffeur(page, mendix, 'X', { ookKomend: true })
  assert.equal(st.geklikt.at(-1), 'kruisje')
  assert.equal(uit.ookKomend, false)
  assert.match(uit.opmerkingen.join(' '), /kruisje/)
})

test('chauffeurvraag: venster gaat ook met het kruisje niet dicht = fout (volgende wijziging zou vastlopen)', async () => {
  const { page, mendix } = nepVraag({ gedrag: { ja: 'niets', nee: 'niets' }, kruisje: 'niets' })
  await assert.rejects(kiesChauffeur(page, mendix, 'X', { ookKomend: true }), /ging niet dicht/)
})

// matransport#713: de keuzelijst geeft id + naam per optie, en wordt pas gelezen als hij stil staat.
function nepKeuzelijst(standen, { disabled = false } = {}) {
  let i = 0
  const locator = {
    first() { return this },
    count: async () => 1,
    evaluate: async (fn) => {
      const opties = standen[Math.min(i++, standen.length - 1)]
      const el = { disabled, selectedIndex: 0, options: [{ value: '', label: '' }, ...opties.map(([value, label]) => ({ value, label }))] }
      el.selectedIndex = opties.length ? 1 : 0
      return fn(el)
    },
  }
  return { locator: () => locator }
}

test('chauffeurkeuzelijst: id per optie, wacht tot het aantal stil staat, met een grens', async () => {
  const page = nepKeuzelijst([[['1', 'Een, A.']], [['1', 'Een, A.'], ['2', 'Twee, B.']], [['1', 'Een, A.'], ['2', 'Twee, B.']]])
  const uit = await leesChauffeurKeuze(page, { stilMs: 2000, stapMs: 1 })
  assert.deepEqual(uit.keuzes, [{ id: '1', naam: 'Een, A.' }, { id: '2', naam: 'Twee, B.' }])
  assert.deepEqual(uit.opties, ['Een, A.', 'Twee, B.'])
  assert.equal(uit.huidigId, '1')
  // Groeit hij steeds door: na de grens toch lezen wat er staat, niet eeuwig wachten.
  let n = 0
  const groeit = { locator: () => ({ first() { return this }, count: async () => 1, evaluate: async (fn) => fn({ disabled: false, selectedIndex: -1, options: Array.from({ length: ++n }, (_, k) => ({ value: String(k + 1), label: `C${k}` })) }) }) }
  const t0 = Date.now()
  const g = await leesChauffeurKeuze(groeit, { stilMs: 50, stapMs: 5 })
  assert.ok(Date.now() - t0 < 1000)
  assert.ok(g.keuzes.length > 1)
  // Vergrendeld (geautoriseerde rit): niet wachten.
  const slot = await leesChauffeurKeuze(nepKeuzelijst([[['1', 'Een, A.']]], { disabled: true }), { stilMs: 5000, stapMs: 1 })
  assert.equal(slot.wijzigbaar, false)
})
