// node --test — PostNL-chauffeurs per klant naar postnl_chauffeurs (floatops/matransport#713).
// Geen echte namen: deze repo is publiek.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chauffeursUitRitten, chauffeursUitKeuzes, chauffeursTeSchrijven, bewaarChauffeurs, VERVERS_MS } from '../src/postnl/chauffeurs.js'

const NU = '2026-11-13T10:00:00.000Z'
const eerder = (ms) => new Date(Date.parse(NU) - ms).toISOString()

test('chauffeursUitRitten: id en naam samen, uniek op id, zonder lege', () => {
  const ritten = [
    { velden: { postnl_chauffeur: 'Test, A.', postnl_chauffeur_id: '1' } },
    { velden: { postnl_chauffeur: 'Test, A.', postnl_chauffeur_id: '1' } },
    { velden: { postnl_chauffeur: 'Test, A.', postnl_chauffeur_id: '2' } },   // naamgenoot: eigen id
    { velden: { postnl_chauffeur: null, postnl_chauffeur_id: null } },
    { velden: { postnl_chauffeur: 'Alleen, N.' } },
  ]
  assert.deepEqual(chauffeursUitRitten(ritten), [{ postnl_id: '1', naam: 'Test, A.' }, { postnl_id: '2', naam: 'Test, A.' }])
})

test('chauffeursUitKeuzes: opties van de keuzelijst, lege eruit', () => {
  assert.deepEqual(chauffeursUitKeuzes([{ id: '9', naam: ' Een, B. ' }, { id: '', naam: 'x' }, { id: '8', naam: '' }]), [{ postnl_id: '9', naam: 'Een, B.' }])
})

test('chauffeursTeSchrijven: nieuw, andere naam of ander depot altijd; anders pas na VERVERS_MS', () => {
  const bestaand = [
    { postnl_id: '1', naam: 'Test, A.', depot: 'D', laatst_gezien: eerder(60_000), laatst_in_keuzelijst: null },
    { postnl_id: '2', naam: 'Oud, B.', depot: 'D', laatst_gezien: eerder(60_000) },
    { postnl_id: '3', naam: 'Ver, C.', depot: 'D', laatst_gezien: eerder(VERVERS_MS + 1) },
    { postnl_id: '4', naam: 'Ander, D.', depot: 'E', laatst_gezien: eerder(60_000) },
  ]
  const gelezen = [
    { postnl_id: '1', naam: 'Test, A.' }, { postnl_id: '2', naam: 'Nieuw, B.' }, { postnl_id: '3', naam: 'Ver, C.' },
    { postnl_id: '4', naam: 'Ander, D.' }, { postnl_id: '5', naam: 'Vers, E.' },
  ]
  const uit = chauffeursTeSchrijven(bestaand, gelezen, { klantId: 'k', depot: 'D', nu: NU })
  assert.deepEqual(uit.map(r => r.postnl_id), ['2', '3', '4', '5'])
  assert.ok(uit.every(r => r.klant_id === 'k' && r.depot === 'D' && r.laatst_gezien === NU))
  assert.ok(uit.every(r => !('user_id' in r)), 'de koppeling van HR schrijft de worker nooit')
  const keuze = chauffeursTeSchrijven(bestaand, [{ postnl_id: '1', naam: 'Test, A.' }], { klantId: 'k', depot: 'D', nu: NU, uitKeuzelijst: true })
  assert.deepEqual(keuze.map(r => [r.postnl_id, r.laatst_in_keuzelijst]), [['1', NU]], 'nog nooit in een open keuzelijst gezien: wel schrijven')
})

function nepSupabase({ bestaand = [], leesFout = null, schrijfFout = null } = {}) {
  const log = []
  return {
    log,
    from(tabel) {
      const q = { tabel, filters: [] }
      const api = {
        select() { q.soort = 'select'; return api },
        eq(k, v) { q.filters.push([k, v]); return api },
        in(k, v) { q.filters.push([k, v]); return api },
        upsert(rijen, opties) { log.push({ tabel, soort: 'upsert', rijen, opties }); return Promise.resolve({ error: schrijfFout }) },
        then(ok, nok) { log.push(q); return Promise.resolve({ data: bestaand, error: leesFout }).then(ok, nok) },
      }
      return api
    },
  }
}

test('bewaarChauffeurs: leest met klant_id, upsert op klant + id, ontbrekende tabel = overslaan, andere fout luid', async () => {
  const sb = nepSupabase()
  const uit = await bewaarChauffeurs(sb, { klantId: 'k', depot: 'D', chauffeurs: [{ postnl_id: '1', naam: 'Test, A.' }], nu: NU })
  assert.deepEqual(uit, { geschreven: 1, overgeslagen: false })
  assert.ok(sb.log[0].filters.some(([k, v]) => k === 'klant_id' && v === 'k'))
  assert.equal(sb.log[1].opties.onConflict, 'klant_id,postnl_id')
  assert.deepEqual(await bewaarChauffeurs(nepSupabase({ leesFout: { code: '42P01', message: 'bestaat niet' } }), { klantId: 'k', depot: 'D', chauffeurs: [{ postnl_id: '1', naam: 'x' }] }), { geschreven: 0, overgeslagen: true })
  await assert.rejects(bewaarChauffeurs(nepSupabase({ leesFout: { code: '500', message: 'kapot' } }), { klantId: 'k', depot: 'D', chauffeurs: [{ postnl_id: '1', naam: 'x' }] }), (e) => e.database === true && /kapot/.test(e.message))
  await assert.rejects(bewaarChauffeurs(nepSupabase({ schrijfFout: { message: 'weg' } }), { klantId: 'k', depot: 'D', chauffeurs: [{ postnl_id: '1', naam: 'x' }], nu: NU }), /weg/)
  assert.deepEqual(await bewaarChauffeurs(nepSupabase(), { klantId: 'k', depot: 'D', chauffeurs: [] }), { geschreven: 0, overgeslagen: false })
})

test('schrijfDagplanning: mislukt het bewaren van de chauffeurs, dan toch eerst de ritten, daarna luid', async () => {
  const { schrijfDagplanning } = await import('../src/postnl/schrijver.js')
  const log = []
  const sb = {
    from(tabel) {
      const q = { tabel, filters: [] }
      const api = {
        select() { q.soort = 'select'; return api },
        update(v) { q.soort = 'update'; q.waarde = v; return api },
        insert(v) { log.push({ tabel, soort: 'insert' }); return Promise.resolve({ error: null }) },
        upsert() { return Promise.resolve({ error: null }) },
        eq(k, v) { q.filters.push([k, v]); return api },
        in() { return api },
        then(ok, nok) {
          log.push({ tabel, soort: q.soort })
          const fout = tabel === 'postnl_chauffeurs' ? { code: '500', message: 'kapot' } : null
          return Promise.resolve({ data: [], error: fout }).then(ok, nok)
        },
      }
      return api
    },
  }
  const gelezen = [{ ritnummer: '114', kanaal: 'HD', shift: '1', velden: { postnl_stops: 5, postnl_chauffeur: 'Test, A.', postnl_chauffeur_id: '1' } }]
  await assert.rejects(schrijfDagplanning(sb, { klantId: 'k', datum: '2026-11-13', depot: 'D', nu: NU, gelezen }), (e) => e.database === true)
  assert.ok(log.some(l => l.tabel === 'ritten' && l.soort === 'insert'), 'de nieuwe rit is toch geschreven')
})
