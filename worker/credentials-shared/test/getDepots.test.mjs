// node --test — getDepots geeft nooit een gedeeld sessiebestand terug (floatops/matransport#609).
// Het oude pad `.postnl-auth-state-<depot>.json` had geen klant of stack in de naam: twee klanten
// op hetzelfde depot deelden zo één bestand in de gedeelde checkout op de VPS.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encrypt, getDepots } from '../src/index.js'

const KEY = 'b'.repeat(64)

function nepSupabase(rijen) {
  const filters = []
  const q = {
    select: () => q,
    eq: (k, v) => { filters.push([k, v]); return q },
    then: (ok, fout) => Promise.resolve({ data: rijen, error: null }).then(ok, fout),
  }
  return { filters, from: () => q }
}

test('getDepots: storageState altijd null, ook voor twee klanten op hetzelfde depot', async () => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = KEY
  const rij = { id: 'x', depot_naam: 'Den Hoorn', depot_url: 'https://voorbeeld', username: 'u', password_encrypted: encrypt('geheim', KEY) }
  const a = await getDepots(nepSupabase([rij]), 'klant-a', 'postnl')
  const b = await getDepots(nepSupabase([{ ...rij, id: 'y' }]), 'klant-b', 'postnl')
  assert.equal(a[0].storageState, null)
  assert.equal(b[0].storageState, null)
  assert.equal(a[0].password, 'geheim')
})

test('getDepots: filtert op klant, systeem en actief', async () => {
  process.env.CREDENTIALS_ENCRYPTION_KEY = KEY
  const sb = nepSupabase([])
  await getDepots(sb, 'klant-a', 'postnl')
  assert.deepEqual(sb.filters, [['klant_id', 'klant-a'], ['systeem', 'postnl'], ['actief', true]])
})
