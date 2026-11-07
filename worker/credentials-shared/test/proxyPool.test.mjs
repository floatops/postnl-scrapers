// node --test — kiesProxy/sluitProxyAf zonder database (supabase.rpc gestubd).
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { encrypt } from '../src/index.js'
import { kiesProxy, sluitProxyAf, proxyPoolAan, uitkomstBijFout, ProxyBlokkadeError } from '../src/proxyPool.js'

const KEY = 'a'.repeat(64)

function nepSupabase(antwoorden) {
  const aanroepen = []
  return {
    aanroepen,
    rpc: async (naam, args) => { aanroepen.push({ naam, args }); return antwoorden[naam] ?? { data: null, error: null } },
  }
}

beforeEach(() => {
  for (const k of ['PROXY_POOL', 'PROXY_SERVER', 'PROXY_USERNAME', 'PROXY_PASSWORD']) delete process.env[k]
  process.env.CREDENTIALS_ENCRYPTION_KEY = KEY
})

test('pool uit en geen PROXY_SERVER: geen proxy, geen database', async () => {
  const sb = nepSupabase({})
  assert.equal(proxyPoolAan(), false)
  assert.equal(await kiesProxy(sb, { worker: 'w', depot: { naam: 'D' } }), null)
  assert.equal(sb.aanroepen.length, 0)
})

test('pool uit met PROXY_SERVER: oud gedrag, niets gelogd', async () => {
  process.env.PROXY_SERVER = 'http://gw:7000'
  process.env.PROXY_USERNAME = 'u'
  const sb = nepSupabase({})
  const s = await kiesProxy(sb, { worker: 'w', depot: {} })
  assert.deepEqual(s.proxy, { server: 'http://gw:7000', username: 'u' })
  assert.equal(s.gebruikId, null)
  await sluitProxyAf(sb, s, 'ok')
  assert.equal(sb.aanroepen.length, 0)
})

test('pool aan: volgende_proxy met depot, wachtwoord ontsleuteld', async () => {
  process.env.PROXY_POOL = 'true'
  const sb = nepSupabase({ volgende_proxy: { data: [{
    host: 'isp.decodo.com', poort: 10003, gebruikersnaam: 'usr',
    wachtwoord_encrypted: encrypt('geheim', KEY), extern_ip: '1.2.3.4', gebruik_id: 42,
  }], error: null } })
  const s = await kiesProxy(sb, { worker: 'postnl-ritmonitor', depot: { id: 'c1', naam: 'Den Hoorn' } })
  assert.deepEqual(s.proxy, { server: 'http://isp.decodo.com:10003', username: 'usr', password: 'geheim' })
  assert.equal(s.gebruikId, 42)
  assert.deepEqual(sb.aanroepen[0], { naam: 'volgende_proxy', args: { p_credential_id: 'c1', p_worker: 'postnl-ritmonitor', p_depot: 'Den Hoorn' } })
})

test('pool aan en lege pool: harde fout, geen stille terugval', async () => {
  process.env.PROXY_POOL = 'true'
  const sb = nepSupabase({ volgende_proxy: { data: null, error: { message: 'Geen bruikbare proxy in de pool' } } })
  await assert.rejects(kiesProxy(sb, { worker: 'w', depot: {} }), /Geen proxy uit de pool/)
})

test('sluitProxyAf stuurt uitkomst en eerste regel van de fout', async () => {
  const sb = nepSupabase({})
  await sluitProxyAf(sb, { gebruikId: 7 }, 'fout', 'regel 1\nstack...')
  assert.deepEqual(sb.aanroepen[0], { naam: 'proxy_gebruik_afsluiten', args: { p_gebruik_id: 7, p_uitkomst: 'fout', p_detail: 'regel 1' } })
})

test('uitkomstBijFout: ProxyBlokkadeError is altijd blokkade', async () => {
  assert.equal(await uitkomstBijFout(new ProxyBlokkadeError('x'), null), 'blokkade')
  assert.equal(await uitkomstBijFout(new Error('x'), null), 'fout')
})

