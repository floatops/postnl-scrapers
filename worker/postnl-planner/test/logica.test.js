import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adresSleutel, deadlineUitTekst, foutVoorPlanner, teOudeTraces, traceAan, gebruikerBijNaam, getal, ritnummerVan, isWeigering, objectenUit, redenNietUitvoeren, rijenVoorStops, rittenUit,
  selectieKlopt, stopNaarRij, stopsUit, tvi, uniekeMeldingen,
} from '../src/logica.js'

const attrs = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, { value: v }]))
const stopObject = (guid, a) => ({ objectType: 'OperationalPlanning.Stop', guid, attributes: attrs(a) })

test('objecten staan per actie onder een andere sleutel', () => {
  const uit = objectenUit({
    objects: [stopObject('1', { StopID: 'a' })],
    partialObjects: [stopObject('2', { StopID: 'b' })],
    mxobjects: [stopObject('3', { StopID: 'c' }), { objectType: 'Iets.Anders', guid: '4', attributes: {} }],
  }, 'OperationalPlanning.Stop')
  assert.deepEqual(uit.map(o => o.StopID), ['a', 'b', 'c'])
})

test('een waarde in changes gaat voor op de lege waarde in het object', () => {
  const uit = objectenUit({
    objects: [{ objectType: 'OperationalPlanning.RideMutationDeadline', guid: '9', attributes: attrs({ RideMutationDeadline: null }) }],
    changes: { 9: { RideMutationDeadline: { value: 'Ritten kunnen tot 07:15 uur worden aangepast.' } } },
  }, 'OperationalPlanning.RideMutationDeadline')
  assert.equal(uit[0].RideMutationDeadline, 'Ritten kunnen tot 07:15 uur worden aangepast.')
})

test('deadline komt uit de tekst, in Nederlandse tijd, ook rond de klokwissel', () => {
  assert.equal(deadlineUitTekst('Ritten kunnen tot 07:15 uur worden aangepast.', '2026-11-02'), '2026-11-02T06:15:00.000Z')
  assert.equal(deadlineUitTekst('Ritten kunnen tot 10:00 uur worden aangepast.', '2026-07-01'), '2026-07-01T08:00:00.000Z')
  assert.equal(deadlineUitTekst('iets anders', '2026-11-02'), null)
  assert.equal(deadlineUitTekst(null, '2026-11-02'), null)
  assert.equal(deadlineUitTekst('Ritten kunnen tot 25:00 uur worden aangepast.', '2026-11-02'), null)
})

test('melding van de actie en van de achtergrondtaak telt één keer', () => {
  const m = { type: 'text_message', args: { MessageContent: 'De rit is al geautoriseerd.', MessageType: 'warning' } }
  const uit = uniekeMeldingen([{ instructions: [m] }, { instructions: [m] }, {}])
  assert.equal(uit.length, 1)
  assert.equal(isWeigering(uit[0]), true)
  assert.equal(isWeigering({ tekst: 'x', soort: 'info' }), false)
})

test('ritnummer zoals in de tabel ritten', () => {
  assert.equal(ritnummerVan('0217 maasdijk'), '217')
  assert.equal(ritnummerVan('geen nummer'), null)
})

test('koppeling op PostNL-naam, alleen bij precies één treffer', () => {
  const lijst = [{ id: 'a', postnl_naam: 'Soerka, S.H.' }, { id: 'b', postnl_naam: 'Dubbel, D.' }, { id: 'c', postnl_naam: 'dubbel, d.' }]
  assert.equal(gebruikerBijNaam(lijst, ' soerka, s.h. '), 'a')
  assert.equal(gebruikerBijNaam(lijst, 'Dubbel, D.'), null)
  assert.equal(gebruikerBijNaam(lijst, 'Niemand'), null)
})

