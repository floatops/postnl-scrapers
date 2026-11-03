// node --test — Dagplanning lezen uit Mendix-antwoorden en naar `ritten` schrijven (floatops/matransport#562).
// De antwoorden zijn nagemaakt in de vorm van een echte opname (Mendix /xas/, 02-11), zonder
// echte namen, adressen of depots: deze repo is publiek.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { dagplanningRitten, shiftsUit } from '../src/postnl/ritten.js'
import { planRitten, ritSleutel, schrijfDagplanning } from '../src/postnl/schrijver.js'
import { dagVenster } from '../src/postnl/dagplanningScherm.js'
import { decimaalTekst, normaliseerDuur, ritIdDelen, deadlineUitTekst, getalUit } from '../src/postnl/tekst.js'

const w = (value) => ({ value, readonly: true })
const ref = (guid, objectType, attributes = {}) => ({ guid, objectType, attributes })

// Zoals Mendix het stuurt: een RideNumber met de Ride genest, de Ride met chauffeur en eigenaar genest.
function ritNummer({ guid, ritGuid, rideId, naam, chauffeur, shiftGuid, stops, stuks, volume, gewicht, brief, duur, geautoriseerd = false }) {
  return {
    guid, objectType: 'OperationalPlanning.RideNumber',
    attributes: {
      Stops: w(String(stops)), Pieces: w(String(stuks)), Volume: w(volume), Weight: w(gewicht),
      MailboxOnlyStops: w(String(brief)), TotalRideTime: w(duur), RideID: w(rideId),
      'OperationalPlanning.RideNumber_Shift': w(shiftGuid),
      'OperationalPlanning.RideNumber_Ride': w(ref(ritGuid, 'OperationalPlanning.Ride', {
        RideName: w(naam), RideID: w(rideId),
        Enum_Authorized: w(geautoriseerd ? '_True' : '_False'), Authorized: w(geautoriseerd),
        'OperationalPlanning.Ride_Shift': w(shiftGuid),
        'OperationalPlanning.OperationalRide_Driver': w(chauffeur === null ? null : ref(`d-${ritGuid}`, 'Planning.Driver', { LastNameInitials: w(chauffeur) })),
      })),
    },
  }
}

const shiftObj = (guid, naam) => ({ guid, objectType: 'OperationalPlanning.Shift', attributes: { Name: w(naam), ShiftID: w(naam) } })

const ochtend = {
  objects: [shiftObj('s1', '01'), shiftObj('s3', '03')],
  partialObjects: [
    ritNummer({ guid: 'n1', ritGuid: 'r1', rideId: '20261102_HD_100001_0114', naam: '0114 volume', chauffeur: 'JANSEN, A.', shiftGuid: 's1', stops: 5, stuks: 276, volume: '3.94', gewicht: '387', brief: 0, duur: '2u 18m', geautoriseerd: true }),
    ritNummer({ guid: 'n2', ritGuid: 'r2', rideId: '20261102_HD_100001_0307', naam: '0307 buiten', chauffeur: null, shiftGuid: 's3', stops: 168, stuks: 220, volume: '12.5', gewicht: '1234.5', brief: 23, duur: '6u 5m' }),
  ],
}

test('dagplanningRitten: alle velden uit de antwoorden, in de vorm van `ritten`', () => {
  const [a, b] = dagplanningRitten([ochtend])
  assert.equal(a.ritnummer, '114')
  assert.equal(a.kanaal, 'HD')
  assert.equal(a.datum, '2026-11-02')
  assert.equal(a.rit_id, 'r1')
  assert.equal(a.geautoriseerd, true)
  assert.equal(a.shiftPostnl, '1')
  assert.deepEqual(a.velden, {
    postnl_stops: 5, postnl_stuks: 276, postnl_volume: '3,94', postnl_gewicht: '387,00',
    postnl_briefbusstops: 0, postnl_geplande_duur: '2:18', postnl_ritnaam: '0114 volume',
    postnl_chauffeur: 'JANSEN, A.', postnl_shift: '1', postnl_rit_id: 'r1', postnl_geautoriseerd: true,
  })
  assert.equal(b.velden.postnl_chauffeur, null, 'geen chauffeur gekoppeld = leeg')
  assert.equal(b.velden.postnl_gewicht, '1234,50', 'geen duizendtalpunt, zoals in ritten')
  assert.equal(b.geautoriseerd, false)
})