// matransport#613 (07-11): Decodo weigerde na een mislukte betaling elke login met 407. toetsProxy
// ziet dat met één CONNECT, zonder browser en zonder PostNL. Hier tegen een nep-proxy op localhost.
async function nepProxy(status) {
  const http = await import('node:http')
  const server = http.createServer((req, res) => { res.writeHead(400); res.end() })
  const gezien = []
  server.on('connect', (req, socket) => {
    gezien.push({ doel: req.url, auth: req.headers['proxy-authorization'] ?? null })
    socket.end(status === 407
      ? 'HTTP/1.1 407 Unauthorized\r\nProxy-Authenticate: Basic realm="Smartproxy"\r\nContent-Length: 0\r\n\r\n'
      : `HTTP/1.1 ${status} OK\r\n\r\n`)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  return { server, gezien, server_: `http://127.0.0.1:${server.address().port}` }
}

test('toetsProxy: 407 van de aanbieder = geweigerd, met de login in Proxy-Authorization', async () => {
  const { toetsProxy } = await import('../src/proxyPool.js')
  const p = await nepProxy(407)
  try {
    const uit = await toetsProxy({ server: p.server_, username: 'gebruiker', password: 'geheim' })
    assert.deepEqual(uit, { status: 407, geweigerd: true, fout: null })
    assert.equal(p.gezien[0].doel, 'ip.decodo.com:443')
    assert.equal(p.gezien[0].auth, 'Basic ' + Buffer.from('gebruiker:geheim').toString('base64'))
  } finally { p.server.close() }
})

test('toetsProxy: 200 = de proxy werkt; niet bereikbaar of geen proxy = niet geweigerd (dus geen wachtstand)', async () => {
  const { toetsProxy } = await import('../src/proxyPool.js')
  const p = await nepProxy(200)
  try {
    assert.deepEqual(await toetsProxy({ server: p.server_, username: 'g', password: 'w' }), { status: 200, geweigerd: false, fout: null })
  } finally { p.server.close() }
  const dicht = await toetsProxy({ server: 'http://127.0.0.1:1' }, { ms: 3_000 })
  assert.equal(dicht.geweigerd, false)
  assert.ok(dicht.fout, 'de netwerkfout staat erbij')
  assert.deepEqual(await toetsProxy(null), { status: null, geweigerd: false, fout: 'geen proxy' })
})

test('toetsProxy: een proxy die niets zegt, houdt het nooit langer op dan de grens', async () => {
  const { toetsProxy } = await import('../src/proxyPool.js')
  const net = await import('node:net')
  const stil = net.createServer(() => {})   // neemt de verbinding aan en zwijgt
  await new Promise(r => stil.listen(0, '127.0.0.1', r))
  try {
    const begin = Date.now()
    const uit = await toetsProxy({ server: `http://127.0.0.1:${stil.address().port}` }, { ms: 300 })
    assert.deepEqual(uit, { status: null, geweigerd: false, fout: 'timeout' })
    assert.ok(Date.now() - begin < 2_000)
  } finally { stil.close() }
})

test('PROXY_NETWERKFOUT herkent de foutcode van Chromium bij een geweigerde tunnel (gemeten 07-11)', async () => {
  const { PROXY_NETWERKFOUT } = await import('../src/proxyPool.js')
  assert.ok(PROXY_NETWERKFOUT.test('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED at https://pnl-rva.p15.cldsvc.net/'))
  assert.ok(PROXY_NETWERKFOUT.test('net::ERR_PROXY_CONNECTION_FAILED'))
  assert.ok(!PROXY_NETWERKFOUT.test('page.goto: Timeout 60000ms exceeded'))
  assert.ok(!PROXY_NETWERKFOUT.test('net::ERR_CONNECTION_RESET'))
})

test('huidigeProxy: dezelfde keuze als volgende_proxy, alleen lezen; zonder pool of bruikbare rij null', async () => {
  const { huidigeProxy } = await import('../src/proxyPool.js')
  const aanroepen = []
  const keten = (rijen, error = null) => {
    const k = {
      select: () => k, eq: (a, b) => { aanroepen.push([a, b]); return k }, order: () => k,
      limit: async () => ({ data: rijen, error }),
    }
    return { from: () => k, rpc: () => { throw new Error('mag de rij niet opschuiven') } }
  }
  const rij = { host: 'isp.decodo.com', poort: 10005, gebruikersnaam: 'u', wachtwoord_encrypted: encrypt('geheim', KEY) }
  assert.equal(await huidigeProxy(keten([rij])), null, 'pool uit')
  process.env.PROXY_POOL = 'true'
  assert.deepEqual(await huidigeProxy(keten([rij])), { server: 'http://isp.decodo.com:10005', username: 'u', password: 'geheim' })
  assert.deepEqual(aanroepen, [['status', 'actief'], ['laatste_check_ok', true]])
  assert.equal(await huidigeProxy(keten([])), null, 'niets bruikbaars')
  await assert.rejects(huidigeProxy(keten(null, { message: 'kapot' })), /kapot/)
})

// Gemeten op de echte Decodo: met domcontentloaded blijft goto hangen tot zijn time-out.
test('gaNaarMetProxyControle: 407 gooit meteen terwijl goto nog hangt, ook met stil; luisteraar weg', async () => {
  const { gaNaarMetProxyControle } = await import('../src/proxyPool.js')
  const { EventEmitter } = await import('node:events')
  const page = new EventEmitter()
  page.goto = () => new Promise(() => {})   // hangt, zoals domcontentloaded bij een 407
  setTimeout(() => page.emit('response', { status: () => 200 }), 5)
  setTimeout(() => page.emit('response', { status: () => 407 }), 20)
  await assert.rejects(gaNaarMetProxyControle(page, 'https://x/', { stil: true }), { name: 'ProxyGeweigerdError' })
  assert.equal(page.listenerCount('response'), 0)
  page.goto = async () => { throw new Error('page.goto: Timeout 60000ms exceeded.') }
  await assert.rejects(gaNaarMetProxyControle(page, 'https://x/', {}), /Timeout/, 'een andere fout gaat gewoon door')
  assert.equal(await gaNaarMetProxyControle(page, 'https://x/', { stil: true }), null, 'stil: net als .catch(() => null)')
  const antwoord = { status: () => 200 }
  page.goto = async () => antwoord
  assert.equal(await gaNaarMetProxyControle(page, 'https://x/', {}), antwoord)
})

// Gemeten met een echte Chromium (proef-lokaal): goto gooit niet bij een 407, hij geeft een response.
test('gooiBijProxyWeigering: alleen een response met status 407', async () => {
  const { gooiBijProxyWeigering } = await import('../src/proxyPool.js')
  assert.throws(() => gooiBijProxyWeigering({ status: () => 407 }), { name: 'ProxyGeweigerdError' })
  for (const r of [null, undefined, { status: () => 200 }, { status: () => 403 }]) assert.doesNotThrow(() => gooiBijProxyWeigering(r))
})
