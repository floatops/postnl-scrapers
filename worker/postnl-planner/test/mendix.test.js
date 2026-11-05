import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { volgMendix, VERWEESD_MS } from '../src/mendix.js'

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
