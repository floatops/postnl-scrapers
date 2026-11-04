// node --test — de depot-lus met nep-onderdelen: wat gebeurt er bij verlopen, eruit gegooid,
// databasefout, vastlopen, een planner-opdracht en een slot dat bezet is (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draaiDepot, metLimiet } from '../src/depot.js'
import { mergeInstellingen as mergeInstellingenEcht } from '../src/instellingen.js'

// De taak 'gisteren' (nalezen van de vorige werkdag) heeft eigen tests; hier staat hij uit.
const mergeInstellingen = (c = {}, ...rest) => mergeInstellingenEcht({ gisterenNalezen: false, ...c }, ...rest)
import { nieuweDag } from '../src/dagstatus.js'

const DEPOT = { naam: 'Depot A', url: 'https://depot-a.example/index.html' }

// Nep-klok: slapen schuift de tijd op, zonder echt te wachten.
function nepKlok(start) {
  let t = new Date(start).getTime()
  return { nu: () => new Date(t), slaap: async (ms) => { t += ms }, tik: (ms) => { t += ms } }
}

// Nep-sessie: houdt bij wat er gebeurt; `url` en `planning` bepalen wat classificeer() ziet.
function nepSessies(log) {
  let n = 0
  return () => {
    const s = {
      nr: ++n, id: `s${n}`, depotHost: 'depot-a.example', leeftijdMin: 1, segmentOm: Date.now(), lezingen: 0,
      url: DEPOT.url, planning: true,
      get page() { return { url: () => s.url, locator: () => ({ first: () => ({ isVisible: async () => s.planning }) }) } },
      async openen() { log.push(`open:${s.nr}`) },
      async taakBegin() {},
      async taakEinde(naam, { incident }) { return incident ? `trace/fout/${naam}` : null },
      async sluiten(reden) { log.push(`dicht:${s.nr}:${reden}`) },
    }
    nepSessies.laatste = s
    return s
  }
}

// `duurMin`: hoe lang (nep-tijd) de lus draait voordat hij gestopt wordt, zoals bij een deploy.
function opzet({ start = '2026-11-02T10:00:00+01:00', handlers, opdrachten = () => [], slot = () => true, cfg = {}, duurMin = 3, dag } = {}) {
  const log = []
  const meldingen = []
  const runs = []
  const ritmonitor = []
  const gebeurtenissen = []
  const klok = nepKlok(start)
  const eind = new Date(start).getTime() + duurMin * 60_000
  const opgeslagen = dag ?? { ...nieuweDag('2026-11-02'), ochtend: { gelezenOm: '2026-11-02T05:31:00Z' }, shifts: { '01': { deadline: '2026-11-02T06:15:00Z', geautoriseerdOm: '2026-11-02T06:20:00Z', definitiefOm: '2026-11-02T06:20:00Z' } } }
  const deps = {
    depot: DEPOT, klantId: 'k', houder: 'postnl-sessie:test', cfg: mergeInstellingen(cfg), klok, log: { log() {}, warn() {}, error() {} },
    stop: () => klok.nu().getTime() >= eind,
    maakSessie: nepSessies(log),
    handlers,
    ctx: {},
    opStartpagina: async () => nepSessies.laatste?.startpagina === true,
    schatting: () => null,
    melden: async (m) => { meldingen.push(m) },
    naRun: async (r) => { runs.push(r) },
    telRitmonitor: (d, r) => { ritmonitor.push(r) },
    opslag: {
      dagstatus: async () => opgeslagen,
      bewaarDagstatus: async () => {},
      plannerOpdrachten: async () => opdrachten(klok.nu()),
      slotPak: async () => slot(klok.nu()),
      slotLos: async () => { log.push('slot-los') },
      gebeurtenis: async (id, g) => { gebeurtenissen.push(g) },
      sessieBij: async () => {},
    },
  }
  return { deps, log, meldingen, runs, ritmonitor, gebeurtenissen, klok }
}

