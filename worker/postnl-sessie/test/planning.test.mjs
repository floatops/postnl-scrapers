// node --test — wanneer doet de sessiehouder wat? Taken, rij en dagstatus, met een gesimuleerde
// werkdag en scenario's die echt voorkomen (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { kies } from '../src/rij.js'
import { TAAK } from '../src/taken.js'
import { STANDAARD, mergeInstellingen as mergeInstellingenEcht } from '../src/instellingen.js'

// De taak 'gisteren' (nalezen van de vorige werkdag) heeft eigen tests; hier staat hij uit.
// De nachtlezing (matransport#690) heeft eigen tests onderaan; hier staat hij uit.
const mergeInstellingen = (c = {}, ...rest) => mergeInstellingenEcht({ gisterenNalezen: false, nachtlezing: false, ...c }, ...rest)
import { nieuweDag, voorDatum, naOchtend, naOchtendNietBeschikbaar, naNacht, naNachtNietBeschikbaar, naDefinitief, naRitmonitor, voegAanvraagToe, aanvraagKlaar } from '../src/dagstatus.js'

// De taak 'plannen' heeft eigen tests onderaan; de rest gaat over de andere taken.
const CFG = mergeInstellingen({ plannenVerversen: false })
// De vaste ritmes van vóór "zo snel mogelijk" (03-11): de oude tests gaan over die regels.
const OUD = mergeInstellingen({ plannenVerversen: false, hercontroleMin: 5, naVangnetKijkenMin: 240 })
// Tijd op een minuut nauwkeurig: een taak duurt in de simulatie 10 s, dus een minuut kan opschuiven.
const minuut = (t) => { const [u, m] = t.split(':').map(Number); return u * 60 + m }
function rond(t, verwacht, uitleg) {
  assert.ok(t && Math.abs(minuut(t) - minuut(verwacht)) <= 1, `${uitleg ?? ''} (${t}, verwacht ±${verwacht})`)
}
// Maandag 2 november 2026 (wintertijd, UTC+1).
const om = (hhmm, datum = '2026-11-02') => new Date(`${datum}T${hhmm}:00+01:00`)
const fmt = (d) => d.toLocaleTimeString('nl-NL', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit' })

// Simuleert een dag. `postnl` bepaalt wat PostNL doet: wanneer de dag er is, de deadlines en
// wanneer een shift geautoriseerd wordt (null = nooit).
// Een taak duurt in het echt ~10 s (stapMs): de klok loopt in stappen van 10 s. Zo komen taken met een
// lagere prioriteit tussen de ritmonitor (elke minuut) door, zoals in het echt.
function simuleer({ datum = '2026-11-02', van = '05:00', tot = '23:30', postnl, aanvragen = {}, cfg = CFG, stapMs = 10_000 }) {
  let dag = nieuweDag(datum)
  const log = []
  let sessieOpen = false
  const gedaan = new Set()
  let nu = om(van, datum)
  const eind = om(tot, datum)
  while (nu < eind) {
    for (const [hhmm, a] of Object.entries(aanvragen)) if (fmt(nu) === hhmm && !gedaan.has(hhmm)) { gedaan.add(hhmm); dag = voegAanvraagToe(dag, a) }
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
      } else if (t === 'wakker') {
        log.push([fmt(nu), 'wakker'])
      } else if (t === 'plannen') {
        const pl = { ...(dag.plannen ?? {}), stopsOm: { ...(dag.plannen?.stopsOm ?? {}) } }
        if (k.args.soort === 'ritten') pl.rittenOm = nu.toISOString()
        else for (const sh of k.args.shifts) pl.stopsOm[sh] = nu.toISOString()
        if (k.args.naAutorisatie) pl.stopsDefinitiefOm = { ...(pl.stopsDefinitiefOm ?? {}), [k.args.shifts[0]]: nu.toISOString() }
        dag = { ...dag, plannen: pl }
        log.push([fmt(nu), `plannen:${k.args.soort}:${k.args.shifts.join('+')}`])
      }
      dag = { ...dag, laatsteTaakOm: nu.toISOString() }
    } else if (!k.sessieNodig && sessieOpen) { sessieOpen = false; log.push([fmt(nu), 'sessie-dicht']) }
    nu = new Date(nu.getTime() + stapMs)
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
  const s = simuleer({ postnl: gewoneDag, cfg: OUD })
  assert.equal(s.eerste('ochtend:niet-beschikbaar'), '05:30', 'om 05:30 kijken')
  assert.equal(s.eerste('ochtend'), '05:30')
  rond(s.log.find(([, x]) => x === 'ochtend')[0], '05:45', 'dag staat er om 05:41, na 5 min opnieuw')
  assert.equal(s.aantal('ochtend:niet-beschikbaar'), 3)
  assert.equal(s.log.filter(([, x]) => x === 'ochtend').length, 1, 'de dag maar één keer volledig lezen')
  rond(s.eerste('definitief:01:geschreven'), '07:25', 'autorisatie 07:24, controles om 07:15/07:20/07:25')
  rond(s.eerste('definitief:03:geschreven'), '08:35')
  rond(s.eerste('definitief:07:vangnet'), '09:30', 'nooit geautoriseerd: na 30 min het vangnet')
  assert.equal(s.aantal('definitief:01:geschreven') + s.aantal('definitief:03:geschreven') + s.aantal('definitief:07:vangnet'), 3)
  rond(s.eerste('ritmonitor'), '07:26', 'ritmonitor start meteen na de eerste autorisatie (07:25), niet pas om 08:00')
  // De simulatie doet één taak per minuut; na het vangnet van shift 07 kost de controle tot de
  // autorisatie (elke 5 min, hooguit 4 uur) er een paar. In het echt passen beide in dezelfde minuut.
  assert.ok(s.aantal('ritmonitor') > 850, 'elke minuut tot 23:00')
  assert.equal(s.log.filter(([, x]) => x === 'ritmonitor').at(-1)[0], '22:59', 'na 23:00 niets meer')
  assert.equal(s.log.at(-1)[1], 'sessie-dicht', 'na 23:00 gaat de sessie dicht')
  assert.ok(s.dag.shifts['07'].vangnet)
})

