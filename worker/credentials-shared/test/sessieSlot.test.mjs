// node --test — wachten op en vrijgeven van het PostNL-sessieslot (floatops/matransport#361).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { pakSessieSlot, slotSleutel, sessiehouderHeeftAlles, isSessiehouder } from '../src/sessieSlot.js'

function nepSupabase(antwoorden, houder = null) {
  const aanroepen = []
  return {
    aanroepen,
    rpc: async (naam, args) => {
      aanroepen.push({ naam, args })
      if (naam === 'postnl_sessie_info') return { data: houder ? [{ houder, tot: new Date().toISOString() }] : [], error: null }
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

test('te lang bezet: overslaan, nooit door zonder slot (#562)', stil(async () => {
  const sb = nepSupabase([{ data: false, error: null }])
  const slot = await pakSessieSlot(sb, { klantId: 'k1', depot: 'D', worker: 'w', seconden: 60, maxWachtMs: 1000 })
  assert.equal(slot.gekregen, false)
  assert.equal(slot.bezet, true)
}))

test('vangnet-script wijkt meteen voor de sessiehouder; de planner wacht wel', stil(async () => {
  const vangnet = nepSupabase([{ data: false, error: null }], 'postnl-sessie:123:abcd')
  const slot = await pakSessieSlot(vangnet, { klantId: 'k1', depot: 'D', worker: 'postnl-ritmonitor', seconden: 60, maxWachtMs: 60_000, wijkVoorSessiehouder: true })
  assert.equal(slot.overgenomen, true)
  assert.equal(vangnet.aanroepen.filter(a => a.naam === 'postnl_sessie_pak').length, 1, 'niet blijven wachten')
  const planner = nepSupabase([{ data: false, error: null }, { data: true, error: null }], 'postnl-sessie:123:abcd')
  const p = await pakSessieSlot(planner, { klantId: 'k1', depot: 'D', worker: 'postnl-planner', seconden: 60, maxWachtMs: 10_000 })
  assert.equal(p.gekregen, true, 'planner wacht tot de sessiehouder het slot vrijgeeft')
}))

test('sessiehouderHeeftAlles: alleen als elk depot van de sessiehouder is; de meting telt niet', async () => {
  assert.equal(await sessiehouderHeeftAlles(nepSupabase([], 'postnl-sessie:1:a'), 'k1', ['A', 'B']), true)
  assert.equal(await sessiehouderHeeftAlles(nepSupabase([], 'postnl-ritmonitor:1:a'), 'k1', ['A']), false)
  assert.equal(await sessiehouderHeeftAlles(nepSupabase([], null), 'k1', ['A']), false)
  assert.equal(await sessiehouderHeeftAlles(nepSupabase([], 'postnl-sessie:1:a'), 'k1', []), false)
  assert.equal(isSessiehouder('postnl-sessie-meting:1:a'), false)
})
