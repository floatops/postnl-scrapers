// node --test — Ritmonitor-lezing naar `ritten` (planMonitor), met scenario's die echt voorkomen
// (floatops/matransport#562, #560). Geen browser, geen database.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { planMonitor, rijenUitScherm, AFWEZIG_DREMPEL_MIN } from '../src/ritmonitor.js'

const DATUM = '2026-11-02'
const nuOm = (hhmm) => new Date(`${DATUM}T${hhmm}:00+01:00`).toISOString()
const min = (iso, m) => new Date(new Date(iso).getTime() + m * 60000).toISOString()

const rij = (o) => ({ ritnummer: '216', ritnaam: '0216 dorp', chauffeur: 'A', kanaal: 'HD', laatsteActie: null,
  stopsTotaal: 113, stopsTeDoen: 113, brievenbusstops: 15, shift: '2', ...o })
const plan = (bestaande, rijen, nu, extra = {}) =>
  planMonitor({ bestaande, rijen, datum: DATUM, depot: 'D', klantId: 'k', nu, ...extra })

test('#560: de avondrit 307 (AD) raakt de ochtendrit 307 (HD) niet', () => {
  const nu = nuOm('17:30')
  const hd = { id: 'hd', ritnummer: '307', postnl_kanaal: 'HD', status: 'gereden', postnl_stops_totaal: 168,
    postnl_stops_te_doen: 0, postnl_start_werktijd: nuOm('09:00'), postnl_eind_werktijd: nuOm('15:10'), postnl_monitor_opgehaald: nuOm('15:20') }
  const uit = plan([hd], [rij({ ritnummer: '307', ritnaam: '0307 avond', kanaal: 'AD', stopsTotaal: 16, stopsTeDoen: 10, laatsteActie: '17:25', shift: null })], nu)
  assert.equal(uit.updates.find(u => u.id === 'hd'), undefined, 'HD-rit niet aangeraakt')
  assert.equal(uit.inserts.length, 1)
  assert.equal(uit.inserts[0].postnl_kanaal, 'AD')
  assert.equal(uit.inserts[0].postnl_start_werktijd, new Date(`${DATUM}T17:00:00+01:00`).toISOString(), 'AD start om 17:00')
  assert.equal(uit.logRijen[0].kanaal, 'AD')
})

test('een rij zonder kanaal in de database is HD', () => {
  const nu = nuOm('10:00')
  const bestaand = { id: 'x', ritnummer: '216', postnl_kanaal: null, status: 'gepland', postnl_stops_totaal: 113, postnl_stops_te_doen: 113,
    postnl_start_werktijd: null, postnl_eind_werktijd: null, postnl_monitor_opgehaald: null, postnl_laatste_actie: null, postnl_chauffeur: 'A', postnl_briefbusstops: 15, shift: '2' }
  const uit = plan([bestaand], [rij({ stopsTeDoen: 110, laatsteActie: '09:58' })], nu)
  assert.equal(uit.inserts.length, 0)
  assert.equal(uit.updates[0].id, 'x')
  assert.equal(uit.updates[0].velden.postnl_start_werktijd, nu, 'eerste afgeleverde stop zet de start')
})

test('half geladen grid (0 rijen, niet bevestigd): niets afronden', () => {
  const nu = nuOm('14:00')
  const bezig = { id: 'b', ritnummer: '216', postnl_kanaal: 'HD', status: 'bezig', postnl_stops_totaal: 113, postnl_stops_te_doen: 20,
    postnl_start_werktijd: nuOm('09:00'), postnl_monitor_opgehaald: min(nu, -60), postnl_laatste_actie: '12:59' }
  assert.deepEqual(plan([bezig], [], nu).updates, [])
  const bevestigd = plan([bezig], [], nu, { leegBevestigd: true })
  assert.equal(bevestigd.updates[0].velden.status, 'gereden', 'PostNL bevestigt leeg: wel afronden')
})

test('verdwenen rit: pas na de drempel afgerond, eindtijd alleen uit PostNL', () => {
  const nu = nuOm('15:00')
  const r = (laatst) => ({ id: 'v', ritnummer: '217', postnl_kanaal: 'HD', status: 'bezig', postnl_stops_totaal: 138, postnl_stops_te_doen: 4,
    postnl_start_werktijd: nuOm('09:00'), postnl_eind_werktijd: null, postnl_monitor_opgehaald: laatst, postnl_laatste_actie: '14:31' })
  const andere = [rij({ ritnummer: '218', stopsTeDoen: 50 })]
  assert.equal(plan([r(min(nu, -(AFWEZIG_DREMPEL_MIN - 1)))], andere, nu).updates.find(u => u.id === 'v'), undefined)
  const af = plan([r(min(nu, -(AFWEZIG_DREMPEL_MIN + 1)))], andere, nu).updates.find(u => u.id === 'v')
  assert.equal(af.velden.status, 'gereden')
  assert.equal(af.velden.postnl_eind_werktijd, new Date(`${DATUM}T14:31:00+01:00`).toISOString())
})

test('één keer 0 te doen is nog bezig, twee keer achter elkaar is gereden', () => {
  const nu = nuOm('15:30')
  const basis = { id: 'z', ritnummer: '216', postnl_kanaal: 'HD', status: 'bezig', postnl_stops_totaal: 113,
    postnl_start_werktijd: nuOm('09:00'), postnl_monitor_opgehaald: min(nu, -1), postnl_laatste_actie: '15:20', postnl_chauffeur: 'A', postnl_briefbusstops: 15 }
  assert.equal(plan([{ ...basis, postnl_stops_te_doen: 3 }], [rij({ stopsTeDoen: 0, laatsteActie: '15:28' })], nu).updates[0].velden.status, undefined, 'bezig blijft bezig')
  assert.equal(plan([{ ...basis, postnl_stops_te_doen: 0 }], [rij({ stopsTeDoen: 0, laatsteActie: '15:28' })], nu).updates[0].velden.status, 'gereden')
})