const ritmonitorOk = (dag) => ({ dag: { ...dag, ritmonitor: { laatsteOm: new Date().toISOString() } }, ritmonitor: { rijen: 20, leegBevestigd: false } })

test('normale ronde: één login, lezingen tellen, bij stoppen dicht met reden herstart en slot vrij', async () => {
  const o = opzet({ duurMin: 3, handlers: { ritmonitor: async (ctx, dag) => ({ ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } }) } })
  await draaiDepot(o.deps)
  assert.equal(o.log.filter(x => x.startsWith('open')).length, 1)
  assert.ok(o.ritmonitor.length >= 1)
  assert.deepEqual(o.log.slice(-2), ['dicht:1:herstart', 'slot-los'])
})

test('sessie verlopen (loginpagina): meteen dicht met reden verlopen en een nieuwe login', async () => {
  let n = 0
  const o = opzet({ duurMin: 3, handlers: { ritmonitor: async (ctx, dag) => {
    if (++n === 1) { nepSessies.laatste.url = 'https://www.loginpostnl.net/login/?goto=x'; throw new Error('Planning-menu niet zichtbaar') }
    nepSessies.laatste.url = DEPOT.url
    return { ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } }
  } } })
  await draaiDepot(o.deps)
  assert.ok(o.log.includes('dicht:1:verlopen'))
  assert.ok(o.log.includes('open:2'))
  assert.equal(o.gebeurtenissen[0].soort, 'verlopen')
  assert.equal(o.gebeurtenissen[0].trace, 'trace/fout/ritmonitor', 'trace van het incident bewaard')
})

test('eruit gegooid: eerst opnieuw openen in dezelfde sessie, tweede keer binnen 2 min een nieuwe login', async () => {
  const o = opzet({ duurMin: 3, handlers: { ritmonitor: async () => { throw new Error('page.evaluate: Execution context was destroyed') } } })
  await draaiDepot(o.deps)
  assert.deepEqual(o.gebeurtenissen.slice(0, 2).map(g => g.actie), ['opnieuw_openen', 'nieuwe_login'])
  assert.ok(o.meldingen.some(m => m.soort === 'gegooid'), 'eruit gegooid wordt altijd gemeld')
  assert.ok(o.log.includes('dicht:1:gegooid'))
})

test('teruggezet naar de startpagina na een geslaagde taak: gegooid, gemeld, eerst opnieuw openen', async () => {
  let n = 0
  const o = opzet({ duurMin: 2, handlers: { ritmonitor: async (ctx, dag) => {
    nepSessies.laatste.startpagina = ++n === 1
    return { ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } }
  } } })
  await draaiDepot(o.deps)
  assert.equal(o.gebeurtenissen[0].soort, 'gegooid')
  assert.equal(o.gebeurtenissen[0].actie, 'opnieuw_openen')
  assert.ok(o.meldingen.some(m => m.soort === 'gegooid'))
  assert.equal(o.log.filter(x => x.startsWith('open')).length, 1, 'geen nieuwe login bij een keer teruggezet')
})

test('databasefout: sessie blijft open, geen nieuwe login, lezing telt als mislukt', async () => {
  const o = opzet({ duurMin: 3, handlers: { ritmonitor: async () => { throw Object.assign(new Error('ritten lezen: timeout'), { database: true }) } } })
  await draaiDepot(o.deps)
  assert.equal(o.log.filter(x => x.startsWith('open')).length, 1)
  assert.ok(o.ritmonitor.every(r => r.ok === false))
  assert.equal(o.gebeurtenissen[0].soort, 'database')
})

test('vastgelopen taak: na de tijdslimiet een fout in plaats van eeuwig wachten', async () => {
  await assert.rejects(metLimiet(new Promise(() => {}), 20, 'ritmonitor'), /duurde langer/)
})

