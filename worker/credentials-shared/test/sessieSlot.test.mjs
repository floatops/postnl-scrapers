// node --test — wachten op en vrijgeven van het PostNL-sessieslot (floatops/matransport#361).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pakSessieSlot, slotSleutel } from '../src/sessieSlot.js'

function nepSupabase(antwoorden) {
  const aanroepen = []
  return {
    aanroepen,
    rpc: async (naam, args) => {
      aanroepen.push({ naam, args })
      return naam === 'postnl_sessie_pak' ? antwoorden.shift() : { data: null, error: null }
    },
  }
}
const stil = fn => async () => {
  const o = { log: console.log, warn: console.warn }
  console.log = console.warn = () => {}
  try { await fn() } finally { Object.assign(console, o) }
}

test('sleutel is klant + depot', () => {
  assert.equal(slotSleutel('k1', 'Den Hoorn'), 'k1:Den Hoorn')
})

test('vrij slot: direct gekregen, los geeft het met dezelfde houder vrij', stil(async () => {
  const sb = nepSupabase([{ data: true, error: null }])
  const slot = await pakSessieSlot(sb, { klantId: 'k1', depot: 'Den Hoorn', worker: 'w', seconden: 60, maxWachtMs: 10_000 })
  assert.equal(slot.gekregen, true)
  await slot.los()
  assert.equal(sb.aanroepen[1].naam, 'postnl_sessie_los')
  assert.equal(sb.aanroepen[1].args.p_houder, sb.aanroepen[0].args.p_houder)
  assert.equal(sb.aanroepen[1].args.p_sleutel, 'k1:Den Hoorn')
}))

test('bezet slot: wacht en krijgt het daarna', stil(async () => {
  const sb = nepSupabase([{ data: false, error: null }, { data: true, error: null }])
  const slot = await pakSessieSlot(sb, { klantId: 'k1', depot: 'D', worker: 'w', seconden: 60, maxWachtMs: 10_000 })
  assert.equal(slot.gekregen, true)
  assert.equal(sb.aanroepen.filter(a => a.naam === 'postnl_sessie_pak').length, 2)
}))

test('functie ontbreekt (omgeving zonder migratie): door zonder slot', stil(async () => {
  const sb = nepSupabase([{ data: null, error: { message: 'function postnl_sessie_pak does not exist' } }])
  const slot = await pakSessieSlot(sb, { klantId: 'k1', depot: 'D', worker: 'w', seconden: 60, maxWachtMs: 10_000 })
  assert.equal(slot.gekregen, false)
  await slot.los() // no-op
  assert.equal(sb.aanroepen.length, 1)
}))

test('te lang bezet: na maxWachtMs door zonder slot', stil(async () => {
  const sb = nepSupabase([{ data: false, error: null }])
  const slot = await pakSessieSlot(sb, { klantId: 'k1', depot: 'D', worker: 'w', seconden: 60, maxWachtMs: 1000 })
  assert.equal(slot.gekregen, false)
}))