test('reserve-rit 9xx: start is de eerste laatste-actie-tijd, niet het moment van lezen', () => {
  const nu = nuOm('11:00')
  const uit = plan([], [rij({ ritnummer: '901', ritnaam: '0901 reserve', stopsTotaal: 40, stopsTeDoen: 38, laatsteActie: '10:47', shift: '9' })], nu)
  assert.equal(uit.inserts[0].postnl_start_werktijd, new Date(`${DATUM}T10:47:00+01:00`).toISOString())
})

test('niets veranderd: geen update, behalve de hartslag na 5 minuten', () => {
  const nu = nuOm('12:00')
  const vast = { id: 'h', ritnummer: '216', postnl_kanaal: 'HD', status: 'bezig', shift: '2', postnl_stops_totaal: 113, postnl_stops_te_doen: 60,
    postnl_start_werktijd: nuOm('09:00'), postnl_eind_werktijd: new Date(`${DATUM}T11:58:00+01:00`).toISOString(), postnl_laatste_actie: '11:58', postnl_chauffeur: 'A', postnl_briefbusstops: 15 }
  const zelfde = [rij({ stopsTeDoen: 60, laatsteActie: '11:58' })]
  assert.deepEqual(plan([{ ...vast, postnl_monitor_opgehaald: min(nu, -1) }], zelfde, nu).updates, [])
  assert.deepEqual(plan([{ ...vast, postnl_monitor_opgehaald: min(nu, -6) }], zelfde, nu).updates, [{ id: 'h', velden: { postnl_monitor_opgehaald: nu } }])
})

test('chauffeurwissel in PostNL komt mee bij de volgende lezing', () => {
  const nu = nuOm('10:00')
  const b = { id: 'c', ritnummer: '216', postnl_kanaal: 'HD', status: 'bezig', shift: '2', postnl_stops_totaal: 113, postnl_stops_te_doen: 100,
    postnl_start_werktijd: nuOm('09:00'), postnl_eind_werktijd: null, postnl_monitor_opgehaald: min(nu, -1), postnl_laatste_actie: '09:59', postnl_chauffeur: 'A', postnl_briefbusstops: 15 }
  const uit = plan([b], [rij({ chauffeur: 'B', stopsTeDoen: 100, laatsteActie: '09:59' })], nu)
  assert.equal(uit.updates[0].velden.postnl_chauffeur, 'B')
})

test('rijenUitScherm: rommelrijen weg, duizendtal, AD zonder shift, leeg kanaal = null', () => {
  const rijen = rijenUitScherm([
    { ritnaam: 'Totaal', stopsTotaal: '500' },
    { ritnaam: '0216 dorp', kanaal: '', stopsTotaal: '1.113', stopsTeDoen: '0', brievenbusstops: '' },
    { ritnaam: '0307 avond', kanaal: 'AD', stopsTotaal: '16', stopsTeDoen: '16' },
    { ritnaam: '0218 leeg', stopsTotaal: '' },
  ])
  assert.equal(rijen.length, 2)
  assert.equal(rijen[0].stopsTotaal, 1113)
  assert.equal(rijen[0].kanaal, null)
  assert.equal(rijen[0].brievenbusstops, null)
  assert.equal(rijen[1].shift, null)
})

test('matransport#713: chauffeur en brievenbusstops alleen uit de Dagplanning als die de rit kent', () => {
  const nu = nuOm('10:00')
  const basis = { ritnummer: '216', postnl_kanaal: 'HD', status: 'gepland', postnl_stops_totaal: 113, postnl_stops_te_doen: 113,
    postnl_laatste_actie: null, postnl_monitor_opgehaald: nu, postnl_chauffeur: 'Dagplanning, D.', postnl_briefbusstops: 14 }
  const bekend = plan([{ ...basis, id: 'a', postnl_rit_id: 'r1' }], [rij({ chauffeur: 'Anders, A.', brievenbusstops: 15 })], nu)
  const velden = bekend.updates[0]?.velden ?? {}
  assert.equal('postnl_chauffeur' in velden, false, 'de Ritmonitor overschrijft de chauffeur van de Dagplanning niet')
  assert.equal('postnl_briefbusstops' in velden, false)
  const onbekend = plan([{ ...basis, id: 'b', postnl_rit_id: null }], [rij({ chauffeur: 'Anders, A.', brievenbusstops: 15 })], nu)
  assert.equal(onbekend.updates[0].velden.postnl_chauffeur, 'Anders, A.', 'rit zonder Dagplanning (#653): de Ritmonitor vult hem')
  assert.equal(onbekend.updates[0].velden.postnl_briefbusstops, 15)
  const leeg = plan([{ ...basis, id: 'c', postnl_rit_id: null }], [rij({ chauffeur: null })], nu)
  assert.equal('postnl_chauffeur' in (leeg.updates[0]?.velden ?? {}), false, 'een lege cel wist geen chauffeur')
  const nieuw = plan([], [rij({ chauffeur: 'Nieuw, N.' })], nu)
  assert.equal(nieuw.inserts[0].postnl_chauffeur, 'Nieuw, N.', 'nood-rij krijgt de chauffeur uit de Ritmonitor')
})
