import { test } from 'node:test'
import assert from 'node:assert/strict'
import { teSchrijven, HARTSLAG_MS } from '../src/wijzigingen.js'

const NU = Date.parse('2026-10-28T12:00:00Z')
const iso = ms => new Date(ms).toISOString()

const bestaand = {
  postnl_stops_totaal: 120,
  postnl_stops_te_doen: 40,
  postnl_laatste_actie: '11:58',
  postnl_kanaal: 'Pakket',
  postnl_chauffeur: 'J. Jansen',
  postnl_eind_werktijd: '2026-10-28T10:58:00+00:00',
  postnl_monitor_opgehaald: iso(NU - 60000),
  status: 'bezig',
}
const lezing = (extra = {}) => ({
  postnl_stops_totaal: 120,
  postnl_stops_te_doen: 40,
  postnl_laatste_actie: '11:58',
  postnl_kanaal: 'Pakket',
  postnl_chauffeur: 'J. Jansen',
  postnl_monitor_opgehaald: iso(NU),
  status: 'bezig',
  ...extra,
})

test('niets veranderd en hartslag recent: niets schrijven', () => {
  assert.equal(teSchrijven(bestaand, lezing(), NU), null)
})

test('niets veranderd maar hartslag oud: alleen de hartslag', () => {
  const oud = { ...bestaand, postnl_monitor_opgehaald: iso(NU - HARTSLAG_MS) }
  assert.deepEqual(teSchrijven(oud, lezing(), NU), { postnl_monitor_opgehaald: iso(NU) })
})

test('zonder vorige hartslag: hartslag schrijven', () => {
  const nooit = { ...bestaand, postnl_monitor_opgehaald: null }
  assert.deepEqual(teSchrijven(nooit, lezing(), NU), { postnl_monitor_opgehaald: iso(NU) })
})

test('voortgang: gewijzigde velden plus hartslag', () => {
  assert.deepEqual(teSchrijven(bestaand, lezing({ postnl_stops_te_doen: 39, postnl_laatste_actie: '12:00' }), NU), {
    postnl_stops_te_doen: 39,
    postnl_laatste_actie: '12:00',
    postnl_monitor_opgehaald: iso(NU),
  })
})

test('zelfde tijdstip in andere notatie (+00:00 vs Z) telt niet als wijziging', () => {
  assert.equal(teSchrijven(bestaand, lezing({ postnl_eind_werktijd: '2026-10-28T10:58:00.000Z' }), NU), null)
})

test('later eindtijdstip is wel een wijziging', () => {
  assert.deepEqual(teSchrijven(bestaand, lezing({ postnl_eind_werktijd: '2026-10-28T11:00:00.000Z' }), NU), {
    postnl_eind_werktijd: '2026-10-28T11:00:00.000Z',
    postnl_monitor_opgehaald: iso(NU),
  })
})

test('veld dat niet gelezen is telt als gewijzigd (liever een write te veel dan een gemiste)', () => {
  assert.deepEqual(teSchrijven(bestaand, lezing({ shift: null }), NU), { shift: null, postnl_monitor_opgehaald: iso(NU) })
})

test('null naar null is geen wijziging, null naar waarde wel', () => {
  const metNull = { ...bestaand, postnl_briefbusstops: null }
  assert.equal(teSchrijven(metNull, lezing({ postnl_briefbusstops: null }), NU), null)
  assert.deepEqual(teSchrijven(metNull, lezing({ postnl_briefbusstops: 12 }), NU), { postnl_briefbusstops: 12, postnl_monitor_opgehaald: iso(NU) })
})

test('HH:MM-tekst wordt als tekst vergeleken', () => {
  assert.deepEqual(teSchrijven(bestaand, lezing({ postnl_laatste_actie: '11:59' }), NU), {
    postnl_laatste_actie: '11:59',
    postnl_monitor_opgehaald: iso(NU),
  })
})
