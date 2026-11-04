// Verzonnen adressen: deze repo is publiek.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { regelSleutel, zetOpPlek, stappenVoorVolgorde, knipDelen, verschillen, vindRegel, revisieTijdTekst, pagingStatus } from '../src/plan.js'

const r = (straat, van, tm, evenOneven = 'Oneven', richting = 'Oplopend') => ({ postcode: '1234AB', straat, van, tm, evenOneven, richting })
const rit = [r('Appelstraat', 1, 9), r('Peerlaan', 2, 20, 'Even'), r('Kerslaan', 1, 1), r('Pruimweg', 3, 7), r('Bessenhof', 2, 2, 'Even')]
const namen = (lijst) => lijst.map(x => x.straat)

test('zetOpPlek: zoals RVA, de rest schuift op', () => {
  assert.deepEqual(namen(zetOpPlek(rit, regelSleutel(rit[0]), 3)), ['Peerlaan', 'Kerslaan', 'Appelstraat', 'Pruimweg', 'Bessenhof'])
  assert.deepEqual(namen(zetOpPlek(rit, regelSleutel(rit[3]), 1)), ['Pruimweg', 'Appelstraat', 'Peerlaan', 'Kerslaan', 'Bessenhof'])
  assert.deepEqual(zetOpPlek(rit, regelSleutel(rit[0]), 2).map(x => x.volgorde), [1, 2, 3, 4, 5])
})

test('zetOpPlek: te hoog wordt de laatste plek, 0 de eerste (gezien 03-11)', () => {
  assert.equal(zetOpPlek(rit, regelSleutel(rit[0]), 99).at(-1).straat, 'Appelstraat')
  assert.equal(zetOpPlek(rit, regelSleutel(rit[4]), 0)[0].straat, 'Bessenhof')
})

test('stappenVoorVolgorde: van boven naar beneden, hooguit één stap per regel', () => {
  const gewenst = ['Bessenhof', 'Appelstraat', 'Kerslaan', 'Peerlaan', 'Pruimweg'].map(s => regelSleutel(rit.find(x => x.straat === s)))
  const stappen = stappenVoorVolgorde(rit, gewenst)
  let stand = rit
  for (const s of stappen) stand = zetOpPlek(stand, s.sleutel, s.nummer)
  assert.deepEqual(stand.map(regelSleutel), gewenst)
  assert.ok(stappen.length <= rit.length - 1)
  assert.deepEqual(stappenVoorVolgorde(rit, rit.map(regelSleutel)), [])
})

test('stappenVoorVolgorde: weigert een lijst met andere regels', () => {
  assert.throws(() => stappenVoorVolgorde(rit, rit.slice(1).map(regelSleutel)))
  assert.throws(() => stappenVoorVolgorde(rit, [...rit.slice(1), rit[1]].map(regelSleutel)))
})

test('knipDelen: rest begint bij het volgende nummer met dezelfde even/oneven', () => {
  assert.deepEqual(knipDelen(r('Peerlaan', 2, 10, 'Even'), 8).map(d => [d.van, d.tm]), [[2, 8], [10, 10]])
  assert.deepEqual(knipDelen(r('Appelstraat', 275, 415), 407).map(d => [d.van, d.tm]), [[275, 407], [409, 415]])
})

test('knipDelen: weigert een nummer buiten de regel of met de verkeerde even/oneven', () => {
  assert.throws(() => knipDelen(r('Peerlaan', 2, 10, 'Even'), 10))
  assert.throws(() => knipDelen(r('Peerlaan', 2, 10, 'Even'), 7))
  assert.throws(() => knipDelen(r('Appelstraat', 1, 9), 0))
})

test('verschillen: leeg bij gelijk, telt plek, inhoud en richting', () => {
  assert.deepEqual(verschillen(rit, rit.map(x => ({ ...x }))), [])
  assert.match(verschillen(rit, zetOpPlek(rit, regelSleutel(rit[0]), 2)).join(), /andere plek/)
  assert.match(verschillen(rit, rit.map((x, i) => (i ? x : { ...x, richting: 'Aflopend' }))).join(), /richting/)
  assert.match(verschillen(rit, [...rit.slice(1), r('Nieuwweg', 1, 1)]).join(), /weg.*nieuw/)
})

test('vindRegel: twee regels met dezelfde inhoud is niet eenduidig', () => {
  assert.throws(() => vindRegel([rit[0], { ...rit[0] }], regelSleutel(rit[0])))
  assert.equal(vindRegel(rit, 'bestaat|niet'), null)
})

test('revisieTijdTekst: zoals de revisielijst hem toont (NL-tijd)', () => {
  assert.equal(revisieTijdTekst(Date.UTC(2026, 10, 2, 23, 34, 48)), '03-11-2026 00:34')
  assert.equal(revisieTijdTekst(Date.UTC(2026, 7, 21, 7, 50, 18)), '21-08-2026 09:50')
})