test('standaard blijft de sessie open tussen de ochtendlezing en de eerste deadline (één login)', () => {
  const s = simuleer({ postnl: gewoneDag, tot: '07:20' })
  assert.deepEqual(s.log.filter(([, x]) => x === 'sessie-dicht'), [], 'geen sluiting, dus geen nieuwe login om 07:15')
})

test('met sessieOpenHouden uit: tussen de ochtendlezing en de eerste deadline gaat de sessie dicht', () => {
  const s = simuleer({ postnl: gewoneDag, tot: '07:20', cfg: mergeInstellingen({ sessieOpenHouden: false, plannenVerversen: false }) })
  const dicht = s.log.filter(([, x]) => x === 'sessie-dicht').map(([t]) => t)
  rond(dicht.find(t => t >= '05:40'), '05:46', 'na de ochtendlezing dicht (volgende taak om 07:15)')
})

test('geen enkele autorisatie te zien: ritmonitor start toch om 08:00 (vangnet)', () => {
  const s = simuleer({ postnl: { dagVanaf: '05:00', shifts: { '01': { deadline: '07:15', autorisatie: null } } }, tot: '08:10', cfg: OUD })
  rond(s.eerste('definitief:01:vangnet'), '07:45')
  rond(s.eerste('ritmonitor'), '07:46', 'vangnet van de shift (07:15 + 30) zet de ritmonitor aan')
  const geen = simuleer({ postnl: { dagVanaf: '05:00', shifts: {} }, tot: '08:10' })
  assert.equal(geen.eerste('ritmonitor'), '08:00', 'zonder shifts: om 08:00')
})