test('te veel logins in een uur: pauze en een melding, niet blijven hameren', async () => {
  const o = opzet({ duurMin: 40, handlers: { ritmonitor: async () => { nepSessies.laatste.url = 'https://www.loginpostnl.net/login/'; throw new Error('weg') } } })
  await draaiDepot(o.deps)
  assert.ok(o.meldingen.some(m => m.soort === 'te_veel_logins'))
  // 4 logins in het eerste uur, daarna hooguit één per pauze van 10 min (in 40 min: max 4 + 4).
  assert.ok(o.log.filter(x => x.startsWith('open')).length <= 8, `${o.log.filter(x => x.startsWith('open')).length} logins`)
})

// Planner-opdracht die wacht tot de handler hem afrondt (zoals planning_taken: wacht → klaar).
function plannerOpdracht(id, { vanafMin = 0, start = '2026-11-02T10:00:00+01:00' } = {}) {
  const st = { klaar: false }
  st.opdrachten = (nu) => (!st.klaar && nu.getTime() >= new Date(start).getTime() + vanafMin * 60_000 ? [{ id, depot: 'Depot A', status: 'wacht' }] : [])
  return st
}

test('planner-opdracht midden in de ritmonitor: in dezelfde sessie, geen tweede login, slot blijft, ritmonitor gaat door', async () => {
  const p = plannerOpdracht('p1', { vanafMin: 1.5 })
  const volgorde = []
  const o = opzet({ duurMin: 5, opdrachten: p.opdrachten, handlers: {
    ritmonitor: async (ctx, dag) => { volgorde.push('ritmonitor'); return { ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } } },
    planner: async (ctx, dag, { id }) => {
      volgorde.push(`planner:${id}:${ctx.sessie.nr}`)
      p.klaar = true
      return { dag: { ...dag, aanvragen: (dag.aanvragen ?? []).filter(a => a.id !== id) }, run: null, gebeurtenis: { soort: 'planner', taak_id: id }, plannerRun: 'run-1' }
    },
  } })
  o.deps.opslag.runOpnames = async (id, opn) => { o.log.push(`opnames:${id}:${opn.length}`) }
  await draaiDepot(o.deps)
  assert.equal(o.log.filter(x => x.startsWith('open')).length, 1, 'één login voor alles')
  assert.ok(!o.log.slice(0, -1).includes('slot-los'), 'slot pas los bij het stoppen')
  assert.deepEqual(volgorde.filter(x => x.startsWith('planner')), ['planner:p1:1'], 'precies één keer, in sessie 1')
  const i = volgorde.indexOf('planner:p1:1')
  assert.ok(volgorde.slice(0, i).includes('ritmonitor') && volgorde.slice(i + 1).includes('ritmonitor'), 'ritmonitor ervoor en erna')
  assert.ok(o.gebeurtenissen.some(g => g.soort === 'planner' && g.taak_id === 'p1'), 'gebeurtenis in postnl_sessies')
  assert.equal(o.runs.length, 0, 'de planner schrijft zijn eigen run-log, geen dubbele')
})

test('planner-opdracht zonder open sessie (sessieOpenHouden uit): één login, daarna dicht als er niets meer is', async () => {
  const p = plannerOpdracht('p2', { start: '2026-11-02T06:00:00+01:00' })
  const dag = { ...nieuweDag('2026-11-02'), ochtend: { gelezenOm: '2026-11-02T04:31:00Z' }, shifts: { '01': { deadline: '2026-11-02T13:15:00Z' } } }
  const o = opzet({ start: '2026-11-02T06:00:00+01:00', duurMin: 30, dag, opdrachten: p.opdrachten, cfg: { ritmonitorUiterlijk: '23:00', sessieOpenHouden: false, plannenVerversen: false }, handlers: {
    planner: async (ctx, d, { id }) => { p.klaar = true; return { dag: { ...d, aanvragen: [] }, run: null } },
  } })
  await draaiDepot(o.deps)
  assert.deepEqual(o.log.filter(x => x.startsWith('open') || x.startsWith('dicht')).slice(0, 2), ['open:1', 'dicht:1:leeg'])
})

