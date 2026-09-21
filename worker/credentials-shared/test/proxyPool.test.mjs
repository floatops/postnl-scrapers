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
