import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adresSleutel, deadlineUitTekst, foutVoorPlanner, teOudeTraces, traceAan, gebruikerBijNaam, getal, ritnummerVan, isWeigering, objectenUit, redenNietUitvoeren, rijenVoorStops, shiftReden, shiftsVan, rittenUit,
  selectieKlopt, stopNaarRij, stopsUit, tvi, uniekeMeldingen, verschil, STOP_VELDEN,
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
    straat: 'Abel Tasmanstraat', huisnummer: '8', toevoeging: null, postcode: '2676AA', stuks: 1, volume: 0.019, opgehaald_at: 't',
  })
})

test('postcode zonder spatie en in hoofdletters, leeg blijft leeg (matransport#587)', () => {
  const rij = (PostalCode) => stopNaarRij(stopsUit([{ partialObjects: [stopObject('1', { Street: 'X', PostalCode })] }])[0],
    { klantId: 'k', depot: 'd', datum: '2026-11-04', shift: '01', ritId: 'R1', opgehaaldAt: 't' })
  assert.equal(rij('2676 aa').postcode, '2676AA')
  assert.equal(rij(null).postcode, null)
  assert.equal(rij('').postcode, null)
})

test('bestaande stop zonder postcode wordt bij de volgende ronde aangevuld (matransport#587)', () => {
  const oud = { stop_id: 's1', rit_id: 'r1', shift: '01', straat: 'X', huisnummer: '1', toevoeging: null, postcode: null, stuks: 1, volume: 0.1 }
  assert.equal(verschil([oud], [{ ...oud, postcode: '2676AA' }], 'stop_id', STOP_VELDEN).gewijzigd.length, 1)
  assert.equal(verschil([{ ...oud, postcode: '2676AA' }], [{ ...oud, postcode: '2676AA' }], 'stop_id', STOP_VELDEN).gewijzigd.length, 0)
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

test('alleen verplaatsen binnen dezelfde shift', () => {
  const a = { ritnaam: '0217 maasdijk', shift: '02' }
  assert.equal(shiftReden(a, { ritnaam: '0211 x', shift: '02' }), null)
  assert.match(shiftReden(a, { ritnaam: '0704 y', shift: '07' }), /binnen dezelfde shift/)
  assert.equal(shiftReden(a, null), null)
})

test('verschil: alleen wat anders is gaat naar de app (#562)', async () => {
  const { verschil, STOP_VELDEN, RIT_VELDEN } = await import('../src/logica.js')
  const stop = (id, rit, extra = {}) => ({ stop_id: id, rit_id: rit, shift: '07', straat: 'Laan', huisnummer: '1', toevoeging: null, stuks: 2, volume: 0.5, opgehaald_at: '2026-11-03T06:00:00Z', ...extra })
  const bestaand = [stop('a', 'r1'), stop('b', 'r1'), stop('c', 'r2')]
  const gelezen = [
    stop('a', 'r1', { opgehaald_at: '2026-11-03T07:00:00Z' }),   // alleen tijd anders: niets
    stop('b', 'r2'),                                              // verplaatst naar een andere rit
    stop('d', 'r2'),                                              // nieuw
  ]
  const v = verschil(bestaand, gelezen, 'stop_id', STOP_VELDEN)
  assert.deepEqual(v.nieuw.map(s => s.stop_id), ['d'])
  assert.deepEqual(v.gewijzigd.map(s => s.stop_id), ['b'])
  assert.deepEqual(v.weg, ['c'])
  assert.deepEqual(verschil(bestaand, bestaand, 'stop_id', STOP_VELDEN), { nieuw: [], gewijzigd: [], weg: [] }, 'niets veranderd: niets schrijven')

  // Database en PostNL schrijven hetzelfde anders: "0.5" vs 0.5, ander ISO-formaat, lege lijst.
  const rit = { rit_id: 'r1', shift: '07', ritnaam: '0703 x', chauffeur: null, chauffeur_wijzigbaar: false, chauffeur_opties: [], geautoriseerd: false, bewerkbaar: true, geblokkeerd: false, stops: 10, stuks: 20, volume: '1.5', deadline: '2026-11-03T10:10:00+00:00', stops_gelezen: 10 }
  const zelfdeRit = { ...rit, volume: 1.5, deadline: '2026-11-03T10:10:00.000Z' }
  assert.equal(verschil([rit], [zelfdeRit], 'rit_id', RIT_VELDEN).gewijzigd.length, 0)
  assert.equal(verschil([rit], [{ ...zelfdeRit, stops: 11 }], 'rit_id', RIT_VELDEN).gewijzigd.length, 1)
  assert.equal(verschil([rit], [{ ...zelfdeRit, chauffeur_opties: ['A'] }], 'rit_id', RIT_VELDEN).gewijzigd.length, 1)
})

test('doorvoer leest alleen de shifts van de wijzigingen, of alles als er een shift ontbreekt (matransport#578)', () => {
  assert.deepEqual(shiftsVan([{ shift: '07', naar_shift: '07' }, { shift: '02', naar_shift: null }]), ['02', '07'])
  assert.deepEqual(shiftsVan([{ shift: '02', naar_shift: '03' }]), ['02', '03'], 'doelrit in een andere shift: ook lezen, dan volgt de nette weigering')
  assert.equal(shiftsVan([{ shift: '07' }, { shift: null }]), null)
  assert.deepEqual(shiftsVan([]), [])
})

test('schoonToevoeging: alleen wat bij het adres hoort (#600, voorbeelden uit planning_stops 06-11, verzonnen)', async () => {
  const { schoonToevoeging: t } = await import('../src/logica.js')
  for (const [in_, uit] of [['A', 'A'], ['a', 'A'], [' 2 ', '2'], ['-A', 'A'], ['/C', 'C'], ['114-', '114'], ['-APP8', 'APP8'], ['(DC3A)', 'DC3A'], ['1EETAGE', '1EETAGE']]) assert.equal(t(in_), uit, in_)
  for (const leeg of ['-', '_-', ',', '.', '`', '', null, undefined, '(COA:1234567890)', '1234AB', ',1234ABPROEFDORP,']) assert.equal(t(leeg), null, String(leeg))
})

test('schoonAdres: straat zonder nummer, postcode of hoofdletters; "Plein 1957" blijft (#600)', async () => {
  const { schoonAdres: a } = await import('../src/logica.js')
  const adres = (Street, BuildingNumber, BuildingNumberExtension = null) => a({ Street, BuildingNumber, BuildingNumberExtension })
  assert.deepEqual(adres('Teststraat 54', '54'), { straat: 'Teststraat', huisnummer: '54', toevoeging: null })
  assert.deepEqual(adres('Proefweg 112 B', '112'), { straat: 'Proefweg', huisnummer: '112', toevoeging: 'B' })
  assert.deepEqual(adres('Oude Testweg 191a', '191'), { straat: 'Oude Testweg', huisnummer: '191', toevoeging: 'A' })
  assert.deepEqual(adres('Testplein 21,', '21'), { straat: 'Testplein', huisnummer: '21', toevoeging: null })
  assert.deepEqual(adres('Testlaan 79/79/', '79'), { straat: 'Testlaan', huisnummer: '79', toevoeging: null })
  assert.deepEqual(adres('Testdijk 1234 AB TESTDIJK, (ZUI', '182', 'TESTDIJK 182'), { straat: 'Testdijk', huisnummer: '182', toevoeging: null })
  assert.deepEqual(adres('Plein 1957', '17'), { straat: 'Plein 1957', huisnummer: '17', toevoeging: null })
  assert.deepEqual(adres('MARIE TESTSTRAAT', '3'), { straat: 'Marie Teststraat', huisnummer: '3', toevoeging: null })
  assert.equal(adres('LAAN VAN DE VRIJHEID', '3').straat, 'Laan van de Vrijheid')
  assert.equal(adres('IJSSELSTRAAT', '3').straat, 'IJsselstraat')
  assert.equal(adres('s-GRAVENWEG', '3').straat, 's-GRAVENWEG')
  assert.equal(adres('', '3').straat, '(onbekend)')
})

test('schoonToevoeging: geen enkel lang nummer, en een postcode alleen als het er echt een is (#600)', async () => {
  const { schoonToevoeging: t } = await import('../src/logica.js')
  for (const leeg of ['1234567890', 'COA-nummer 1234567890', 'COA 123 456 7890', 'coa:123']) assert.equal(t(leeg), null, leeg)
  assert.equal(t('1234 APP'), '1234 APP')
  assert.equal(t('12345AB'), '12345AB')
})

test('kiesGewenst: wat er nog staat gaat door, de rest wordt geteld (#600)', async () => {
  const { kiesGewenst } = await import('../src/logica.js')
  const stops = [{ guid: 'a' }, { guid: 'b' }]
  assert.deepEqual(kiesGewenst(stops, ['a', 'b', 'c']), { gewenst: stops, nietMeer: 1 })
  assert.deepEqual(kiesGewenst(stops, ['c']), { gewenst: [], nietMeer: 1 })
})

test('een fout in de stoptabel noemt de schone waarden, nooit het vrije veld (#600)', async () => {
  const { rijenVoorStops } = await import('../src/logica.js')
  const { problemen } = rijenVoorStops([{ Street: 'Teststraat', BuildingNumber: '1', BuildingNumberExtension: '(COA:1234567890)' }], [])
  assert.equal(problemen[0], 'Teststraat 1 staat niet in de tabel')
})

test('schoonAdres: een vreemd huisnummer laat de lezing nooit crashen (#600)', async () => {
  const { schoonAdres: a } = await import('../src/logica.js')
  for (const nr of ['12)', '12(', '[12', '12\\', '*', '+']) assert.equal(a({ Street: `Teststraat ${nr}`, BuildingNumber: nr }).straat, 'Teststraat', nr)
})
