// Lokale proef van de browserkant van de sessiehouder (floatops/matransport#562), zonder PostNL:
// een nagemaakt portaal met login, Planning-menu, sessie-verlopen en "eruit gegooid".
// Controleert met een echte Chromium: inloggen, trace-chunks per taak, video bij sluiten,
// contextwissel met dezelfde cookies, en wat classificeer() ziet bij verlopen en gegooid.
//   node scripts/proef-lokaal.mjs   (vraagt geen geheimen, schrijft alleen naar een tijdelijke map)
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs/promises'
import assert from 'node:assert/strict'
import { chromium } from 'playwright'
process.env.OPNAME_ROOT = await fs.mkdtemp(path.join(os.tmpdir(), 'opnames-'))
const { Sessie } = await import('../src/sessie.js')
import { classificeer } from '../src/gezondheid.js'
import { mergeInstellingen } from '../src/instellingen.js'
import { SEL_PLANNING, opStartpagina } from '../../credentials-shared/src/postnl/login.js'

const sessies = new Set()
let gegooid = false
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
const opslag = { sessieStart: async () => 'sessie-1', sessieBij: async (id, v) => { opslag.laatst = v } }
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
  console.log('✔ trace-chunk per taak: geslaagd → latest, incident → fout/')

  const nogIngelogd = await s.nieuwSegment()
  assert.equal(nogIngelogd, true, 'contextwissel met dezelfde cookies blijft ingelogd')
  assert.ok((await opnames()).some(u => /video-/.test(u.pad) && u.pad.endsWith('.webm')), 'video van het vorige segment opgeslagen')
  console.log('✔ nieuw videosegment zonder nieuwe login, vorige video opgeslagen')

  gegooid = true
  await s.page.reload()
  const planning = await s.page.locator(SEL_PLANNING).first().isVisible()
  assert.equal(planning, true, 'menu blijft zichtbaar, zoals bij PostNL')
  assert.equal(classificeer({ url: s.page.url(), depotHost: s.depotHost, planningZichtbaar: planning, opStartpagina: await opStartpagina(s.page) }), 'gegooid')
  gegooid = false
  console.log('✔ eruit gegooid (startpagina met menu, zoals gemeten) herkend')

  sessies.clear()
  await s.page.goto(url)
  assert.equal(classificeer({ url: s.page.url(), depotHost: s.depotHost, fout: new Error('menu weg') }), 'verlopen')
  console.log('✔ verlopen sessie (naar loginpagina) herkend')

  await s.sluiten('verlopen')
  assert.equal(opslag.laatst.einde_reden, 'verlopen')
  assert.ok((await opnames()).some(u => /\/fout\/video-/.test(u.pad)), 'video van een incident naar fout/')
  console.log('✔ sluiten: reden vastgelegd, video naar fout/')
  console.log('Opnames op schijf:', (await opnames()).map(u => `${u.pad.split('/').slice(-2).join('/')} (${u.kb} kB)`).join(', '))
} finally {
  await s.sluiten('herstart').catch(() => {})
  server.close()
}
