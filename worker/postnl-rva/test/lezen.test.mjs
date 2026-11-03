// Mendix-antwoorden in de vorm die RVA stuurt (03-11), met verzonnen adressen en namen.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { regelsUit, ritDagUit, rittenUit, revisiesUit, onderbrekingenUit, weekdagVanEnum } from '../src/lezen.js'

const obj = (objectType, guid, attrs) => ({ objectType, guid, attributes: Object.fromEntries(Object.entries(attrs).map(([k, v]) => [k, { value: v }])) })
const adres = (guid, nr, straat, van, tm, eo = 'Odd', richting = 'Oplopend', extra = {}) => obj('PlanningData.SequenceAddress', guid, {
  SequenceNumber: String(nr), PostalCode: '1234AB', City: 'Proefdorp', Street: straat, HouseNumberFrom: String(van), HouseNumberTo: String(tm),
  EvenOdd: eo, HouseNumberSequence: richting, IsSplit: false, ToDelete: false, 'PlanningData.SequenceAddress_TripWeekday': 'rd1', ...extra,
})

test('regelsUit: op volgorde, Odd wordt Oneven, alleen deze rit-dag, geen te-verwijderen regels', () => {
  const antwoord = { objects: [
    adres('a2', 2, 'Peerlaan', 2, 10, 'Even', 'Aflopend'),
    adres('a1', 1, 'Appelstraat', 1, 9),
    adres('a3', 3, 'Kerslaan', 1, 1, 'Odd', 'Oplopend', { 'PlanningData.SequenceAddress_TripWeekday': 'rd2' }),
    adres('a4', 4, 'Weg', 1, 1, 'Odd', 'Oplopend', { ToDelete: true }),
  ] }
  const regels = regelsUit(antwoord, 'rd1')
  assert.deepEqual(regels.map(r => r.straat), ['Appelstraat', 'Peerlaan'])
  assert.deepEqual(regels[1], { volgorde: 2, postcode: '1234AB', plaats: 'Proefdorp', straat: 'Peerlaan', van: 2, tm: 10, evenOneven: 'Even', richting: 'Aflopend', geknipt: false })
  assert.equal(regels[0].evenOneven, 'Oneven')
})

test('ritDagUit: slot en weekdag, de laatste stand telt', () => {
  const tw = (locked) => obj('PlanningData.TripWeekday', 'rd1', { RouteName: 'proefroute', WeekDay: 'E06_SATURDAY', IsLocked: locked, LockedBy: locked ? 'acc1' : null, LastModified: 1762212345000, 'PlanningData.TripWeekday_Trip': 't1' })
  const d = ritDagUit([{ objects: [tw(false)] }, { objects: [tw(true)] }])
  assert.equal(d.weekdag, 'Za')
  assert.equal(d.vergrendeld, true)
  assert.equal(d.vergrendeldDoor, 'acc1')
  assert.equal(ritDagUit([]), null)
})

test('weekdagVanEnum', () => {
  assert.equal(weekdagVanEnum('E01_MONDAY'), 'Ma')
  assert.equal(weekdagVanEnum('E04_THURSDAY'), 'Do')
  assert.equal(weekdagVanEnum(null), null)
})

test('rittenUit: dagen en verantwoordelijken met naam', () => {
  const antwoord = { objects: [
    obj('UMConnectorImplementation.Account', 'acc1', { FullName: 'Planner Een' }),
    obj('UMConnectorImplementation.Account', 'acc2', { FullName: 'Planner Twee' }),
    obj('PlanningData.Trip', 't1', { TripNumber: '0999', Name: 'proefrit', Monday: false, Tuesday: true, Wednesday: true, Thursday: true, Friday: true, Saturday: true, 'PlanningData.Trip_Responsible': ['acc1', 'acc2'] }),
  ] }
  const [t] = rittenUit([antwoord])
  assert.deepEqual(t.dagen, ['Di', 'Wo', 'Do', 'Vr', 'Za'])
  assert.deepEqual(t.verantwoordelijken, ['Planner Een', 'Planner Twee'])
})

test('revisiesUit: nieuwste eerst, inhoud uit de Payload, kapotte Payload geeft null', () => {
  const payload = JSON.stringify({ SequenceAddresses: [
    { SequenceNumber: 2, Street: 'Peerlaan', HouseNumberFrom: 2, HouseNumberTo: 10, PostalCode: '1234AB', City: 'Proefdorp', EvenOdd: 'Even', HouseNumberSequence: 'Oplopend', IsSplit: false },
    { SequenceNumber: 1, Street: 'Appelstraat', HouseNumberFrom: 1, HouseNumberTo: 9, PostalCode: '1234AB', City: 'Proefdorp', EvenOdd: 'Odd', HouseNumberSequence: 'Oplopend', IsSplit: false },
  ] })
  const antwoord = { objects: [
    obj('PlanningData.Snapshot', 's1', { CreatedAt: '1755762618024', CreatedBy: 'Systeem', IsActive: false, Payload: payload, 'PlanningData.Snapshot_TripWeekday': 'rd1' }),
    obj('PlanningData.Snapshot', 's2', { CreatedAt: '1762126063996', CreatedBy: 'Planner Een', IsActive: true, Payload: payload, 'PlanningData.Snapshot_TripWeekday': 'rd1' }),
    obj('PlanningData.Snapshot', 's3', { CreatedAt: '1762126000000', CreatedBy: 'x', IsActive: false, Payload: '{kapot', 'PlanningData.Snapshot_TripWeekday': 'rd1' }),
  ] }
  const revisies = revisiesUit([antwoord], 'rd1')
  assert.deepEqual(revisies.map(r => r.guid), ['s2', 's3', 's1'])
  assert.equal(revisies[0].actief, true)
  assert.deepEqual(revisies[0].regels.map(r => [r.volgorde, r.straat, r.evenOneven]), [[1, 'Appelstraat', 'Oneven'], [2, 'Peerlaan', 'Even']])
  assert.equal(revisies[1].regels, null)
})

test('onderbrekingenUit: alleen echte, niet verwijderde', () => {
  const antwoord = { objects: [
    obj('PlanningData.TripBreak', 'b1', { BreakType: 'Placebound', Minutes: '15', FE_IsDeleted: false, 'PlanningData.TripBreak_Placebound_SequenceAddress': 'a1' }),
    obj('PlanningData.TripBreak', 'b2', { BreakType: null, Minutes: null, FE_IsDeleted: false }),
    obj('PlanningData.TripBreak', 'b3', { BreakType: 'Placebound', Minutes: '5', FE_IsDeleted: true }),
  ] }
  assert.deepEqual(onderbrekingenUit([antwoord]), [{ guid: 'b1', soort: 'Placebound', minuten: 15, naRegel: 'a1' }])
})
