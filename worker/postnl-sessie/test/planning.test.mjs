// node --test — wanneer doet de sessiehouder wat? Taken, rij en dagstatus, met een gesimuleerde
// werkdag en scenario's die echt voorkomen (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kies } from '../src/rij.js'
import { STANDAARD, mergeInstellingen } from '../src/instellingen.js'
import { nieuweDag, voorDatum, naOchtend, naOchtendNietBeschikbaar, naDefinitief, naRitmonitor, voegAanvraagToe, aanvraagKlaar } from '../src/dagstatus.js'

const cfg = mergeInstellingen({})
// Maandag 2 november 2026 (wintertijd, UTC+1).
const om = (hhmm, datum = '2026-11-02') => new Date(`${datum}T${hhmm}:00+01:00`)
const fmt = (d) => d.toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' })

// Simuleert een dag. `postnl` bepaalt wat PostNL doet: wanneer de dag er is, de deadlines en
// wanneer een shift geautoriseerd wordt (null = nooit).
function simuleer({ datum = '2026-11-02', van = '05:00', tot = '23:30', postnl, aanvragen = {} }) {
  let dag = nieuweDag(datum)
  const log = []
  let sessieOpen = false
  let nu = om(van, datum)
  const eind = om(tot, datum)
  while (nu < eind) {
    for (const [hhmm, a] of Object.entries(aanvragen)) if (fmt(nu) === hhmm) dag = voegAanvraagToe(dag, a)
    const k = kies(dag, nu, cfg)
    if (k.taak) {
      sessieOpen = true
      const t = k.taak.naam
      if (t === 'ochtend') {
        if (nu < om(postnl.dagVanaf, datum)) { dag = naOchtendNietBeschikbaar(dag, { nu, cfg }); log.push([fmt(nu), 'ochtend:niet-beschikbaar']) }
        else {
          const shifts = Object.fromEntries(Object.entries(postnl.shifts).map(([s, p]) => [s, { deadline: p.deadline ? om(p.deadline, datum).toISOString() : null, geautoriseerd: false }]))
          dag = naOchtend(dag, { nu, shifts }); log.push([fmt(nu), 'ochtend'])
        }
      } else if (t === 'definitief') {
        const p = postnl.shifts[k.args.shift]
        const geautoriseerd = p.autorisatie !== null && nu >= om(p.autorisatie, datum)
        const r = naDefinitief(dag, k.args.shift, { nu, geautoriseerd, cfg })
        dag = r.dag
        log.push([fmt(nu), `definitief:${k.args.shift}:${r.schrijven ? (r.vangnet ? 'vangnet' : 'geschreven') : 'nog-niet'}`])
      } else if (t === 'ritmonitor') {
        dag = naRitmonitor(dag, { nu }); log.push([fmt(nu), 'ritmonitor'])
      } else if (t === 'planner') {
        dag = aanvraagKlaar(dag, k.args.id); log.push([fmt(nu), 'planner'])
      }
    } else if (!k.sessieNodig && sessieOpen) { sessieOpen = false; log.push([fmt(nu), 'sessie-dicht']) }
    nu = new Date(nu.getTime() + 60_000)
  }
  return { log, dag, aantal: (s) => log.filter(([, x]) => x.startsWith(s)).length, eerste: (s) => log.find(([, x]) => x.startsWith(s))?.[0] }
}

const gewoneDag = {
  dagVanaf: '05:41',
  shifts: {
    '01': { deadline: '07:15', autorisatie: '07:24' },
    '03': { deadline: '08:30', autorisatie: '08:33' },
    '07': { deadline: '09:00', autorisatie: null },   // nooit geautoriseerd gezien
  },
}

test('werkdag: één ochtendlezing, per shift één definitieve lezing, ritmonitor vanaf de eerste autorisatie', () => {
  const s = simuleer({ postnl: gewoneDag })
  assert.equal(s.eerste('ochtend:niet-beschikbaar'), '05:30', 'om 05:30 kijken')
  assert.equal(s.eerste('ochtend'), '05:30')
  assert.equal(s.log.find(([, x]) => x === 'ochtend')[0], '05:45', 'dag staat er om 05:41, na 5 min opnieuw')
  assert.equal(s.aantal('ochtend:niet-beschikbaar'), 3)
  assert.equal(s.log.filter(([, x]) => x === 'ochtend').length, 1, 'de dag maar één keer volledig lezen')
  assert.equal(s.eerste('definitief:01:geschreven'), '07:25', 'autorisatie 07:24, controles om 07:15/07:20/07:25')
  assert.equal(s.eerste('definitief:03:geschreven'), '08:35')
  assert.equal(s.eerste('definitief:07:vangnet'), '09:30', 'nooit geautoriseerd: na 30 min het vangnet')
  assert.equal(s.aantal('definitief:01:geschreven') + s.aantal('definitief:03:geschreven') + s.aantal('definitief:07:vangnet'), 3)
  assert.equal(s.eerste('ritmonitor'), '07:26', 'ritmonitor start meteen na de eerste autorisatie (07:25), niet pas om 08:00')
  assert.ok(s.aantal('ritmonitor') > 900, 'elke minuut tot 23:00')
  assert.equal(s.log.filter(([, x]) => x === 'ritmonitor').at(-1)[0], '22:59', 'na 23:00 niets meer')
  assert.equal(s.log.at(-1)[1], 'sessie-dicht', 'na 23:00 gaat de sessie dicht')
  assert.ok(s.dag.shifts['07'].vangnet)
})

