import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  adresSleutel, deadlineUitTekst, foutVoorPlanner, teOudeTraces, traceAan, gebruikerBijNaam, getal, ritnummerVan, isWeigering, objectenUit, redenNietUitvoeren, rijenVoorStops, shiftReden, shiftsVan, rittenUit,
  selectieKlopt, stopNaarRij, stopsUit, tvi, tviTijd, volgordeAfwijkingen, isPostnlPunt, schoonToevoeging, uniekeMeldingen, verschil, zonderVelden, STOP_VELDEN, OPTIONELE_STOP_VELDEN,
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
    straat: 'Abel Tasmanstraat', huisnummer: '8', toevoeging: null, postcode: '2676AA', stuks: 1, volume: 0.019, postnl_punt: false, tvi_tijd: '2026-10-31T17:18:00.000Z', opgehaald_at: 't',
  })
})

test('TVI-tijd per stop als ISO-tijd, leeg of onzin wordt null (matransport#603)', () => {
  assert.equal(tviTijd(1793467080000), '2026-10-31T17:18:00.000Z')
  assert.equal(tviTijd('1793467080000'), '2026-10-31T17:18:00.000Z')
  for (const leeg of [null, undefined, '', 0, -5, 'abc']) assert.equal(tviTijd(leeg), null)
})

test('gewijzigde TVI-tijd telt als wijziging, dezelfde tijd in een andere notatie niet (matransport#603)', () => {
  const oud = { stop_id: 's1', rit_id: 'r1', shift: '01', straat: 'X', huisnummer: '1', toevoeging: null, postcode: '2676AA', stuks: 1, volume: 0.1, tvi_tijd: null }
  const nu = { ...oud, tvi_tijd: '2026-10-31T17:18:00.000Z' }
  assert.equal(verschil([oud], [nu], 'stop_id', STOP_VELDEN).gewijzigd.length, 1)
  assert.equal(verschil([{ ...oud, tvi_tijd: '2026-10-31T17:18:00+00:00' }], [nu], 'stop_id', STOP_VELDEN).gewijzigd.length, 0)
})

test('stopobject zonder PlannedStopTime laat tvi_tijd weg, zodat de bekende tijd blijft (matransport#603)', () => {
  const rij = stopNaarRij({ guid: '1', Street: 'X' }, { klantId: 'k', depot: 'd', datum: '2026-11-10', shift: '01', ritId: 'R1', opgehaaldAt: 't' })
  assert.equal('tvi_tijd' in rij, false)
  const oud = { stop_id: '1', tvi_tijd: '2026-10-31T17:18:00+00:00' }
  assert.equal(verschil([oud], [{ stop_id: '1' }], 'stop_id', ['tvi_tijd']).gewijzigd.length, 0)
})

test('volgorde uit de stoplijst wordt tvi_volgorde, zonder volgorde geen veld (matransport#603)', () => {
  const opties = { klantId: 'k', depot: 'd', datum: '2026-11-10', shift: '01', ritId: 'R1', opgehaaldAt: 't' }
  assert.equal(stopNaarRij({ guid: '1', Street: 'X' }, { ...opties, volgorde: 3 }).tvi_volgorde, 3)
  assert.equal('tvi_volgorde' in stopNaarRij({ guid: '1', Street: 'X' }, opties), false)
  assert.equal('tvi_volgorde' in stopNaarRij({ guid: '1', Street: 'X' }, { ...opties, volgorde: 0 }), false)
})

test('volgorde van het antwoord naast het scherm: plekken die anders zijn (matransport#603)', () => {
  const t = Date.UTC(2026, 10, 10, 12, 10)
  const stops = [{ Street: 'A', BuildingNumber: '1', PlannedStopTime: t }, { Street: 'B', BuildingNumber: '2', PlannedStopTime: t }]
  const rij = (s) => ({ tijd: tvi(s.PlannedStopTime), straat: s.Street, nummer: s.BuildingNumber, toevoeging: '' })
  assert.equal(volgordeAfwijkingen(stops, stops.map(rij)), 0)
  assert.equal(volgordeAfwijkingen(stops, [rij(stops[1]), rij(stops[0])]), 2)
  assert.equal(volgordeAfwijkingen(stops, [rij(stops[0])]), 1)
  assert.equal(volgordeAfwijkingen(stops, []), null)
})

