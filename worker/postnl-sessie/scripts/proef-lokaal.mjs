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
import { Sessie } from '../src/sessie.js'
import { classificeer } from '../src/gezondheid.js'
import { mergeInstellingen } from '../src/instellingen.js'
import { SEL_PLANNING } from '../../credentials-shared/src/postnl/login.js'

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
    return res.end(gegooid ? '<h1>Homepage</h1>' : '<a class="mx-name-menuBar1-2" title="Planning" href="#">Planning</a><select class="form-control"><option>02-11-2026</option></select>')
  }
  res.writeHead(404); res.end()
})
await new Promise(r => server.listen(0, '127.0.0.1', r))
const url = `http://127.0.0.1:${server.address().port}/index.html`

const uploads = []
const supabase = { storage: { from: () => ({ upload: async (pad, buf) => { uploads.push({ pad, kb: Math.round(buf.length / 1024) }); return { error: null } }, list: async () => ({ data: [] }), remove: async () => ({}) }) } }
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
  assert.match(pad1, /trace\/proefdepot-ritmonitor-latest\.zip$/)
  await s.taakBegin('ritmonitor')
  await s.page.reload()
  const pad2 = await s.taakEinde('ritmonitor', { incident: true })
  assert.match(pad2, /trace\/fout\/proefdepot-ritmonitor-/)
  console.log('✔ trace-chunk per taak: geslaagd → latest, incident → fout/')

  const nogIngelogd = await s.nieuwSegment()
  assert.equal(nogIngelogd, true, 'contextwissel met dezelfde cookies blijft ingelogd')
  assert.ok(uploads.some(u => /postnl-sessie\/proefdepot-latest\.webm$/.test(u.pad) || /postnl-sessie\/fout\//.test(u.pad)), 'video van het vorige segment opgeslagen')
  console.log('✔ nieuw videosegment zonder nieuwe login, vorige video opgeslagen')

  gegooid = true
  await s.page.reload()
  const planning = await s.page.locator(SEL_PLANNING).first().isVisible()
  assert.equal(classificeer({ url: s.page.url(), depotHost: s.depotHost, planningZichtbaar: planning, fout: new Error('menu weg') }), 'gegooid')
  gegooid = false
  console.log('✔ eruit gegooid (startpagina zonder menu) herkend')

  sessies.clear()
  await s.page.goto(url)
  assert.equal(classificeer({ url: s.page.url(), depotHost: s.depotHost, fout: new Error('menu weg') }), 'verlopen')
  console.log('✔ verlopen sessie (naar loginpagina) herkend')

  await s.sluiten('verlopen')
  assert.equal(opslag.laatst.einde_reden, 'verlopen')
  assert.ok(uploads.some(u => /postnl-sessie\/fout\/proefdepot-/.test(u.pad) && u.pad.endsWith('.webm')), 'video van een incident naar fout/')
  console.log('✔ sluiten: reden vastgelegd, video naar fout/')
  console.log('Uploads:', uploads.map(u => `${u.pad.split('/').slice(-2).join('/')} (${u.kb} kB)`).join(', '))
} finally {
  await s.sluiten('herstart').catch(() => {})
  server.close()
}
