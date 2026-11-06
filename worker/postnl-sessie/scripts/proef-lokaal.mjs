// Lokale proef van de browserkant van de sessiehouder (floatops/matransport#562), zonder PostNL:
// een nagemaakt portaal met login, Planning-menu, sessie-verlopen en "eruit gegooid".
// Controleert met een echte Chromium: inloggen, trace-chunks per taak, video bij sluiten,
// contextwissel met dezelfde cookies, en wat classificeer() ziet bij verlopen en gegooid.
//   node scripts/proef-lokaal.mjs   (vraagt geen geheimen, schrijft alleen naar een tijdelijke map)
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
process.env.OPNAME_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'opnames-'))
// Eigen werkmap, en de playwright-mappen van een draaiende sessiehouder tellen niet mee: de proef
// draait op de VPS naast de echte (matransport#600).
process.env.SESSIE_WERK_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'proef-werk-'))
process.on('exit', () => { for (const m of [process.env.OPNAME_ROOT, process.env.SESSIE_WERK_ROOT]) fsSync.rmSync(m, { recursive: true, force: true }) })
const artifactsVooraf = new Set((await fs.readdir(os.tmpdir())).filter(n => n.startsWith('playwright-artifacts-')))
const { Sessie } = await import('../src/sessie.js')
import { classificeer } from '../src/gezondheid.js'
import { mergeInstellingen } from '../src/instellingen.js'
import { SEL_PLANNING, opStartpagina, login } from '../../credentials-shared/src/postnl/login.js'
import { volgMendix, LEZEN_MS } from '../../postnl-planner/src/mendix.js'
import { metLimiet, handlerKlaar } from '../src/depot.js'