test('ontbrekende kolom gaat uit de rij, de rest blijft (matransport#603)', () => {
  const rij = { stop_id: 's1', postcode: '2676AA', tvi_tijd: 't', straat: 'X' }
  assert.equal(zonderVelden(rij, new Set()), rij)
  assert.deepEqual(zonderVelden(rij, new Set(['tvi_tijd'])), { stop_id: 's1', postcode: '2676AA', straat: 'X' })
  for (const v of OPTIONELE_STOP_VELDEN) assert.ok(STOP_VELDEN.includes(v))
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
  for (const [in_, uit] of [['A', 'A'], ['a', 'A'], [' 2 ', '2'], ['-A', 'A'], ['/C', 'C'], ['114-', '114'], ['-APP8', '8'], ['(DC3A)', 'DC3A']]) assert.equal(t(in_), uit, in_)
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
  assert.equal(t('1234 APP'), null)
  assert.equal(t('12345AB'), null)
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

test('schoonToevoeging: een witte lijst, want het veld bevat ook namen en plaatsen (#600, verzonnen)', async () => {
  const { schoonToevoeging: t } = await import('../src/logica.js')
  const goed = [['A', 'A'], ['22', '22'], ['K101', 'K101'], ['BU 3', 'BU3'], ['A- 2', 'A2'], ['A 39', 'A39'], ['APP 8', '8'], ['AP-03', '3'], ['APP 022', '22'], ['KAMER 321', '321'], ['UNIT C1243', 'C1243'], ['BU2', 'BU2']]
  for (const [in_, uit] of goed) assert.equal(t(in_), uit, in_)
  // Een dubbele letter bestaat niet in het adresregister.
  for (const [in_, uit] of [['AA', 'A'], ['B B', 'B'], ['dd', 'D']]) assert.equal(t(in_), uit, in_)
  for (const [in_, uit] of [['DC3A', 'DC3A'], ['BU10', 'BU10'], ['KAR28', 'KAR28'], ['A13A', 'A13A'], ['BG', 'BG'], ['COA 123 B', 'B']]) assert.equal(t(in_), uit, in_)
  // Eerst de toevoeging, daarna een plaats of straat.
  for (const [in_, uit] of [['C PROEFDORP', 'C'], ['55 TESTLAAN', '55'], ['2 PROEF EN TEST', '2'], ['A DEUR 5', 'A'], ['1E ETAGE', '1E'], ['– 18', '18']]) assert.equal(t(in_), uit, in_)
  // Namen van mensen, bedrijven, plaatsen en omschrijvingen horen hier nooit in.
  for (const weg of ['T.A.V. JAN TEST', 'T.A.V. J VAN DE PROEF', 'C/O NV', 'POSTBUS 10', 'PROEFDORP', 'DEN TEST', 'S-PROEFDORP', 'WOONHUIS', 'APPARTEMENT', 'EERSTE VERDIEPING', 'TEST BV', 'TESTWINKEL POSTNL PAKKETP', 'PROEFLAND60', 'HUISJE15', 'HUIS1', '1HOOG', 'JAN', 'BV', 'COACH', 'VAN DO', 'OP´T', 'DR.X,Y,Z', '1234, 2F', 'TEST HUIS 34TEST HUIS', '1-2', '12/3']) assert.equal(t(weg), null, weg)
})

test('schoonStraat: plaats, tekens, afkorting en "Onbekend" gaan weg (#600, verzonnen)', async () => {
  const { schoonAdres: a } = await import('../src/logica.js')
  const straat = (s, nr = '3', extra = null) => a({ Street: s, BuildingNumber: nr, BuildingNumberExtension: extra }).straat
  for (const [in_, uit] of [
    ['Teststraat , Proefdorp', 'Teststraat'], ['Teststraat, ,\'S-PROEFDORP', 'Teststraat'], ['Teststraat , ZUID HOLLAND', 'Teststraat'], ['Teststraat , 1234567890', 'Teststraat'],
    ['Teststraat _', 'Teststraat'], ['Teststraat_', 'Teststraat'], ['Teststraat /', 'Teststraat'], ['Teststraat.', 'Teststraat'],
    ['teststraat', 'Teststraat'], ['de oude testlaan', 'De Oude Testlaan'], ['laan van de test', 'Laan van de Test'],
    ['Pieter Teststr', 'Pieter Teststraat'], ['Oude Testln', 'Oude Testlaan'], ['R Testsngl', 'R Testsingel'], ['Proefwg', 'Proefweg'], ['Testpln', 'Testplein'], ['Oude Testgr', 'Oude Testgracht'], ['Teststraat -C', 'Teststraat'],
    ["\\'s-Testweg", "'s-Testweg"], ['Theo d’Testsingel', "Theo d'Testsingel"],
    ['Onbekend', '(onbekend)'], ['onbekend', '(onbekend)'], ['(onbekend)', '(onbekend)'],
    ['Nes', 'Nes'], ['Laan', 'Laan'], ['Plein 1957', 'Plein 1957'], ['Köln', 'Köln'], ['Wijk A', 'Wijk A'],
  ]) assert.equal(straat(in_), uit, in_)
  assert.deepEqual(a({ Street: 'Teststraat 7 Teststraat', BuildingNumber: '7' }), { straat: 'Teststraat', huisnummer: '7', toevoeging: null })
  assert.deepEqual(a({ Street: 'Teststraat 10 BU2', BuildingNumber: '10' }), { straat: 'Teststraat', huisnummer: '10', toevoeging: 'BU2' })
  assert.deepEqual(a({ Street: '5 Lange Test', BuildingNumber: '5' }), { straat: 'Lange Test', huisnummer: '5', toevoeging: null })
  assert.equal(a({ Street: '18 Septemberplein', BuildingNumber: '18' }).straat, '18 Septemberplein', 'een datum in de straatnaam blijft')
  assert.deepEqual(a({ Street: 'Teststraat 5--', BuildingNumber: '5' }), { straat: 'Teststraat', huisnummer: '5', toevoeging: null })
  assert.deepEqual(a({ Street: 'Teststraat 71-', BuildingNumber: '71' }), { straat: 'Teststraat', huisnummer: '71', toevoeging: null })
  assert.deepEqual(a({ Street: 'Teststraat A, Proefdorp', BuildingNumber: '9' }), { straat: 'Teststraat', huisnummer: '9', toevoeging: 'A' })
  assert.deepEqual(a({ Street: 'Teststraat b', BuildingNumber: '9', BuildingNumberExtension: 'C' }), { straat: 'Teststraat', huisnummer: '9', toevoeging: 'C' })
})

test('schoonPostcode: alleen een echte Nederlandse postcode (#600)', async () => {
  const { schoonPostcode: p } = await import('../src/logica.js')
  for (const [in_, uit] of [['1234AB', '1234AB'], ['1234 ab', '1234AB'], [' 1234  AB ', '1234AB']]) assert.equal(p(in_), uit, in_)
  for (const weg of ['0000FF', '0123AB', '1234SS', '1234SA', '1234SD', '1234', '12345', '', null, undefined]) assert.equal(p(weg), null, String(weg))
})

test('straatUitWeergave: de naam uit het register, alleen als het dit adres is (#600)', async () => {
  const { straatUitWeergave: s } = await import('../src/logica.js')
  assert.equal(s('Teststraat 24, 1234AB Proefdorp', '1234AB', '24'), 'Teststraat')
  assert.equal(s('Teststraat 24A, 1234AB Proefdorp', '1234AB', '24'), 'Teststraat')
  assert.equal(s('Teststraat 24-2, 1234AB Proefdorp', '1234AB', '24'), 'Teststraat')
  assert.equal(s('Teststraat 24e-1, 1234AB Proefdorp', '1234AB', '24'), 'Teststraat')
  assert.equal(s('Plein 1957 37, 1234AB Proefdorp', '1234AB', '37'), 'Plein 1957')
  assert.equal(s("'s-Testweg 3, 1234AB Proefdorp", '1234AB', '3'), "'s-Testweg")
  assert.equal(s('Dr. J. Teststraat 3, 1234AB Proefdorp', '1234AB', '3'), 'Dr. J. Teststraat')
  assert.equal(s('G.J. Teststr 3, 1234AB Proefdorp', '1234AB', '3'), 'G.J. Teststraat', 'het register kort zelf ook af')
  assert.equal(s('Teststraat 24, 1234AC Proefdorp', '1234AB', '24'), null, 'andere postcode')
  assert.equal(s('Teststraat 25, 1234AB Proefdorp', '1234AB', '24'), null, 'ander nummer')
  assert.equal(s('Teststraat 245, 1234AB Proefdorp', '1234AB', '24'), null, 'ander nummer')
  assert.equal(s('Teststraat, 1234AB Proefdorp', '1234AB', '24'), null, 'alleen de straat')
  assert.equal(s(null, '1234AB', '24'), null)
})

test('straatUitRegister: twee namen voor één adres = niet kiezen (#600)', async () => {
  const { straatUitRegister: r } = await import('../src/logica.js')
  const m = r([
    { postcode: '1234AB', huisnummer: '1', weergavenaam: 'Teststraat 1, 1234AB Proefdorp' },
    { postcode: '1234AB', huisnummer: '1', weergavenaam: 'Teststraat 1A, 1234AB Proefdorp' },
    { postcode: '1234AC', huisnummer: '2', weergavenaam: 'Teststraat 2, 1234AC Proefdorp' },
    { postcode: '1234AC', huisnummer: '2', weergavenaam: 'Proefweg 2, 1234AC Proefdorp' },
    { postcode: '1234AD', huisnummer: '3', weergavenaam: 'Teststraat 4, 1234AD Proefdorp' },
  ])
  assert.deepEqual([...m], [['1234AB|1', 'Teststraat']])
})

test('stopNaarRij: de officiële straat gaat voor wat de afzender typte (#600)', async () => {
  const { stopNaarRij } = await import('../src/logica.js')
  const stop = { guid: 'g', Street: 'T Proefweg', BuildingNumber: '1', BuildingNumberExtension: 'A', PostalCode: '1234 ab' }
  const ctx = { klantId: 'k', depot: 'd', datum: '2026-11-06', shift: '07', ritId: 'r', opgehaaldAt: 'nu' }
  const rij = stopNaarRij(stop, { ...ctx, straten: new Map([['1234AB|1', 'Teststraat']]) })
  assert.deepEqual([rij.straat, rij.huisnummer, rij.toevoeging, rij.postcode], ['Teststraat', '1', 'A', '1234AB'])
  assert.equal(stopNaarRij(stop, ctx).straat, 'T Proefweg', 'zonder register blijft de opgeschoonde staan')
  assert.equal(stopNaarRij({ ...stop, Street: 'Onbekend', PostalCode: '0000FF' }, ctx).straat, '(onbekend)')
  assert.equal(stopNaarRij({ ...stop, PostalCode: '0000FF' }, ctx).postcode, null)
})

test('postcodesOpnieuwZetten: alleen als er geen stops binnenkwamen en de tabel leeg is (matransport#666)', async () => {
  const { postcodesOpnieuwZetten } = await import('../src/logica.js')
  assert.equal(postcodesOpnieuwZetten({ stops: 0, rijen: 0 }), true)
  assert.equal(postcodesOpnieuwZetten({ stops: 222, rijen: 0 }), false)
  assert.equal(postcodesOpnieuwZetten({ stops: 0, rijen: 12 }), false)
})

test('bronNietGelezen: kop met stops en een lege lezing = niets verplaatsen, geen "staan niet meer" (matransport#666)', async () => {
  const { bronNietGelezen } = await import('../src/logica.js')
  const bron = { ritnaam: '0218 wat hoofdstad', stops: 220 }
  assert.match(bronNietGelezen(bron, []), /konden niet gelezen worden\. Er is niets verplaatst/)
  assert.equal(bronNietGelezen(bron, [{ guid: 'a' }]), null)
  // Een rit die echt leeg is (kop 0): dan gewoon de gewone weg ("staan niet meer").
  assert.equal(bronNietGelezen({ ritnaam: '0218', stops: 0 }, []), null)
})

test('controleUitkomst: niets gelezen van de doelrit is iets anders dan stops die ontbreken (matransport#666)', async () => {
  const { controleUitkomst, adresSleutel } = await import('../src/logica.js')
  const s = (n) => ({ PostalCode: '2651AB', Street: 'Straat', BuildingNumber: String(n), BuildingNumberExtension: '' })
  const gewenst = [s(1), s(2)]
  const doel = { ritnaam: '0712 Berkel Vogelbuurt' }
  const niets = controleUitkomst({ gewenst, inDoel: new Set(), gelezen: false, doel })
  assert.equal(niets.status, 'mislukt')
  assert.match(niets.melding, /is gegeven, maar die rit kon daarna niet gelezen worden/)
  assert.doesNotMatch(niets.melding, /staan na de actie niet/)
  const half = controleUitkomst({ gewenst, inDoel: new Set([adresSleutel(s(1))]), gelezen: true, doel, dialoog: 'Let op' })
  assert.match(half.melding, /^1 stop\(s\) staan na de actie niet in 0712 Berkel Vogelbuurt \(PostNL: Let op\)/)
  assert.equal(controleUitkomst({ gewenst, inDoel: new Set(gewenst.map(adresSleutel)), gelezen: true, doel }), null)
})

test('gebouwnummer in de straat: "Teststraat 22-A" nr 8 wordt 22 + A8, alleen als het register het zo kent (matransport#667, verzonnen)', async () => {
  const { stopNaarRij, gebouwUitStraat, woningenUitRegister, adresParen } = await import('../src/logica.js')
  const register = [
    { postcode: '1234AB', huisnummer: '22', weergavenaam: 'Teststraat 22A-16, 1234AB Proefdorp' },
    { postcode: '1234AB', huisnummer: '22', weergavenaam: 'Teststraat 22A-4, 1234AB Proefdorp' },
    { postcode: '1234AB', huisnummer: '40', weergavenaam: 'Teststraat 40, 1234AB Proefdorp' },
    // Hoekpand: twee straatnamen, dus geen officiële straat, maar het adres bestaat wel.
    { postcode: '1234AB', huisnummer: '6', weergavenaam: 'Teststraat 6, 1234AB Proefdorp' },
    { postcode: '1234AB', huisnummer: '6', weergavenaam: 'Zijweg 6, 1234AB Proefdorp' },
  ]
  const gevonden = woningenUitRegister(register)
  assert.deepEqual([...gevonden.get('1234AB|22').letters], ['A'])
  assert.deepEqual([...gevonden.get('1234AB|40').letters], [])
  // Zoals vulStraten ze vult: elk opgezocht paar staat erin, zonder rij als null.
  const opgezocht = ['1234AB|22', '1234AB|40', '1234AB|6', '1234AB|8', '1234AB|5']
  const woningen = new Map(opgezocht.map(p => [p, gevonden.get(p) ?? null]))
  const straten = new Map([['1234AB|22', 'Teststraat'], ['1234AB|40', 'Teststraat'], ['1234AB|6', null], ['1234AB|8', null], ['1234AB|5', null]])
  const rij = (Street, BuildingNumber, BuildingNumberExtension = null, w = woningen) => {
    const r = stopNaarRij({ guid: 'g', Street, BuildingNumber, BuildingNumberExtension, PostalCode: '1234 AB' }, { klantId: 'k', depot: 'd', datum: '2026-11-10', shift: '02', ritId: 'R', opgehaaldAt: 't', straten, woningen: w })
    return [r.straat, r.huisnummer, r.toevoeging]
  }
  assert.deepEqual(rij('TESTSTRAAT 22-A', '8'), ['Teststraat', '22', 'A8'])
  assert.deepEqual(rij('Teststraat 22A', '8'), ['Teststraat', '22', 'A8'])
  assert.deepEqual(rij('Teststraat 22 a,', '5'), ['Teststraat', '22', 'A5'])
  // Niet: het huisnummer heeft zelf een rij (ook een hoekpand), het gebouw heeft geen woningen met die
  // letter, er is al een toevoeging, of het paar is niet opgezocht.
  assert.deepEqual(rij('Teststraat 22-A', '6'), ['Teststraat 22-A', '6', null])
  assert.equal(rij('Teststraat 22-A', '40')[1], '40')
  assert.equal(rij('Teststraat 22-B', '8')[1], '8')
  assert.equal(rij('Teststraat 40-A', '8')[1], '8')
  assert.equal(rij('Teststraat 22-A', '8', 'C')[1], '8')
  assert.equal(rij('Teststraat 22-A', '8', null, new Map([['1234AB|22', gevonden.get('1234AB|22')]]))[1], '8')
  // Wat er niet doorheen komt.
  assert.equal(gebouwUitStraat('Teststraat 54', '54'), null)
  assert.equal(gebouwUitStraat('Teststraat 12', '30'), null, 'zonder letter: kan een tikfout zijn')
  assert.equal(gebouwUitStraat('Plein 1957', '4'), null)
  assert.equal(gebouwUitStraat('Teststraat 00 A', '54'), null)
  assert.equal(gebouwUitStraat('Teststraat', '8'), null)
  assert.equal(gebouwUitStraat('22 A', '8'), null)
  assert.deepEqual(adresParen({ Street: 'Teststraat 22-A', BuildingNumber: '8', PostalCode: '1234AB' }), ['1234AB|8', '1234AB|22'])
  assert.deepEqual(adresParen({ Street: 'Teststraat', BuildingNumber: '8', PostalCode: '1234AB' }), ['1234AB|8'])
  assert.deepEqual(adresParen({ Street: 'Teststraat 22-A', BuildingNumber: '8', PostalCode: '0000FF' }), [])
})

test('PBA is geen toevoeging maar de vlag postnl_punt (matransport#603)', () => {
  assert.equal(schoonToevoeging('PBA', '142'), null)
  assert.equal(isPostnlPunt('PBA'), true)
  assert.equal(isPostnlPunt(' pba '), true)
  for (const nee of [null, '', 'A', 'BU2', 'PB']) assert.equal(isPostnlPunt(nee), false)
  const opties = { klantId: 'k', depot: 'd', datum: '2026-11-10', shift: '01', ritId: 'R1', opgehaaldAt: 't' }
  const rij = stopNaarRij({ guid: '1', Street: 'Choorstraat', BuildingNumber: '1', BuildingNumberExtension: 'PBA', PostalCode: '2681AN' }, opties)
  assert.equal(rij.postnl_punt, true)
  assert.equal(rij.toevoeging, null)
  assert.equal(stopNaarRij({ guid: '2', Street: 'X', BuildingNumber: '1' }, opties).postnl_punt, false)
})

test('toevoeging gelijk aan het huisnummer met leestekens of voorloopnullen gaat weg (matransport#603)', () => {
  for (const t of ['-29', '29.', '029', '29']) assert.equal(schoonToevoeging(t, '29'), null, t)
  assert.equal(schoonToevoeging('A', '29'), 'A')
  assert.equal(schoonToevoeging('29', '30'), '29')
})

test('een stop in een andere rit telt als verhuisd, een andere wijziging niet (matransport#603)', async () => {
  const { verhuisdeStops } = await import('../src/logica.js')
  const bestaand = [{ stop_id: 'a', rit_id: 'R1' }, { stop_id: 'b', rit_id: 'R1' }]
  assert.deepEqual(verhuisdeStops(bestaand, [{ stop_id: 'a', rit_id: 'R2' }, { stop_id: 'b', rit_id: 'R1', stuks: 3 }, { stop_id: 'c', rit_id: 'R2' }]), ['a'])
  assert.deepEqual(verhuisdeStops(bestaand, []), [])
})