test('dagplanningRitten: een later antwoord vult aan, een ontbrekend veld blijft weg (overschrijft niets)', () => {
  const alleenTotalen = { partialObjects: [{ guid: 'n1', objectType: 'OperationalPlanning.RideNumber', attributes: { Stops: w('6'),
    'OperationalPlanning.RideNumber_Ride': w(ref('r1', 'OperationalPlanning.Ride', { RideName: w('0114 volume') })) } }] }
  const [a] = dagplanningRitten([ochtend, alleenTotalen])
  assert.equal(a.velden.postnl_stops, 6)
  assert.equal(a.velden.postnl_stuks, 276, 'uit het eerdere antwoord')
  const [los] = dagplanningRitten([alleenTotalen])
  assert.equal('postnl_stuks' in los.velden, false)
  assert.equal('postnl_chauffeur' in los.velden, false, 'chauffeur onbekend ≠ geen chauffeur')
})

test('kanaal zonder RideID: uit het scherm, anders onbekend en niet geschreven', () => {
  const zonderId = { partialObjects: [{ guid: 'n9', objectType: 'OperationalPlanning.RideNumber', attributes: { Stops: w('3'),
    'OperationalPlanning.RideNumber_Ride': w(ref('r9', 'OperationalPlanning.Ride', { RideName: w('0242 dorp') })) } }] }
  const scherm = { objects: [
    { guid: 'dp', objectType: 'OperationalPlanning.DisplayPlanning', attributes: { 'OperationalPlanning.DisplayPlanning_DistributionChannel': w('c1') } },
    { guid: 'c1', objectType: 'Planning.DistributionChannel', attributes: { DistributionChannelID: w('HD'), Description: w('Huisdistributie') } },
  ] }
  assert.equal(dagplanningRitten([zonderId])[0].kanaal, null)
  assert.equal(dagplanningRitten([scherm, zonderId])[0].kanaal, 'HD')
  const plan = planRitten({ bestaande: [], gelezen: dagplanningRitten([zonderId]), klantId: 'k', datum: 'd', depot: 'D', nu: NU })
  assert.deepEqual(plan.inserts, [])
  assert.deepEqual(plan.kanaalOnbekend, ['242'])
})

test('shiftsUit: de shifts van die dag, niet een vaste lijst', () => {
  assert.deepEqual(shiftsUit([ochtend]), ['01', '03'])
})

test('tekst: RideID, decimalen, duur en deadline', () => {
  assert.deepEqual(ritIdDelen('20261102_AD_161099_0307'), { datum: '2026-11-02', kanaal: 'AD', ritnummer: '307' })
  assert.equal(ritIdDelen('rommel'), null)
  assert.equal(getalUit('3.94'), 3.94)
  assert.equal(getalUit('1.234,50'), 1234.5)
  assert.equal(decimaalTekst('2.7'), '2,70')
  assert.equal(normaliseerDuur('2u 18m'), '2:18')
  assert.equal(normaliseerDuur('5u'), '5:00')
  assert.equal(normaliseerDuur('8'), null)
  assert.equal(deadlineUitTekst('Ritten kunnen tot 07:15 uur worden aangepast.', '2026-11-02'), '2026-11-02T06:15:00.000Z')
  assert.equal(deadlineUitTekst('Ritten kunnen tot 07:15 uur worden aangepast.', '2026-07-01'), '2026-07-01T05:15:00.000Z')
})

const NU = '2026-11-02T06:00:00.000Z'

test('planRitten: HD en AD met hetzelfde nummer zijn twee ritten (#560), niets wordt verwijderd', () => {
  const bestaande = [
    { id: 'hd', ritnummer: '307', postnl_kanaal: null, postnl_stops: 168 },
    { id: 'ad', ritnummer: '307', postnl_kanaal: 'AD', postnl_stops: 16 },
  ]
  const gelezen = [{ ritnummer: '307', kanaal: 'HD', shift: '3', velden: { postnl_stops: 170 } }]
  const plan = planRitten({ bestaande, gelezen, klantId: 'k', datum: '2026-11-02', depot: 'D', nu: NU })
  assert.equal(plan.inserts.length, 0)
  assert.deepEqual(plan.updates.map(u => u.id), ['hd'])
  assert.equal(plan.updates[0].velden.postnl_stops, 170)
  assert.equal(ritSleutel('0307', null), ritSleutel('307', 'HD'))
})