test('planner-doorvoer mislukt: opnames bewaard, gebeurtenis gelogd, geen dubbele run, geen herhaling', async () => {
  const p = plannerOpdracht('p3')
  let keer = 0
  const bewaard = []
  const o = opzet({ duurMin: 3, opdrachten: p.opdrachten, handlers: {
    ritmonitor: async (ctx, dag) => ({ ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } }),
    planner: async () => {
      keer++
      p.klaar = true   // de planner zet de opdracht zelf op mislukt
      throw Object.assign(new Error('Technische fout tijdens deze verplaatsing'), { alGelogd: true, bewaren: true, gebeurtenis: { soort: 'planner', taak_id: 'p3', uitkomst: 'mislukt' }, plannerRun: 'run-3' })
    },
  } })
  const maak = o.deps.maakSessie
  o.deps.maakSessie = (d) => { const s = maak(d); const eind = s.taakEinde; s.taakEinde = async (naam, opt) => { if (naam === 'planner') bewaard.push(opt.incident); return eind(naam, opt) }; return s }
  o.deps.opslag.runOpnames = async () => {}
  await draaiDepot(o.deps)
  assert.equal(keer, 1, 'een doorvoer wordt nooit herhaald')
  assert.deepEqual(bewaard, [true], 'trace en video van een doorvoer naar fout/')
  assert.equal(o.runs.filter(r => r.worker === 'postnl-planner').length, 0, 'geen tweede run-log naast die van de planner')
  assert.ok(o.gebeurtenissen.some(g => g.soort === 'planner' && g.uitkomst === 'mislukt'))
})

test('slot bezet door het vangnet-script: wachten, nooit ertussen inloggen', async () => {
  let vrijOm = null
  const o = opzet({ duurMin: 6, slot: (nu) => { if (!vrijOm) vrijOm = nu.getTime() + 4 * 60_000; return nu.getTime() >= vrijOm },
    handlers: { ritmonitor: async (ctx, dag) => ({ ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } }) } })
  const begin = o.klok.nu().getTime()
  await draaiDepot(o.deps)
  assert.ok(o.klok.nu().getTime() - begin >= 4 * 60_000, 'eerst gewacht tot het slot vrij was')
  assert.equal(o.meldingen.length, 0, 'binnen de wachttijd geen melding')
})

test('slot kwijt midden in de dag: sessie dicht, melding, opnieuw wachten op het slot', async () => {
  let ronde = 0
  const o = opzet({ duurMin: 3, slot: () => { ronde++; return ronde !== 3 },
    handlers: { ritmonitor: async (ctx, dag) => ({ ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } }) } })
  await draaiDepot(o.deps)
  assert.ok(o.meldingen.some(m => m.soort === 'slot_kwijt'))
  assert.ok(o.log.some(x => x.endsWith(':slot_kwijt')))
})

test('na 23:00: geen taken meer, sessie dicht met reden nacht en het proces stopt', async () => {
  const o = opzet({ start: '2026-11-02T22:59:30+01:00', duurMin: 3, handlers: { ritmonitor: async (ctx, dag) => ({ ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } }) } })
  await draaiDepot(o.deps)
  assert.ok(o.log.includes('dicht:1:nacht'))
  assert.equal(o.log.at(-1), 'slot-los')
})

test('verweesde planner-opdracht (crash): opgeruimd zodra het slot van ons is, niet eerder (matransport#578)', async () => {
  let vrijOm = null
  const opgeruimd = []
  const o = opzet({ duurMin: 3, slot: (nu) => { if (!vrijOm) vrijOm = nu.getTime() + 60_000; return nu.getTime() >= vrijOm },
    handlers: { ritmonitor: async (ctx, dag) => ({ ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } }) } })
  o.deps.opslag.ruimVerweesdePlannerOp = async (depot) => { opgeruimd.push({ depot, om: o.klok.nu().getTime() }); return 1 }
  await draaiDepot(o.deps)
  assert.equal(opgeruimd.length, 1, 'één keer, bij het pakken van het slot')
  assert.equal(opgeruimd[0].depot, DEPOT.naam)
  assert.ok(opgeruimd[0].om >= vrijOm, 'pas met het slot in de hand: daarvoor kan het vangnet-script er nog mee bezig zijn')
})