const sessies = new Set()
let gegooid = false
let intrekken = false   // fout 460 zoals PostNL op 05-11 (matransport#598)
let hangen = false      // PostNL antwoordt niet (05-11 12:32: laadbalk van minuten, matransport#599)
const server = http.createServer((req, res) => {
  const cookie = /sess=(\w+)/.exec(req.headers.cookie ?? '')?.[1]
  const geldig = cookie && sessies.has(cookie)
  if (req.url.startsWith('/login') && req.method === 'POST') {
    const id = Math.random().toString(36).slice(2)
    sessies.add(id)
    res.writeHead(302, { 'Set-Cookie': `sess=${id}; Path=/`, Location: '/index.html' }); return res.end()
  }
  if (req.url.startsWith('/login')) {
    res.writeHead(200, { 'Content-Type': 'text/html' })
    return res.end('<form method="post" action="/login"><input type="text"><input type="password"><button data-trn-key="login.butlogin">Inloggen</button></form>')
  }
  if (req.url.startsWith('/xas/')) {
    if (hangen) return   // nooit antwoorden
    if (intrekken) { res.writeHead(460); return res.end() }
    res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"objects":[]}')
  }
  if (req.url.startsWith('/index.html')) {
    if (!geldig) { res.writeHead(302, { Location: '/login?goto=index' }); return res.end() }
    res.writeHead(200, { 'Content-Type': 'text/html' })
    // "Eruit gegooid": PostNL zet de sessie terug naar de startpagina, zonder menu.
    // Zoals gemeten op 02-11: het menu blijft, het scherm wordt de startpagina met "OOM PD Proces".
    const menu = '<a class="mx-name-menuBar1-2" title="Planning" href="#">Planning</a>'
    return res.end(gegooid ? menu + '<div>Homepage</div><span>OOM PD Proces</span>' : menu + '<select class="form-control"><option>02-11-2026</option></select>')
  }
  res.writeHead(404); res.end()
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/index.html`

const supabase = {}
async function opnames() {
  const uit = []
  const loop = async (d) => { for (const n of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) { const p = path.join(d, n.name); if (n.isDirectory()) await loop(p); else uit.push({ pad: p.split(path.sep).join('/'), kb: Math.round((await fs.stat(p)).size / 1024) }) } }
  await loop(process.env.OPNAME_ROOT)
  return uit
}
// Zoals de database: postnl_sessies.herlogins is integer not null (#599: in 33f0ae9 ging er een lijst heen).
const opslag = {
  sessieStart: async () => 'sessie-1',
  sessieBij: async (id, v) => {
    if ('herlogins' in v) assert.ok(Number.isInteger(v.herlogins), `herlogins moet een getal zijn, kreeg ${JSON.stringify(v.herlogins)}`)
    opslag.laatst = v
  },
  gebeurtenis: async (id, g) => { (opslag.gebeurtenissen ??= []).push(g) },
}
const depot = { naam: 'Proefdepot', url, username: 'u', password: 'p' }
const s = new Sessie({ depot, klantId: 'k', supabase, chromium, opslag, cfg: mergeInstellingen({}), log: { log() {}, warn: console.warn, error: console.error } })

try {
  await s.openen()
  assert.equal(await s.page.locator(SEL_PLANNING).first().isVisible(), true, 'ingelogd, menu zichtbaar')
  console.log('✔ inloggen via de loginpagina, Planning-menu zichtbaar')

  await s.taakBegin('ritmonitor')
  await s.page.reload()
  const pad1 = await s.taakEinde('ritmonitor')
  assert.match(pad1.split(path.sep).join('/'),/proefdepot\/trace-ritmonitor-latest\.zip$/)
  await s.taakBegin('ritmonitor')
  await s.page.reload()
  const pad2 = await s.taakEinde('ritmonitor', { incident: true })
  assert.match(pad2.split(path.sep).join('/'),/proefdepot\/fout\/trace-ritmonitor-/)
  console.log('✔ trace per taak: geslaagd → latest, incident → fout/')

  // Twintig taken achter elkaar: de werkmap groeit niet, en elke trace blijft even klein. Met
  // chunks kwam er per taak een volledige kopie van het netwerklog bij (06-11, matransport#600).
  const rest = async () => (await fs.readdir(s.tracesDir)).filter(n => n !== 'resources')
  const groottes = []
  for (let i = 0; i < 20; i++) {
    await s.taakBegin('ritmonitor')
    await s.page.reload()
    const p = await s.taakEinde('ritmonitor')
    groottes.push((await fs.stat(p)).size)
    assert.deepEqual(await rest(), [], 'na elke taak staat er niets meer los in de trace-map')
  }
  assert.ok(groottes.at(-1) < groottes[0] * 2, `trace groeit niet mee: ${groottes[0]} → ${groottes.at(-1)} bytes`)
  const uitTrace = await fs.readdir(os.tmpdir()).then(n => n.filter(x => x.startsWith('playwright-artifacts-') && !artifactsVooraf.has(x)))
  for (const n of uitTrace) {
    const inhoud = await fs.readdir(path.join(os.tmpdir(), n)).catch(() => [])
    assert.ok(!inhoud.some(f => /-pwnetcopy-|\.trace$/.test(f)), 'niets meer in playwright-artifacts')
  }
  console.log(`✔ 20 taken: trace-map leeg na elke taak, trace blijft klein (${groottes[0]} → ${groottes.at(-1)} bytes)`)

  // Een trace die bleef lopen (bv. stoppen mislukte) mag de volgende taak niet blokkeren.
  await s.taakBegin('ritmonitor')
  s.traceLoopt = false
  await s.taakBegin('ritmonitor')
  assert.equal(s.traceLoopt, true, 'opnieuw gestart na een achtergebleven trace')
  assert.ok(await s.taakEinde('ritmonitor'))
  console.log('✔ achtergebleven trace: gestopt en opnieuw gestart')

  const nogIngelogd = await s.nieuwSegment()
  assert.equal(nogIngelogd, true, 'contextwissel met dezelfde cookies blijft ingelogd')
  assert.ok((await opnames()).some(u => /video-/.test(u.pad) && u.pad.endsWith('.webm')), 'video van het vorige segment opgeslagen')
  assert.deepEqual(await fs.readdir(s.tracesDir), [], 'na de contextwissel is de trace-map helemaal leeg')
  await s.taakBegin('ritmonitor')
  await s.page.reload()
  assert.ok(await s.taakEinde('ritmonitor'), 'trace werkt ook in de nieuwe context')
  console.log('✔ nieuw videosegment zonder nieuwe login, vorige video opgeslagen, trace-map leeg')

  // Over de limiet: een handler die op een Playwright-aanroep hangt, stopt zodra de context dichtgaat.
  {
    const hangend = s.page.waitForSelector('#bestaat-nooit', { timeout: 0 }).then(() => 'klaar', () => 'gestopt')
    assert.equal(await handlerKlaar(hangend, ms => new Promise(r => setTimeout(r, ms)), 200), false, 'hij hangt echt')
    assert.equal(await s.nieuwSegment(), true)
    assert.equal(await handlerKlaar(hangend, ms => new Promise(r => setTimeout(r, ms)), 5000), true, 'context dicht: de aanroep faalt meteen')
    console.log('✔ storing: taak over de limiet stopt zodra de context dichtgaat, geen nieuwe login')
  }

  gegooid = true
  await s.page.reload()
  const planning = await s.page.locator(SEL_PLANNING).first().isVisible()
  assert.equal(planning, true, 'menu blijft zichtbaar, zoals bij PostNL')
  assert.equal(classificeer({ url: s.page.url(), depotHost: s.depotHost, planningZichtbaar: planning, opStartpagina: await opStartpagina(s.page) }), 'gegooid')
  gegooid = false
  console.log('✔ eruit gegooid (startpagina met menu, zoals gemeten) herkend')

  // Fout 460 midden in een taak (matransport#598): geteld per taak en per uur, en herkend als
  // stille her-login in plaats van "gegooid".
  await s.taakBegin('ritmonitor')
  await s.page.evaluate(() => fetch('/xas/', { method: 'POST' }))
  await s.page.waitForTimeout(300)
  assert.equal(s.herloginTaak, 0, 'gewoon antwoord telt niet')
  intrekken = true
  await s.page.evaluate(() => fetch('/xas/', { method: 'POST' }).catch(() => {}))
  await s.page.waitForTimeout(300)
  intrekken = false
  assert.equal(s.herloginTaak, 1, '460 geteld in deze taak')
  assert.equal(s.fouten460.length, 1, 'en in het uurtotaal')
  assert.equal(classificeer({ url: s.page.url(), depotHost: s.depotHost, fout: new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation'), herlogin: s.herloginTaak }), 'herlogin')
  await s.taakEinde('ritmonitor')
  await s.taakBegin('ritmonitor')
  assert.equal(s.herloginTaak, 0, 'nieuwe taak: telling per taak weer 0')
  await s.taakEinde('ritmonitor')
  console.log('✔ fout 460 geteld (per taak en per uur) en herkend als stille her-login')

  // ---- Storingsproef (matransport#599): wat er op 05-11 gebeurde, met een echte browser ----
  // 1. Blok fouten 460 + herladen midden in een actie: actie() mag nooit blijven hangen.
  {
    await s.taakBegin('plannen')
    const m = volgMendix(s.page)
    const begin = Date.now()
    await m.actie(async () => {
      intrekken = true
      await s.page.evaluate(() => { fetch('/xas/', { method: 'POST' }).catch(() => {}); fetch('/xas/', { method: 'POST' }).catch(() => {}) })
      await s.page.waitForTimeout(200)
      intrekken = false
      await s.page.reload()   // zoals Mendix na een 460 de app opnieuw start
    }, 30_000).catch(() => {})
    const duur = Date.now() - begin
    assert.ok(duur < LEZEN_MS + 10_000, `actie hing ${duur} ms na 460 + herladen`)
    assert.ok(s.herloginTaak >= 2, '460s geteld')
    await s.taakEinde('plannen')
    console.log(`✔ storing: blok fouten 460 + herladen midden in een actie, klaar na ${Math.round(duur / 1000)} s (geteld: ${s.herloginTaak})`)
  }
  // 2. PostNL hangt: een verzoek dat nooit antwoordt houdt de taak niet langer vast dan zijn grens.
  {
    hangen = true
    const m = volgMendix(s.page)
    const begin = Date.now()
    const uitkomst = await metLimiet(m.actie(async () => { await s.page.evaluate(() => { fetch('/xas/', { method: 'POST' }).catch(() => {}) }) }, 3_000), 15_000, 'plannen')
      .then(() => 'klaar', (e) => e.message)
    hangen = false
    assert.ok(Date.now() - begin < 15_000, 'wacht() gaf op binnen zijn eigen grens, niet pas bij de taaklimiet')
    assert.match(uitkomst, /reageerde niet binnen de wachttijd|klaar/)
    console.log(`✔ storing: PostNL hangt, wacht() geeft na ${Math.round((Date.now() - begin) / 1000)} s op (${uitkomst})`)
    await s.page.reload()
  }

  sessies.clear()
  await s.page.goto(url)
  assert.equal(classificeer({ url: s.page.url(), depotHost: s.depotHost, fout: new Error('menu weg') }), 'verlopen')
  console.log('✔ verlopen sessie (naar loginpagina) herkend')

  // Her-login in hetzelfde tabblad, daarna een 460 (#599): in 33f0ae9 deelden de teller van
  // her-logins en de lijst met 460's één naam. Dan crashte de listener, en ging er een lijst naar
  // de database. Nu: teller blijft een getal, de 460 wordt gewoon geteld.
  await login(s.page, depot, { log: { log() {}, warn() {}, error: console.error } })
  assert.equal(s.herlogins, 1, 'her-login in hetzelfde tabblad geteld')
  assert.ok(opslag.gebeurtenissen?.some(g => g.soort === 'sessie_verlopen'), 'meting sessie_verlopen vastgelegd')
  await s.taakBegin('ritmonitor')
  intrekken = true
  await s.page.evaluate(() => fetch('/xas/', { method: 'POST' }).catch(() => {}))
  await s.page.waitForTimeout(300)
  intrekken = false
  await s.taakEinde('ritmonitor')
  assert.equal(s.herloginTaak, 1, '460 na een her-login gewoon geteld, geen crash')
  console.log('✔ her-login in hetzelfde tabblad en daarna een 460: geteld, geen crash')

  await s.sluiten('verlopen')
  assert.equal(opslag.laatst.herlogins, 1, 'aantal her-logins als getal naar de database')
  assert.equal(opslag.laatst.einde_reden, 'verlopen')
  assert.ok((await opnames()).some(u => /\/fout\/video-/.test(u.pad)), 'video van een incident naar fout/')
  await assert.rejects(fs.stat(s.werkMap), 'werkmap weg na sluiten')
  console.log('✔ sluiten: reden vastgelegd, video naar fout/, werkmap weg')
  // 3. Crash midden in een taak: de browser valt weg terwijl de taak loopt.
  {
    const s2 = new Sessie({ depot, klantId: 'k', supabase, chromium, opslag, cfg: mergeInstellingen({}), log: { log() {}, warn() {}, error: console.error } })
    await s2.openen()
    await s2.taakBegin('ritmonitor')
    const taak = s2.page.evaluate(() => new Promise(() => {}))   // loopt eindeloos
    setTimeout(() => s2.browser.close().catch(() => {}), 300)
    const fout = await metLimiet(taak, 15_000, 'ritmonitor').then(() => null, e => e)
    assert.equal(classificeer({ url: '', depotHost: s2.depotHost, fout }), 'browser_weg', `crash herkend (${String(fout?.message).split('\n')[0]})`)
    await s2.sluiten('browser_weg')
    assert.equal(opslag.laatst.einde_reden, 'browser_weg', 'sessierij netjes afgesloten na de crash')
    console.log('✔ storing: crash midden in een taak herkend als browser_weg, sessie netjes dicht')
  }
  console.log('Opnames op schijf:', (await opnames()).map(u => `${u.pad.split('/').slice(-2).join('/')} (${u.kb} kB)`).join(', '))
} finally {
  await s.sluiten('herstart').catch(() => {})
  server.close()
}
