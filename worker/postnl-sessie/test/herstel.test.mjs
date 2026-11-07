// node --test — sessie gezond, verlopen, eruit gegooid of geblokkeerd, en wat de sessiehouder dan
// doet; plus de levensduur-meting (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { classificeer, herstel, isLoginUrl } from '../src/gezondheid.js'
import { schatLevensduur, moetVernieuwen } from '../src/levensduur.js'
import { mergeInstellingen as mergeInstellingenEcht } from '../src/instellingen.js'

// De taak 'gisteren' (nalezen van de vorige werkdag) heeft eigen tests; hier staat hij uit.
const mergeInstellingen = (c = {}, ...rest) => mergeInstellingenEcht({ gisterenNalezen: false, ...c }, ...rest)

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
  // Meting 02-11: een andere sessie werkt in Mendix, deze staat op de startpagina, menu wel zichtbaar.
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, planningZichtbaar: true, opStartpagina: true }), 'gegooid', 'teruggezet naar de startpagina')
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, fout: new Error('locator.click: Timeout 10000ms exceeded.'), planningZichtbaar: true, opStartpagina: true }), 'gegooid', 'klik faalt omdat het scherm weg is')
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

test('classificeer: fout 460 tijdens de taak = herlogin, niet gegooid (05-11 Waddinxveen, #598)', () => {
  const herladen = new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation')
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, fout: herladen, herlogin: 1 }), 'herlogin')
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, planningZichtbaar: true, opStartpagina: true, herlogin: 2 }), 'herlogin', 'op de startpagina na de stille her-login')
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, fout: new Error('Taak plannen duurde langer dan 300 s'), herlogin: 1 }), 'herlogin')
  assert.equal(classificeer({ url: `https://${DEPOT}/login.html`, depotHost: DEPOT, fout: new Error('Planning-menu niet zichtbaar'), herlogin: 3 }), 'verlopen', 'stille her-login mislukt: echt inloggen')
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, planningZichtbaar: true, herlogin: 1 }), 'gezond', 'taak gelukt ondanks een 460: niets aan de hand')
  assert.equal(classificeer({ url: depotUrl, depotHost: DEPOT, fout: herladen }), 'gegooid', 'zonder 460 blijft het gegooid')
  assert.equal(herstel('herlogin', { recent: [{ soort: 'herlogin', at: geleden(1) }], nu, cfg }), 'opnieuw_openen', 'nooit een nieuwe login')
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

test('levensduur: pas een schatting vanaf 5 metingen (#598), het 10e percentiel', () => {
  assert.equal(schatLevensduur([120, 130]), null)
  assert.equal(schatLevensduur([49, 150, 300]), null, 'de valse metingen van 04/05-11 plus één: nog geen schatting')
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

// matransport#613 (07-11): de proxy-aanbieder weigert de login (407). Gaat voor alles: het lege scherm
// of de time-out die erbij hoort is daar het gevolg van. Nooit een nieuwe login, ook niet na meer fouten.
test('proxy geweigerd: eigen soort, gaat voor de rest, en het herstel is wachten, nooit inloggen', () => {
  assert.equal(classificeer({ fout: new Error('Planning-menu niet zichtbaar'), proxyGeweigerd: true }), 'proxy_geweigerd')
  assert.equal(classificeer({ url: 'https://www.loginpostnl.net/login', depotHost: DEPOT, fout: new Error('x'), proxyGeweigerd: true }), 'proxy_geweigerd')
  assert.equal(classificeer({ fout: Object.assign(new Error('x'), { name: 'ProxyGeweigerdError' }) }), 'proxy_geweigerd')
  assert.equal(classificeer({ fout: Object.assign(new Error('Proxy liet de verbinding niet door'), { proxyFout: true }) }), 'fout', 'zonder toets is een tunnelfout nog een gewone fout')
  const nu = new Date('2026-11-07T01:30:00Z')
  const recent = [1, 2, 3].map(i => ({ soort: 'fout', at: new Date(nu - i * 60_000) }))
  const logins = [1, 2, 3, 4].map(i => new Date(nu - i * 60_000))
  assert.equal(herstel('proxy_geweigerd', { nu, cfg, recent, logins }), 'proxy_wacht')
})