test('shift zonder deadline-tekst: vanaf de ochtendlezing elke 5 min controleren', () => {
  const s = simuleer({ postnl: { dagVanaf: '05:00', shifts: { '02': { deadline: null, autorisatie: '06:12' } } }, tot: '06:30', cfg: OUD })
  // ochtendlezing 05:30, controles 05:31, 05:36, … 06:11, 06:16 (geautoriseerd om 06:12)
  rond(s.eerste('definitief:02:geschreven'), '06:16')
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
  const k = kies(verder, om('08:00'), CFG)
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

test('stille tijd: elke 10 min wakker houden tussen de ochtendlezing en de eerste deadline, niet als de ritmonitor loopt', () => {
  const s = simuleer({ postnl: gewoneDag, tot: '09:30', cfg: OUD })
  const wakker = s.log.filter(([, x]) => x === 'wakker').map(([t]) => t)
  ;['05:55', '06:05', '06:15'].forEach((t, i) => rond(wakker[i], t, 'na de ochtendlezing (±05:45) elke 10 min'))
  assert.ok(wakker.every(t => t < '07:24'), 'zodra de ritmonitor elke minuut leest niet meer nodig')
})

test('wakker houden staat uit zonder sessieOpenHouden of met wakkerHoudenMin 0', () => {
  for (const c of [{ sessieOpenHouden: false }, { wakkerHoudenMin: 0 }]) {
    const s = simuleer({ postnl: gewoneDag, tot: '07:20', cfg: mergeInstellingen({ ...c, plannenVerversen: false }) })
    assert.equal(s.aantal('wakker'), 0)
  }
})

test('autorisatie pas na het vangnet (03-11: 1-3 uur na de deadline): vangnet-lezing, daarna nog één lezing bij de autorisatie', () => {
  const s = simuleer({ postnl: { dagVanaf: '05:00', shifts: { '02': { deadline: '06:20', autorisatie: '08:40' } } }, tot: '12:00' })
  assert.equal(s.eerste('definitief:02:vangnet'), '06:50')
  assert.equal(s.eerste('definitief:02:geschreven'), '08:40', 'blijft elke 5 min kijken en leest opnieuw zodra hij geautoriseerd is')
  assert.equal(s.aantal('definitief:02:geschreven'), 1)
  assert.equal(s.log.filter(([t, x]) => x.startsWith('definitief:02') && t > '08:40').length, 0, 'daarna niet meer')
})

test('nooit geautoriseerd na het vangnet: hooguit naVangnetKijkenMin blijven kijken', () => {
  const s = simuleer({ postnl: { dagVanaf: '05:00', shifts: { '02': { deadline: '06:20', autorisatie: null } } }, tot: '14:00', cfg: OUD })
  const laatste = s.log.filter(([, x]) => x.startsWith('definitief:02')).at(-1)[0]
  assert.ok(laatste <= '10:50', `laatste controle ${laatste}, binnen 4 uur na het vangnet van 06:50`)
})

test('shift zonder deadline (niet te lezen bij de ochtendlezing): vangnet vanaf ritmonitorUiterlijk, nooit eindeloos', () => {
  const s = simuleer({ postnl: { dagVanaf: '05:00', shifts: { '01': { deadline: null, autorisatie: null } } }, tot: '13:30', cfg: OUD })
  const v = s.eerste('definitief:01:vangnet')
  assert.ok(v >= '08:00' && v <= '08:05', `vangnet bij de eerste controle vanaf 08:00 (${v}; controles elke 5 min)`)
  assert.ok(s.log.filter(([, x]) => x.startsWith('definitief:01')).at(-1)[0] <= '12:01')
})

test('plannen: zo snel als het kan, om de beurt ritten en stops per open shift; een shift voorbij zijn deadline overgeslagen', () => {
  // De simulatie doet één taak per minuut: zodra de ritmonitor elke minuut loopt, komt de lagere
  // taak plannen er niet meer tussen (in het echt duurt een ritmonitor-lezing ~10 s). Daarom hier
  // de ochtend vóór de ritmonitor: geen autorisatie, vangnet en ritmonitor pas laat.
  const dag = { dagVanaf: '05:00', shifts: { '01': { deadline: '06:35', autorisatie: null }, '02': { deadline: '07:20', autorisatie: null }, '07': { deadline: '11:10', autorisatie: null } } }
  const s = simuleer({ postnl: dag, tot: '07:30', cfg: mergeInstellingen({ vangnetMin: 600, ritmonitorUiterlijk: '23:00' }) })
  const p = s.log.filter(([, x]) => x.startsWith('plannen'))
  const met = (shift, voor, na = '00:00') => p.filter(([t, x]) => x.split(':')[2].split('+').includes(shift) && t < voor && t >= na)
  // Na de ochtendlezing (05:30) elke minuut die niet voor iets anders nodig is.
  const tussen = s.log.filter(([t]) => t >= '05:31' && t < '06:30')
  assert.ok(tussen.filter(([, x]) => x.startsWith('plannen')).length >= tussen.length - 15, 'vrijwel elke vrije minuut verversen, geen vaste wachttijd')
  const eerste = p.slice(0, 4).map(([, x]) => x)
  assert.deepEqual(eerste, ['plannen:ritten:01+02+07', 'plannen:stops:01', 'plannen:stops:02', 'plannen:stops:07'], 'om de beurt')
  assert.ok(met('01', '06:35').length > 0, 'shift 01 vóór zijn deadline')
  assert.equal(met('01', '24:00', '06:35').length, 0, 'na 06:35 wordt shift 01 overgeslagen')
  assert.equal(met('02', '24:00', '07:20').length, 0, 'na 07:20 shift 02 ook')
  assert.ok(met('07', '24:00', '07:20').length > 0, 'shift 07 gaat door')
})

test('plannen: na de laatste deadline alleen nog één lezing na de autorisatie', () => {
  const s = simuleer({ postnl: { dagVanaf: '05:00', shifts: { '01': { deadline: '06:00', autorisatie: '06:05' } } }, tot: '09:00', cfg: mergeInstellingen({}) })
  assert.deepEqual(s.log.filter(([t, x]) => x.startsWith('plannen') && t >= '06:01').map(([, x]) => x), ['plannen:stops:01'])
})

test('plannen: de shift die iemand in Plannen open heeft, gaat voor', async () => {
  const { kies } = await import('../src/rij.js')
  const cfg = mergeInstellingen({})
  const basis = { ...nieuweDag('2026-11-02'), ochtend: { gelezenOm: '2026-11-02T04:45:00Z' }, laatsteTaakOm: '2026-11-02T06:00:00Z',
    shifts: { '02': { deadline: '2026-11-02T08:00:00Z' }, '07': { deadline: '2026-11-02T10:00:00Z' } },
    plannen: { rittenOm: '2026-11-02T06:00:00Z', stopsOm: { '02': '2026-11-02T05:58:00Z', '07': '2026-11-02T05:58:00Z' } } }
  const om = new Date('2026-11-02T06:01:00Z')
  assert.deepEqual(kies(basis, om, cfg).args, { soort: 'stops', shifts: ['02'] }, 'zonder kijker: wat het langst geleden is (bij gelijk: de eerste)')
  const k = kies({ ...basis, plannenKijkers: ['07'] }, om, cfg)
  assert.equal(k.taak.naam, 'plannen')
  assert.deepEqual(k.args, { soort: 'stops', shifts: ['07'] }, 'de bekeken shift gaat voor')
})

test('autorisatie zo snel als het kan (standaard): gezien binnen een minuut, om de beurt met plannen, de ritmonitor blijft elke minuut', () => {
  const dag = { dagVanaf: '05:00', shifts: { '02': { deadline: '06:20', autorisatie: '08:41' }, '07': { deadline: '11:10', autorisatie: null } } }
  const s = simuleer({ postnl: dag, tot: '09:30', cfg: mergeInstellingen({}) })
  rond(s.eerste('definitief:02:geschreven'), '08:41', 'de autorisatie van 08:41 meteen gezien, niet pas bij de volgende 5 min')
  assert.equal(s.aantal('definitief:02:geschreven'), 1, 'daarna niet meer')
  // Tussen 06:50 (vangnet 02) en 08:41: de controles wisselen af met het verversen van shift 07.
  const tussen = s.log.filter(([t, x]) => t >= '06:51' && t < '08:40' && (x.startsWith('definitief') || x.startsWith('plannen')))
  assert.ok(tussen.some(([, x]) => x.startsWith('definitief:02')) && tussen.some(([, x]) => x === 'plannen:stops:07'), 'beide komen aan de beurt')
  // De ritmonitor (vanaf het vangnet van 06:50) blijft elke minuut lezen.
  const rm = s.log.filter(([t, x]) => x === 'ritmonitor' && t >= '07:00' && t < '09:00').length
  assert.ok(rm >= 115, `ritmonitor ${rm} keer in 120 minuten`)
})

test('gisteren: na 00:30 één keer de vorige werkdag nalezen (zondag overgeslagen), daarna niet meer', async () => {
  const { kies } = await import('../src/rij.js')
  const { vorigeWerkdag } = await import('../src/taken.js')
  assert.equal(vorigeWerkdag('2026-11-04'), '2026-11-03')
  assert.equal(vorigeWerkdag('2026-11-02'), '2026-10-31', 'maandag: de zaterdag, zondag is een rustdag')
  const cfg = mergeInstellingenEcht({ plannenVerversen: false, gisterenNalezen: true, nachtlezing: false })
  const dag = nieuweDag('2026-11-04')
  const k1 = kies(dag, new Date('2026-11-04T00:10:00+01:00'), cfg)
  assert.equal(k1.taak, undefined, 'vóór 00:30 nog niet')
  const k2 = kies(dag, new Date('2026-11-04T00:31:00+01:00'), cfg)
  assert.equal(k2.taak.naam, 'gisteren')
  assert.deepEqual(k2.args, { datum: '2026-11-03' })
  const klaar = { ...dag, gisteren: { gelezenOm: '2026-11-03T23:31:00Z', datum: '2026-11-03' } }
  assert.notEqual(kies(klaar, new Date('2026-11-04T00:40:00+01:00'), cfg).taak?.naam, 'gisteren', 'één keer per dag')
  assert.equal(kies(dag, new Date('2026-11-04T05:31:00+01:00'), cfg).taak.naam, 'ochtend', 'de ochtendlezing gaat voor als beide nog moeten')
})

test('gisteren staat standaard uit (04-11: na middernacht toont PostNL niet de geautoriseerde planning)', async () => {
  const { kies } = await import('../src/rij.js')
  const k = kies(nieuweDag('2026-11-04'), new Date('2026-11-04T00:31:00+01:00'), mergeInstellingenEcht({ plannenVerversen: false }))
  assert.notEqual(k.taak?.naam, 'gisteren')
})

test('plannen: na de autorisatie één laatste keer de stops van die shift, ook na de deadline (#600)', () => {
  const cfg = mergeInstellingenEcht({})
  const plannen = TAAK.plannen
  const nu = new Date('2026-11-06T10:40:00+01:00')
  const dag = { ochtend: { gelezenOm: '2026-11-06T04:30:00Z' }, plannen: {}, shifts: { '07': { deadline: '2026-11-06T09:25:00Z', geautoriseerdOm: '2026-11-06T09:37:00Z', definitiefOm: '2026-11-06T09:37:00Z' } } }
  assert.deepEqual(plannen.volgende(dag, nu, cfg).args, { soort: 'stops', shifts: ['07'], naAutorisatie: true })
  const klaar = { ...dag, plannen: { stopsDefinitiefOm: { '07': nu.toISOString() } } }
  assert.equal(plannen.volgende(klaar, nu, cfg), null, 'daarna niets meer')
})

test('plannen: een laatste lezing die steeds stopt, blokkeert de open shift niet (#600)', () => {
  const cfg = mergeInstellingenEcht({})
  const nu = new Date('2026-11-06T10:40:00+01:00')
  const op = (min) => new Date(nu.getTime() - min * 60_000).toISOString()
  const dag = { ochtend: { gelezenOm: op(300) }, shifts: {
    '01': { deadline: op(120), geautoriseerdOm: op(100), definitiefOm: op(100) },
    '07': { deadline: new Date(nu.getTime() + 60 * 60_000).toISOString() },
  }, plannen: { rittenOm: op(1), stopsOm: { '01': op(0.2), '07': op(5) } } }
  assert.deepEqual(TAAK.plannen.volgende(dag, nu, cfg).args, { soort: 'stops', shifts: ['07'] }, 'net geprobeerd: de open shift is aan de beurt')
  const later = { ...dag, plannen: { ...dag.plannen, stopsOm: { '01': op(5), '07': op(1) }, rittenOm: op(1) } }
  assert.equal(TAAK.plannen.volgende(later, nu, cfg).args.naAutorisatie, true, 'daarna weer de laatste lezing')
})

// Nachtlezing (matransport#690): één keer om 00:10 de Plannen-tab vullen, los van de ochtendlezing.
test('nacht: om 00:10 één keer, na een herstart niet opnieuw, na 5 min opnieuw als de dag er nog niet is', () => {
  const cfg = mergeInstellingenEcht({})
  const v = (dag, hhmm, c = cfg, datum = '2026-11-02') => TAAK.nacht.volgende(dag, om(hhmm, datum), c)
  const dag = nieuweDag('2026-11-02')
  assert.equal(cfg.nachtlezingOm, '00:10')
  assert.equal(v(dag, '00:05').om.getTime(), om('00:10').getTime(), 'vóór 00:10: wachten tot 00:10')
  assert.deepEqual(v(dag, '00:10'), { nu: true, args: {} })
  const gelezen = naNacht(dag, { nu: om('00:12') })
  assert.equal(v(gelezen, '00:20'), null, 'één keer per dag')
  // Herstart om 03:00: de opgeslagen dagstatus van dezelfde dag gaat mee.
  assert.equal(v(voorDatum(JSON.parse(JSON.stringify(gelezen)), '2026-11-02'), '03:02'), null, 'na de herstart niet opnieuw')
  const nog = naNachtNietBeschikbaar(dag, { nu: om('00:10'), cfg })
  assert.equal(v(nog, '00:12').om.getTime(), om('00:15').getTime(), 'dag nog niet in PostNL: na 5 min opnieuw')
  assert.deepEqual(v(nog, '00:15'), { nu: true, args: {} })
  assert.equal(nog.ochtend.gelezenOm, undefined, 'raakt de ochtendlezing niet')
  assert.equal(v(dag, '05:30'), null, 'vanaf ochtendVanaf niet meer')
  assert.equal(v(dag, '00:10', cfg, '2026-11-01'), null, 'zondag niet')
  assert.equal(v(dag, '00:10', mergeInstellingenEcht({ nachtlezing: false })), null, 'uit')
})

test('nacht: de ochtendlezing om 05:30 blijft zoals altijd, ook na de nachtlezing', () => {
  const cfg = mergeInstellingenEcht({ gisterenNalezen: false, plannenVerversen: false })
  const gelezen = naNacht(nieuweDag('2026-11-02'), { nu: om('00:12') })
  assert.equal(kies(gelezen, om('00:30'), cfg).taak, undefined, 'na de nachtlezing niets tot de ochtend')
  assert.equal(TAAK.ochtend.volgende(gelezen, om('00:30'), cfg).om.getTime(), om('05:30').getTime())
  assert.equal(kies(gelezen, om('05:30'), cfg).taak.naam, 'ochtend')
  assert.equal(kies(nieuweDag('2026-11-02'), om('00:10'), cfg).taak.naam, 'nacht')
})