test('tussen de ochtendlezing en de eerste deadline gaat de sessie dicht', () => {
  const s = simuleer({ postnl: gewoneDag, tot: '07:20' })
  const dicht = s.log.filter(([, x]) => x === 'sessie-dicht').map(([t]) => t)
  assert.ok(dicht.includes('05:46'), 'na de ochtendlezing dicht (volgende taak om 07:15)')
})

test('geen enkele autorisatie te zien: ritmonitor start toch om 08:00 (vangnet)', () => {
  const s = simuleer({ postnl: { dagVanaf: '05:00', shifts: { '01': { deadline: '07:15', autorisatie: null } } }, tot: '08:10' })
  assert.equal(s.eerste('definitief:01:vangnet'), '07:45')
  assert.equal(s.eerste('ritmonitor'), '07:46', 'vangnet van de shift (07:15 + 30) zet de ritmonitor aan')
  const geen = simuleer({ postnl: { dagVanaf: '05:00', shifts: {} }, tot: '08:10' })
  assert.equal(geen.eerste('ritmonitor'), '08:00', 'zonder shifts: om 08:00')
})

test('shift zonder deadline-tekst: vanaf de ochtendlezing elke 5 min controleren', () => {
  const s = simuleer({ postnl: { dagVanaf: '05:00', shifts: { '02': { deadline: null, autorisatie: '06:12' } } }, tot: '06:30' })
  // ochtendlezing 05:30, controles 05:31, 05:36, … 06:11, 06:16 (geautoriseerd om 06:12)
  assert.equal(s.eerste('definitief:02:geschreven'), '06:16')
})

test('planner-opdracht gaat voor, ook vóór de ochtendlezing en midden in de ritmonitor', () => {
  const s = simuleer({ postnl: gewoneDag, aanvragen: { '05:10': { id: 'p1', soort: 'planner' }, '10:00': { id: 'p2', soort: 'planner' } }, tot: '10:05' })
  assert.equal(s.eerste('planner'), '05:10')
  assert.deepEqual(s.log.filter(([, x]) => x === 'planner').map(([t]) => t), ['05:10', '10:00'])
  assert.equal(s.log.find(([t]) => t === '10:00')[1], 'planner', 'om 10:00 eerst de planner, dan de ritmonitor')
})

test('zondag: geen geplande taken, wel een planner-opdracht op aanvraag', () => {
  const s = simuleer({ datum: '2026-11-08', postnl: gewoneDag, aanvragen: { '09:00': { id: 'z', soort: 'planner' } } })
  assert.deepEqual(s.log.map(([, x]) => x), ['planner', 'sessie-dicht'])
})

test('herstart midden op de dag: verder waar hij was, geen tweede ochtendlezing', () => {
  const s = simuleer({ postnl: gewoneDag, tot: '08:00' })
  const opgeslagen = JSON.parse(JSON.stringify(s.dag))
  const verder = voorDatum(opgeslagen, '2026-11-02')
  const k = kies(verder, om('08:00'), cfg)
  assert.notEqual(k.taak?.naam, 'ochtend')
  assert.equal(verder.shifts['01'].definitiefOm !== undefined, true)
  const nieuweDagStand = voorDatum({ ...opgeslagen, aanvragen: [{ id: 'x', soort: 'planner' }] }, '2026-11-03')
  assert.equal(nieuweDagStand.ochtend.gelezenOm, undefined, 'nieuwe dag begint opnieuw')
  assert.equal(nieuweDagStand.aanvragen.length, 1, 'openstaande opdracht gaat mee')
})

test('een eenmaal gelezen deadline wordt niet overschreven', () => {
  let dag = naOchtend(nieuweDag('2026-11-02'), { nu: om('05:45'), shifts: { '01': { deadline: om('07:15').toISOString() } } })
  dag = naOchtend(dag, { nu: om('06:00'), shifts: { '01': { deadline: om('09:00').toISOString() } } })
  assert.equal(dag.shifts['01'].deadline, om('07:15').toISOString())
})