test('ritRijen: scherm is de basis, nummer uit de antwoorden, en ritten die niet op het scherm staan erbij', async () => {
  const { ritRijen } = await import('../src/plan.js')
  const trips = [{ naam: '0114 Proef', nummer: '0114', dagen: ['Ma', 'Di'], verantwoordelijken: ['A'] }, { naam: '0216 Ander', nummer: '0216', dagen: ['Za'], verantwoordelijken: [] }]
  const scherm = [
    { ritnaam: '0114 Proef', dagen: ['Ma'], opSlot: [], verantwoordelijkenTekst: 'A, B' },
    { ritnaam: '0114 Proef', dagen: ['Di', 'Wo'], opSlot: ['Wo'], verantwoordelijkenTekst: '' },
  ]
  const rijen = ritRijen(trips, scherm)
  assert.deepEqual(rijen.map(x => x.sleutel), ['0114|Ma', '0114|Di', '0216|Za'])
  assert.deepEqual(rijen[0].verantwoordelijken, ['A', 'B'])
  assert.deepEqual(rijen[1].verantwoordelijken, ['A'], 'leeg op het scherm: uit de antwoorden')
  assert.deepEqual(rijen[1].vergrendeld_dagen, ['Wo'])
  assert.equal(rijen[0].ritnummer, '114')
  assert.equal(ritRijen([], [{ ritnaam: '0307 Zonder', dagen: ['Ma'] }])[0].ritnummer, '307', 'nummer uit de naam')
})

test('rittenTeSchrijven: alleen nieuw of anders, en alles na 12 uur opnieuw (gezien_at)', async () => {
  const { rittenTeSchrijven } = await import('../src/plan.js')
  const nu = new Date('2026-11-04T12:00:00Z')
  const rij = { sleutel: 's', naam: 'n', trip_nummer: '1', ritnummer: '1', dagen: ['Ma'], verantwoordelijken: [], vergrendeld_dagen: [] }
  assert.deepEqual(rittenTeSchrijven([{ ...rij, gezien_at: '2026-11-04T11:00:00Z' }], [rij], nu), [])
  assert.equal(rittenTeSchrijven([{ ...rij, gezien_at: '2026-11-03T20:00:00Z' }], [rij], nu).length, 1)
  assert.equal(rittenTeSchrijven([{ ...rij, dagen: ['Di'], gezien_at: '2026-11-04T11:00:00Z' }], [rij], nu).length, 1)
  assert.equal(rittenTeSchrijven([], [rij], nu).length, 1)
})

test('volgendeBijlezen: eerst wat ontbreekt, dan de oudste boven de grens; overslaan werkt; alles vers = null', async () => {
  const { volgendeBijlezen } = await import('../src/plan.js')
  const nu = new Date('2026-11-04T12:00:00Z')
  const ritten = [{ naam: 'A', dagen: ['Ma', 'Di'] }, { naam: 'B', dagen: ['Za'] }]
  const vers = '2026-11-04T11:00:00Z'
  assert.deepEqual(volgendeBijlezen(ritten, [{ rit: 'A', weekdag: 'Ma', gelezen_at: vers }, { rit: 'B', weekdag: 'Za', gelezen_at: vers }], nu), { rit: 'A', weekdag: 'Di' })
  assert.deepEqual(volgendeBijlezen(ritten, [
    { rit: 'A', weekdag: 'Ma', gelezen_at: '2026-11-03T20:00:00Z' }, { rit: 'A', weekdag: 'Di', gelezen_at: '2026-11-04T01:00:00Z' }, { rit: 'B', weekdag: 'Za', gelezen_at: vers },
  ], nu), { rit: 'A', weekdag: 'Ma' })
  assert.deepEqual(volgendeBijlezen(ritten, [{ rit: 'A', weekdag: 'Ma', gelezen_at: null }, { rit: 'A', weekdag: 'Di', gelezen_at: vers }, { rit: 'B', weekdag: 'Za', gelezen_at: vers }], nu), { rit: 'A', weekdag: 'Ma' }, 'verouderd (null) telt als ontbrekend')
  assert.equal(volgendeBijlezen(ritten, [], nu, { overslaan: () => true }), null)
  assert.equal(volgendeBijlezen(ritten, ['Ma', 'Di'].map(d => ({ rit: 'A', weekdag: d, gelezen_at: vers })).concat({ rit: 'B', weekdag: 'Za', gelezen_at: vers }), nu), null)
})

test('pagingStatus: de status onder het Rittenoverzicht (matransport#573)', () => {
  assert.deepEqual(pagingStatus('1 to 20 of 40'), { tot: 20, totaal: 40 })
  assert.deepEqual(pagingStatus('21 to 40 of 40'), { tot: 40, totaal: 40 })
  assert.deepEqual(pagingStatus(' 1 tot 7 van 7 '), { tot: 7, totaal: 7 })
  assert.equal(pagingStatus(null), null)
  assert.equal(pagingStatus('Geen resultaten'), null)
})
