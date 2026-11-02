// node --test — de depot-lus met nep-onderdelen: wat gebeurt er bij verlopen, eruit gegooid,
// databasefout, vastlopen, een planner-opdracht en een slot dat bezet is (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draaiDepot, metLimiet } from '../src/depot.js'
import { mergeInstellingen } from '../src/instellingen.js'
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

test('planner-opdracht: sessie dicht, slot vrij, wachten tot klaar, daarna weer verder', async () => {
  let open = [{ id: 'p1', depot: 'Depot A', status: 'wacht' }]
  let klaarOm = null
  const o = opzet({ duurMin: 5, opdrachten: (nu) => { if (!klaarOm) klaarOm = nu.getTime() + 60_000; if (nu.getTime() >= klaarOm) open = []; return open },
    handlers: { ritmonitor: async (ctx, dag) => ({ ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } }) } })
  await draaiDepot(o.deps)
  const i = o.log.indexOf('slot-los')
  assert.ok(i >= 0, 'slot vrijgegeven voor het planner-script')
  assert.ok(o.log.slice(i + 1).some(x => x.startsWith('open')), 'daarna weer ingelogd voor de ritmonitor')
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