test('instellingen: klantwaarden overschrijven, rommel valt terug op de standaard', () => {
  const c = mergeInstellingen({ eindtijd: '22:00', ritmonitorIntervalSec: '30', rustdagen: 'zondag', taakLimietSec: { ochtend: 1200 }, onbekend: 1, ochtendVanaf: '5u30' })
  assert.equal(c.eindtijd, '22:00')
  assert.equal(c.ritmonitorIntervalSec, STANDAARD.ritmonitorIntervalSec, 'tekst in plaats van getal')
  assert.deepEqual(c.rustdagen, [0])
  assert.equal(c.taakLimietSec.ochtend, 1200)
  assert.equal(c.taakLimietSec.ritmonitor, STANDAARD.taakLimietSec.ritmonitor)
  assert.equal(c.ochtendVanaf, '05:30')
  assert.equal('onbekend' in c, false)
})

import { depotWijzigingen, vingerafdruk } from '../src/depots.js'

test('depots: lopende blijven in hun sessie; nieuw start, gewijzigde login herstart, uitgezet stopt', () => {
  const A = { naam: 'Depot A', url: 'https://a/index.html', username: 'a', password: 'p1' }
  const B = { naam: 'Depot B', url: 'https://b/index.html', username: 'b', password: 'p2' }
  const lopend = new Map([[A.naam, vingerafdruk(A)], [B.naam, vingerafdruk(B)]])
  const leeg = { starten: [], herstarten: [], stoppen: [] }
  assert.deepEqual(depotWijzigingen(lopend, [A, B]), leeg, 'niets veranderd: niemand logt opnieuw in')
  const C = { naam: 'Depot C', url: 'https://c/index.html', username: 'c', password: 'p3' }
  assert.deepEqual(depotWijzigingen(lopend, [A, B, C, { ...C }]).starten.map(d => d.naam), ['Depot C'], 'nieuw depot, dubbel in de lijst telt één keer')
  assert.deepEqual(depotWijzigingen(lopend, [A, { ...B, password: 'nieuw' }]).herstarten.map(d => d.naam), ['Depot B'], 'nieuw wachtwoord: opnieuw inloggen')
  assert.deepEqual(depotWijzigingen(lopend, [A, { ...B, url: 'https://b2/index.html' }]).herstarten.map(d => d.naam), ['Depot B'], 'andere portaal-URL')
  assert.deepEqual(depotWijzigingen(lopend, [A]).stoppen, ['Depot B'], 'uitgezet of verwijderd: stoppen')
  assert.deepEqual(depotWijzigingen(new Map(), [A, B, { naam: 'Zonder URL', url: null }]).starten.map(d => d.naam), ['Depot A', 'Depot B'], 'bij de start elk depot met een URL één keer')
  assert.deepEqual(depotWijzigingen(lopend, null).stoppen.sort(), ['Depot A', 'Depot B'])
})

import { maakDepotBeheer } from '../src/depots.js'

test('depotbeheer: nieuw depot start, gewijzigde login stopt en start opnieuw, uitgezet stopt, wacht tot alles klaar', async () => {
  const log = { log() {} }
  const gestart = []
  // Nep-lus: loopt tot lus.stop gezet wordt.
  const startLus = async (depot, lus) => { gestart.push(depot.naam); while (!lus.stop) await new Promise(r => setTimeout(r, 2)) }
  let gestopt = false
  const b = maakDepotBeheer({ startLus, log, isGestopt: () => gestopt })
  const A = { naam: 'A', url: 'u-a', username: 'a', password: '1' }
  const B = { naam: 'B', url: 'u-b', username: 'b', password: '2' }
  b.verwerk([A, B], 'start')
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(gestart, ['A', 'B'])
  b.verwerk([A, B], 'seintje zonder wijziging')
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(gestart, ['A', 'B'], 'geen wijziging: niemand opnieuw')
  b.verwerk([A, { ...B, password: 'nieuw' }, { naam: 'C', url: 'u-c', username: 'c', password: '3' }], 'inloggegevens gewijzigd')
  await new Promise(r => setTimeout(r, 30))
  assert.deepEqual(gestart, ['A', 'B', 'C', 'B'], 'B opnieuw met het nieuwe wachtwoord, C nieuw')
  b.verwerk([{ ...B, password: 'nieuw' }, { naam: 'C', url: 'u-c', username: 'c', password: '3' }], 'A uitgezet')
  await new Promise(r => setTimeout(r, 30))
  assert.equal(b.lopend.has('A'), false, 'A gestopt')
  gestopt = true
  for (const l of b.lopend.values()) l.stop = true
  await b.wacht(5)
  assert.equal(b.lopend.size, 0)
})