test('planRitten: alleen gewijzigde velden, nieuwe rit met klant, kanaal en status', () => {
  const bestaande = [{ id: 'x', ritnummer: '114', postnl_kanaal: 'HD', postnl_stops: 5, postnl_volume: '3,94', postnl_laatst_opgehaald: '2026-11-02T05:00:00+00:00', postnl_sync_status: 'opgehaald', postnl_sync_error: null }]
  const gelezen = [
    { ritnummer: '114', kanaal: 'HD', shift: '1', velden: { postnl_stops: 5, postnl_volume: '3,94' } },
    { ritnummer: '901', kanaal: 'GB', shift: '9', velden: { postnl_stops: 40 } },
  ]
  const plan = planRitten({ bestaande, gelezen, klantId: 'k', datum: '2026-11-02', depot: 'D', nu: NU })
  assert.deepEqual(plan.updates, [], 'niets veranderd: niets schrijven, dus ook niets live naar de app (#562)')
  const gewijzigd = planRitten({ bestaande, gelezen: [{ ...gelezen[0], velden: { postnl_stops: 6, postnl_volume: '3,94' } }], klantId: 'k', datum: '2026-11-02', depot: 'D', nu: NU })
  assert.deepEqual(gewijzigd.updates, [{ id: 'x', velden: { postnl_stops: 6, postnl_laatst_opgehaald: NU } }], 'alleen het gewijzigde veld, plus wanneer')
  const naFout = planRitten({ bestaande: [{ ...bestaande[0], postnl_sync_status: 'fout', postnl_sync_error: 'x' }], gelezen: [gelezen[0]], klantId: 'k', datum: '2026-11-02', depot: 'D', nu: NU })
  assert.deepEqual(naFout.updates, [{ id: 'x', velden: { postnl_sync_status: 'opgehaald', postnl_sync_error: null, postnl_laatst_opgehaald: NU } }], 'een oude foutstatus wordt wel opgeruimd')
  assert.deepEqual(plan.inserts, [{ klant_id: 'k', datum: '2026-11-02', depot: 'D', ritnummer: '901', status: 'gepland', shift: '9',
    postnl_kanaal: 'GB', postnl_stops: 40, postnl_laatst_opgehaald: NU, postnl_sync_status: 'opgehaald', postnl_sync_error: null }])
})

test('planRitten: kolommen die pas na de migratie bestaan blijven weg tot ze er zijn', () => {
  const gelezen = [{ ritnummer: '114', kanaal: 'HD', shift: '1', velden: { postnl_stops: 5, postnl_rit_id: 'r1', postnl_geautoriseerd: true } }]
  const zonder = planRitten({ bestaande: [], gelezen, klantId: 'k', datum: 'd', depot: 'D', nu: NU })
  assert.equal('postnl_rit_id' in zonder.inserts[0], false)
  const met = planRitten({ bestaande: [], gelezen, klantId: 'k', datum: 'd', depot: 'D', nu: NU,
    kolommen: new Set(['postnl_stops', 'postnl_rit_id', 'postnl_geautoriseerd', 'postnl_laatst_opgehaald', 'postnl_sync_status', 'postnl_sync_error']) })
  assert.equal(met.inserts[0].postnl_rit_id, 'r1')
})

// Nep-Supabase die elke query vastlegt, om de klantfilter te controleren.
function nepSupabase({ bestaande = [], fout = null } = {}) {
  const log = []
  const query = (tabel) => {
    const q = { tabel, filters: [], soort: null }
    const api = {
      select() { q.soort = q.soort ?? 'select'; return api },
      update(v) { q.soort = 'update'; q.waarde = v; return api },
      insert(v) { q.soort = 'insert'; q.waarde = v; log.push(q); return Promise.resolve({ data: null, error: fout }) },
      eq(k, v) { q.filters.push([k, v]); return api },
      neq(k, v) { q.filters.push([`!${k}`, v]); return api },
      limit() { return api },
      then(ok, nok) { log.push(q); return Promise.resolve({ data: q.soort === 'select' ? bestaande : null, error: fout }).then(ok, nok) },
    }
    return api
  }
  return { log, from: query }
}

