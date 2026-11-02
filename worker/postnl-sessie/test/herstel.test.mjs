// node --test — sessie gezond, verlopen, eruit gegooid of geblokkeerd, en wat de sessiehouder dan
// doet; plus de levensduur-meting (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classificeer, herstel, isLoginUrl } from '../src/gezondheid.js'
import { schatLevensduur, moetVernieuwen } from '../src/levensduur.js'
import { mergeInstellingen } from '../src/instellingen.js'

const cfg = mergeInstellingen({})
const DEPOT = 'pnl-oompd-process-xyz.p15.cldsvc.net'
const depotUrl = `https://${DEPOT}/index.html`
const nu = new Date('2026-11-02T10:00:00Z')
const geleden = (min) => new Date(nu.getTime() - min * 60_000)

test('classificeer: de gevallen die we in sessievideo\'s hebben gezien', () => {
  // Sessie verlopen: PostNL stuurt naar de loginpagina (met de depot-URL in de redirect).
  assert.equal(classificeer({ url: `https://www.loginpostnl.net/login/?goto=https%3A%2F%2F${DEPOT}`, depotHost: DEPOT }), 'verlopen')
  // #361 / 30-10: "pagina herlaadde" en Execution context destroyed zonder login = eruit gegooid.
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, fout: new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation') }), 'gegooid')
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, planningZichtbaar: false }), 'gegooid', 'terug op de startpagina zonder menu')
  // Akamai
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, fout: Object.assign(new Error('x'), { name: 'ProxyBlokkadeError' }) }), 'blokkade')
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, blokkade: true }), 'blokkade')
  // Browser gecrasht / gesloten
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, fout: new Error('Target page, context or browser has been closed') }), 'browser_weg')
  // Database: sessie is in orde
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, fout: Object.assign(new Error('ritten lezen: 57014'), { database: true }) }), 'database')
  // PostNL traag / time-out
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, fout: new Error('locator.click: Timeout 15000ms exceeded') }), 'fout')
  assert.equal(classificeer({ url: 'chrome-error://chromewebdata/', depotHost: DEPOT }), 'fout')
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, planningZichtbaar: true }), 'gezond')
})

test('isLoginUrl: login, authorize en login.html, maar niet een pad dat toevallig "login" bevat', () => {
  assert.ok(isLoginUrl('https://www.loginpostnl.net/login/'))
  assert.ok(isLoginUrl(`https://${DEPOT}/login.html`))
  assert.ok(isLoginUrl('https://x/oauth2/authorize?x'))
  assert.equal(isLoginUrl(depotUrl), false)
})

test('herstel: eerste keer eruit gegooid = opnieuw openen, tweede keer binnen 2 min = nieuwe login', () => {
  assert.equal(herstel('gegooid', { recent: [], nu, cfg }), 'opnieuw_openen')
  assert.equal(herstel('gegooid', { recent: [{ soort: 'gegooid', at: geleden(1) }], nu, cfg }), 'nieuwe_login')
  assert.equal(herstel('gegooid', { recent: [{ soort: 'gegooid', at: geleden(5) }], nu, cfg }), 'opnieuw_openen')
})

test('herstel: verlopen, blokkade en browser weg = meteen nieuwe login (nieuw IP)', () => {
  for (const s of ['verlopen', 'blokkade', 'browser_weg']) assert.equal(herstel(s, { nu, cfg }), 'nieuwe_login', s)
})

test('herstel: gewone fouten pas na 3 achter elkaar een nieuwe login; databasefout raakt de sessie niet', () => {
  assert.equal(herstel('fout', { recent: [], nu, cfg }), 'opnieuw_openen')
  assert.equal(herstel('fout', { recent: [{ soort: 'fout' }], nu, cfg }), 'opnieuw_openen')
  assert.equal(herstel('fout', { recent: [{ soort: 'fout' }, { soort: 'fout' }], nu, cfg }), 'nieuwe_login')
  assert.equal(herstel('fout', { recent: [{ soort: 'fout' }, { soort: 'gezond' }], nu, cfg }), 'opnieuw_openen', 'teller begint opnieuw na een geslaagde taak')
  assert.equal(herstel('database', { nu, cfg }), 'geen')
})

test('herstel: na 4 logins in een uur geen vijfde maar een pauze', () => {
  const logins = [geleden(50), geleden(30), geleden(20), geleden(5)]
  assert.equal(herstel('verlopen', { logins, nu, cfg }), 'pauze')
  assert.equal(herstel('verlopen', { logins: [geleden(70), ...logins.slice(1)], nu, cfg }), 'nieuwe_login', 'login van 70 min geleden telt niet')
})

test('levensduur: pas een schatting vanaf 3 metingen, het 10e percentiel', () => {
  assert.equal(schatLevensduur([120, 130]), null)
  assert.equal(schatLevensduur([600, 125, 480, 240, 130, 0, NaN]), 125)
  assert.equal(moetVernieuwen({ leeftijdMin: 100, schattingMin: null }), false, 'zonder meting nooit vooraf vernieuwen')
  assert.equal(moetVernieuwen({ leeftijdMin: 111, schattingMin: 125 }), true)
  assert.equal(moetVernieuwen({ leeftijdMin: 100, schattingMin: 125 }), false)
})

import { samenvatting } from '../src/runlog.js'

test('ritmonitor-samenvatting: zoals de wachtdogs het verwachten', () => {
  const s = samenvatting(['A', 'B'], {
    A: { ok: 7, maxRijen: 22, leegBevestigd: false, fouten: [] },
    B: { ok: 0, maxRijen: 0, leegBevestigd: false, fouten: ['Planning-menu niet zichtbaar'] },
  })
  assert.equal(s.status, 'deels_mislukt')
  assert.deepEqual(s.lezingen, { A: 7, B: 0 })
  assert.deepEqual(s.leeg_onbevestigd, ['B'])
  assert.deepEqual(s.depots_mislukt, [{ depot: 'B', fout: 'Planning-menu niet zichtbaar' }])
  assert.equal(samenvatting(['A'], {}), null, 'geen lezingen = geen rij (ritmonitor niet actief)')
  const leeg = samenvatting(['A'], { A: { ok: 7, maxRijen: 0, leegBevestigd: true, fouten: [] } })
  assert.deepEqual(leeg.leeg_onbevestigd, [], 'lege lijst bevestigd door PostNL is normaal ( #357 )')
})