test('ritten: geneste Ride en chauffeur zoals PostNL ze stuurt', () => {
  const [rit] = rittenUit([{ mxobjects: [{
    objectType: 'OperationalPlanning.RideNumber', guid: 'n1',
    attributes: { Stops: { value: '168' }, Pieces: { value: '244' }, Volume: { value: '4.69' }, 'OperationalPlanning.RideNumber_Ride': { value: {
      objectType: 'OperationalPlanning.Ride', guid: 'r1',
      attributes: { RideName: { value: '0217 maasdijk' }, Enum_Authorized: { value: '_True' }, 'OperationalPlanning.OperationalRide_Driver': { value: {
        objectType: 'Planning.Driver', guid: 'd1', attributes: { LastNameInitials: { value: 'Soerka, S.H.' } },
      } } },
    } } },
  }] }])
  assert.deepEqual(rit, { rit_id: 'r1', ritnaam: '0217 maasdijk', chauffeur: 'Soerka, S.H.', geautoriseerd: true, bewerkbaar: true, geblokkeerd: false, stops: 168, stuks: 244, volume: 4.69 })
})

test('ritten: de chauffeur komt mee via de koppeling op de Ride', () => {
  const [rit] = rittenUit([{ objects: [
    { objectType: 'OperationalPlanning.Ride', guid: 'r1', attributes: attrs({ RideID: 'X', RideName: '0217', 'OperationalPlanning.OperationalRide_Driver': 'd1', AllowDriverChange: true }) },
    { objectType: 'OperationalPlanning.RideNumber', guid: 'n1', attributes: attrs({ 'OperationalPlanning.RideNumber_Ride': 'r1', Stops: '1' }) },
    { objectType: 'Planning.Driver', guid: 'd1', attributes: attrs({ LastNameInitials: 'Soerka, S.H.' }) },
  ] }])
  assert.equal(rit.chauffeur, 'Soerka, S.H.')
})

test('ritten: status van de Ride, totalen van het RideNumber', () => {
  const uit = rittenUit([{
    objects: [
      { objectType: 'OperationalPlanning.Ride', guid: 'r1', attributes: attrs({ RideID: 'X_0217', RideName: '0217 maasdijk', Authorized: true, Editable: true, IsBlocked: false }) },
      { objectType: 'OperationalPlanning.RideNumber', guid: 'n1', attributes: attrs({ 'OperationalPlanning.RideNumber_Ride': 'r1', Stops: '168', Pieces: '244', Volume: '4.69' }) },
      { objectType: 'OperationalPlanning.RideNumber', guid: 'n2', attributes: attrs({ 'OperationalPlanning.RideNumber_Ride': 'bestaat-niet', Stops: '1' }) },
    ],
  }])
  assert.deepEqual(uit, [{ rit_id: 'r1', ritnaam: '0217 maasdijk', chauffeur: null, geautoriseerd: true, bewerkbaar: true, geblokkeerd: false, stops: 168, stuks: 244, volume: 4.69 }])
})

test('stop naar rij bevat alleen wat de app toont', () => {
  const [stop] = stopsUit([{ partialObjects: [stopObject('1', {
    Street: 'Abel Tasmanstraat ', BuildingNumber: '8', BuildingNumberExtension: null,
    Pieces: '1', Volume: '0.019', Weight: '1.12', City: 'MAASDIJK', PostalCode: '2676AA', PlannedStopTime: 1793467080000,
  })] }])
  const rij = stopNaarRij(stop, { klantId: 'k', depot: 'd', datum: '2026-11-02', shift: '02', ritId: 'R1', opgehaaldAt: 't' })
  assert.deepEqual(rij, {
    klant_id: 'k', depot: 'd', datum: '2026-11-02', shift: '02', rit_id: 'R1', stop_id: '1',
    straat: 'Abel Tasmanstraat', huisnummer: '8', toevoeging: null, stuks: 1, volume: 0.019, opgehaald_at: 't',
  })
})

test('tvi is de Nederlandse tijd', () => {
  assert.equal(tvi(Date.UTC(2026, 10, 2, 13, 28)), '14:28')
  assert.equal(tvi(null), '')
})

test('stops vinden in de tabel: hoofdletters tellen niet, dubbel en onvindbaar worden gemeld', () => {
  const tijd = Date.UTC(2026, 10, 2, 12, 10)
  const stops = [
    { Street: 'Aletta Rutgersstraat', BuildingNumber: '11', PlannedStopTime: tijd },
    { Street: 'Weg', BuildingNumber: '1', PlannedStopTime: tijd },
    { Street: 'Dubbel', BuildingNumber: '2', PlannedStopTime: tijd },
  ]
  const rij = (index, straat, nummer) => ({ index, tijd: '13:10', straat, nummer, toevoeging: '' })
  const { gevonden, problemen } = rijenVoorStops(stops, [
    rij(0, 'aletta rutgersstraat', '11'), rij(1, 'Dubbel', '2'), rij(2, 'Dubbel', '2'),
  ])
  assert.deepEqual(gevonden.map(r => r.index), [0])
  assert.deepEqual(problemen, ['Weg 1 staat niet in de tabel', 'Dubbel 2 staat dubbel in de tabel'])
})