test('schrijfDagplanning: lezen en bijwerken altijd met klant_id; een databasefout is niet stil', async () => {
  const sb = nepSupabase({ bestaande: [{ id: 'x', ritnummer: '114', postnl_kanaal: null, postnl_stops: 4 }] })
  const uit = await schrijfDagplanning(sb, { klantId: 'k', datum: '2026-11-02', depot: 'D', nu: NU,
    gelezen: [{ ritnummer: '114', kanaal: 'HD', shift: '1', velden: { postnl_stops: 5 } }] })
  assert.deepEqual(uit, { bijgewerkt: 1, nieuw: 0, kanaalOnbekend: [], tegenstrijdig: [] })
  for (const q of sb.log) assert.ok(q.filters.some(([k, v]) => k === 'klant_id' && v === 'k'), `${q.soort} zonder klant_id`)
  await assert.rejects(schrijfDagplanning(nepSupabase({ fout: { message: 'kapot' } }), { klantId: 'k', datum: 'd', depot: 'D', gelezen: [] }), /kapot/)
})

// 03-11 00:10: de volgende dag stond standaard open, daarna werd 02-11 gekozen. Zonder RideID
// (datum null) had rit 448 twee versies; de schrijver nam de eerste (138 stops van 03-11). Bij
// Den Hoorn kwam rit 114 van 03-11 bovendien pas ná het wisselen nog een keer binnen.
test('dagwissel: alleen ritten van de gekozen dag tellen, ook als de vorige dag laat binnenkomt', () => {
  const dag = (ritGuid, stops, geautoriseerd) => ({ objects: [shiftObj('s3', '03'), ritNummer({
    guid: `n-${ritGuid}`, ritGuid, rideId: null, naam: '448', chauffeur: 'Jansen J', shiftGuid: 's3',
    stops, stuks: 200, volume: '1.5', gewicht: '300', brief: 0, duur: '5u', geautoriseerd,
  })] })
  const eerder = { objects: [] }                     // van vóór het openen van de Dagplanning
  const antwoorden = [eerder, dag('morgen', 138, false), dag('vandaag', 122, true), dag('morgen', 138, false)]
  const keuze = { geopend: 1, vanaf: 2 }             // standaarddag geladen, daarna 02-11 gekozen, late 03-11
  // Zonder RideID komt het kanaal van het scherm (Thuisbezorging).
  const lees = (lijst, opties) => dagplanningRitten(lijst, opties).map(r => ({ ...r, kanaal: 'HD' }))

  const venster = dagVenster(antwoorden, keuze)
  const goed = planRitten({ bestaande: [], gelezen: lees(venster.antwoorden, { negeer: venster.negeer }), klantId: 'k', datum: '2026-11-02', depot: 'D', nu: NU })
  assert.equal(goed.inserts.length, 1)
  assert.equal(goed.inserts[0].postnl_stops, 122)
  assert.deepEqual(goed.tegenstrijdig, [])

  // Alleen op tijd afkappen is niet genoeg: dan zit de late rit van 03-11 er nog in. Dan niets schrijven.
  const fout = planRitten({ bestaande: [], gelezen: lees(antwoorden.slice(keuze.vanaf)), klantId: 'k', datum: '2026-11-02', depot: 'D', nu: NU })
  assert.deepEqual(fout.inserts, [], 'niet gokken welke versie klopt')
  assert.deepEqual(fout.tegenstrijdig, ['448'])
})

test('dagVenster: stond de dag al open, dan telt alles sinds het openen en wordt niets genegeerd', () => {
  const v = dagVenster([{ a: 1 }, { b: 2 }, { c: 3 }], { geopend: 1, vanaf: null })
  assert.deepEqual(v.antwoorden, [{ b: 2 }, { c: 3 }])
  assert.equal(v.negeer.size, 0)
})

test('planRitten: dezelfde rit twee keer met gelijke waarden is geen tegenstrijdigheid', () => {
  const rit = { ritnummer: '12', kanaal: 'HD', shift: '1', velden: { postnl_stops: 5 } }
  const plan = planRitten({ bestaande: [], gelezen: [rit, { ...rit }], klantId: 'k', datum: 'd', depot: 'D', nu: NU })
  assert.equal(plan.inserts.length, 1)
  assert.deepEqual(plan.tegenstrijdig, [])
})

test('hoortBijShift: volgens PostNL als die de shift meestuurt, anders het eerste cijfer van het ritnummer (03-11)', async () => {
  const { hoortBijShift } = await import('../src/postnl/ritten.js')
  assert.equal(hoortBijShift({ shiftPostnl: null, shift: '1' }, '01'), true)
  assert.equal(hoortBijShift({ shiftPostnl: null, shift: '7' }, '01'), false)
  assert.equal(hoortBijShift({ shiftPostnl: '3', shift: '1' }, '03'), true, 'PostNL gaat voor')
  assert.equal(hoortBijShift({ shiftPostnl: null, shift: null }, '01'), false)
})
