import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { volgMendix } from '../src/mendix.js'

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