test('selectie klopt alleen als precies de bedoelde rijen aan staan', () => {
  const stop = (Street) => ({ Street, BuildingNumber: '1', PlannedStopTime: Date.UTC(2026, 10, 2, 12, 10) })
  const rij = (straat, geselecteerd) => ({ tijd: '13:10', straat, nummer: '1', toevoeging: '', geselecteerd })
  const rijen = [rij('A', true), rij('B', false), rij('C', true)]
  assert.equal(selectieKlopt(rijen, [stop('A'), stop('C')]), true)
  assert.equal(selectieKlopt(rijen, [stop('A')]), false)
  assert.equal(selectieKlopt(rijen, [stop('A'), stop('B'), stop('C')]), false)
  // Een nieuw adres bovenaan schuift alles op: de selectie klopt dan nog steeds.
  assert.equal(selectieKlopt([rij('Nieuw', false), ...rijen], [stop('A'), stop('C')]), true)
})

test('adres zonder tijd blijft gelijk als PostNL de tijd herberekent', () => {
  const a = { Street: 'Weg', BuildingNumber: '1', PostalCode: '1234AB', PlannedStopTime: 1 }
  assert.equal(adresSleutel(a), adresSleutel({ ...a, PlannedStopTime: 2, StopID: 'nieuw' }))
})

test('niet uitvoeren bij geautoriseerd, geblokkeerd of voorbije deadline', () => {
  const rit = { ritnaam: '0217 maasdijk', geautoriseerd: false, geblokkeerd: false }
  const nu = new Date('2026-11-02T07:00:00Z')
  assert.equal(redenNietUitvoeren({ doelRit: null, nu }), 'De doelrit staat niet meer in de planning.')
  assert.match(redenNietUitvoeren({ doelRit: { ...rit, geautoriseerd: true }, nu }), /geautoriseerd/)
  assert.match(redenNietUitvoeren({ doelRit: { ...rit, geblokkeerd: true }, nu }), /geblokkeerd/)
  assert.match(redenNietUitvoeren({ doelRit: rit, deadline: '2026-11-02T06:15:00Z', nu }), /deadline van 07:15 uur/)
  assert.equal(redenNietUitvoeren({ doelRit: rit, deadline: '2026-11-02T08:00:00Z', nu }), null)
})

test('getal: leeg is 0, komma mag', () => {
  assert.equal(getal(null), 0)
  assert.equal(getal('4,69'), 4.69)
  assert.equal(getal('abc'), 0)
})

test('fout in gewone taal voor de planner', () => {
  assert.match(foutVoorPlanner("locator.evaluate: Timeout 30000ms exceeded.\nCall log: waiting for locator('.mx-name-dataGrid21')"), /niet op tijd/)
  assert.match(foutVoorPlanner('PostNL reageerde niet binnen de wachttijd'), /niet op tijd/)
  assert.equal(foutVoorPlanner('Dag 31-10-2026 staat niet in de PostNL-planning.'), 'Dag 31-10-2026 staat niet in de PostNL-planning.')
  assert.match(foutVoorPlanner('iets raars'), /Er ging iets mis/)
})

test('trace staat aan, tenzij hij in de omgeving uit staat', () => {
  assert.equal(traceAan({}), true)
  assert.equal(traceAan({ PLANNER_TRACE: 'uit' }), false)
})

test('alleen traces ouder dan de bewaartermijn gaan weg', () => {
  const namen = ['den-hoorn-ophalen-2026-10-01_08-00-00.zip', 'den-hoorn-ophalen-2026-11-01_08-00-00.zip', 'iets-anders.webm']
  assert.deepEqual(teOudeTraces(namen, new Date('2026-11-02T08:00:00Z')), ['den-hoorn-ophalen-2026-10-01_08-00-00.zip'])
})
