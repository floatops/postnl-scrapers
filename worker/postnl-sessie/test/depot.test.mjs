// node --test — de depot-lus met nep-onderdelen: wat gebeurt er bij verlopen, eruit gegooid,
// databasefout, vastlopen, een planner-opdracht en een slot dat bezet is (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { draaiDepot, metLimiet } from '../src/depot.js'
import { mergeInstellingen as mergeInstellingenEcht } from '../src/instellingen.js'

// De taak 'gisteren' (nalezen van de vorige werkdag) heeft eigen tests; hier staat hij uit.
const mergeInstellingen = (c = {}, ...rest) => mergeInstellingenEcht({ gisterenNalezen: false, ...c }, ...rest)
import { nieuweDag } from '../src/dagstatus.js'
import { ProxyGeweigerdError } from '../../credentials-shared/src/proxyPool.js'

const DEPOT = { naam: 'Depot A', url: 'https://depot-a.example/index.html' }

// Nep-klok: slapen schuift de tijd op, zonder echt te wachten.
// Met `timers`: ook `elke(ms, fn)` (de hartslag van het slot), afgevuurd terwijl de tijd verschuift.
function nepKlok(start, { timers = false } = {}) {
  let t = new Date(start).getTime()
  const lijst = new Set()
  const verschuif = async (ms) => {
    const doel = t + ms
    for (;;) {
      const volgende = [...lijst].reduce((a, x) => (!a || x.om < a.om ? x : a), null)
      if (!volgende || volgende.om > doel) break
      t = volgende.om
      volgende.om += volgende.ms
      await volgende.fn()
    }
    t = doel
  }
  return {
    nu: () => new Date(t), slaap: verschuif, tik: (ms) => { t += ms },
    ...(timers ? { elke: (ms, fn) => { const x = { ms, fn, om: t + ms }; lijst.add(x); return () => lijst.delete(x) } } : {}),
  }
}

// Nep-sessie: houdt bij wat er gebeurt; `url` en `planning` bepalen wat classificeer() ziet.
function nepSessies(log) {
  let n = 0
  return () => {
    const s = {
      nr: ++n, id: `s${n}`, depotHost: 'depot-a.example', leeftijdMin: 1, segmentOm: Date.now(), lezingen: 0,
      url: DEPOT.url, planning: true, herloginTaak: 0, fouten460: [], proxy407: 0, tunnelFouten: 0,
      proxy: { proxy: { server: 'http://proxy.test:10001' } },
      get page() { return { url: () => s.url, locator: () => ({ first: () => ({ isVisible: async () => s.planning }) }) } },
      async openen() { log.push(`open:${s.nr}`); const f = nepSessies.openFout?.(s.nr); if (f) throw f },
      async taakBegin() { s.herloginTaak = 0; s.proxy407 = 0; s.tunnelFouten = 0 },
      async taakEinde(naam, { incident }) { return incident ? `trace/fout/${naam}` : null },
      async sluiten(reden) { log.push(`dicht:${s.nr}:${reden}`) },
      async nieuwSegment() { log.push(`segment:${s.nr}`); if (nepSessies.segmentFaalt) throw new Error('browser reageert niet'); return true },
    }
    nepSessies.laatste = s
    return s
  }
}

// `duurMin`: hoe lang (nep-tijd) de lus draait voordat hij gestopt wordt, zoals bij een deploy.
function opzet({ start = '2026-11-02T10:00:00+01:00', handlers, opdrachten = () => [], slot = () => true, cfg = {}, duurMin = 3, dag, timers = false, toetsProxy, nietGestart } = {}) {
  const log = []
  const meldingen = []
  const runs = []
  const ritmonitor = []
  const gebeurtenissen = []
  const klok = nepKlok(start, { timers })
  const eind = new Date(start).getTime() + duurMin * 60_000
  const opgeslagen = dag ?? { ...nieuweDag('2026-11-02'), ochtend: { gelezenOm: '2026-11-02T05:31:00Z' }, shifts: { '01': { deadline: '2026-11-02T06:15:00Z', geautoriseerdOm: '2026-11-02T06:20:00Z', definitiefOm: '2026-11-02T06:20:00Z' } }, plannen: { stopsDefinitiefOm: { '01': '2026-11-02T06:21:00Z' } } }
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
    ...(toetsProxy ? { toetsProxy: (p) => toetsProxy(p, klok.nu()) } : {}),
    opslag: {
      ...(nietGestart ? { opdrachtNietGestart: async (soort, id, reden) => { nietGestart.push({ soort, id, reden }); return true } } : {}),
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

test('verweesde sessierij (crash): afgesloten zodra het slot van ons is, vóór de eigen login (matransport#591)', async () => {
  let vrijOm = null
  const afgesloten = []
  const o = opzet({ duurMin: 3, slot: (nu) => { if (!vrijOm) vrijOm = nu.getTime() + 60_000; return nu.getTime() >= vrijOm },
    handlers: { ritmonitor: async (ctx, dag) => ({ ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } }) } })
  o.deps.opslag.sluitVerweesdeSessiesAf = async (depot) => { afgesloten.push({ depot, om: o.klok.nu().getTime(), logs: o.log.length }); return 1 }
  await draaiDepot(o.deps)
  assert.equal(afgesloten.length, 1, 'één keer, bij het pakken van het slot')
  assert.equal(afgesloten[0].depot, DEPOT.naam)
  assert.ok(afgesloten[0].om >= vrijOm, 'pas met het slot in de hand')
  assert.ok(!o.log.slice(0, afgesloten[0].logs).some(r => r.startsWith('open')), 'vóór de eigen sessie: die mag hij nooit zelf afsluiten')
})

test('verweesdeSessieEinde: einde = laatste geslaagde taak, anders de login; reden proces_weg (matransport#591)', async () => {
  const { verweesdeSessieEinde } = await import('../src/opslag.js')
  assert.deepEqual(verweesdeSessieEinde({ ingelogd_at: '2026-11-04T05:52:00Z', laatste_ok_at: '2026-11-04T06:20:00Z' }),
    { einde_at: '2026-11-04T06:20:00Z', einde_reden: 'proces_weg' })
  assert.deepEqual(verweesdeSessieEinde({ ingelogd_at: '2026-11-04T05:52:00Z', laatste_ok_at: null }),
    { einde_at: '2026-11-04T05:52:00Z', einde_reden: 'proces_weg' }, 'nooit "nu": dan lijkt hij uren geldig')
})

// ---- matransport#598: wat er op 05-11 misging, nagebootst ----

const okRitmonitor = (ctx, dag) => ({ ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } })

// Grootste gat tussen twee keer het slot pakken/verlengen (ms), vanaf het eerste pakken.
function grootsteGat(tijden) {
  let gat = 0
  for (let i = 1; i < tijden.length; i++) gat = Math.max(gat, tijden[i] - tijden[i - 1])
  return gat
}

test('lange taak (290 s, zoals Plannen op 05-11): de hartslag houdt het slot vast, het vangnet kan er niet tussen (#598)', async () => {
  const gepakt = []
  let keer = 0
  const o = opzet({ duurMin: 8, timers: true, slot: (nu) => { gepakt.push(nu.getTime()); return true }, handlers: {
    ritmonitor: async (ctx, dag) => { if (++keer === 1) await o.klok.slaap(290_000); return okRitmonitor(ctx, dag) },
  } })
  await draaiDepot(o.deps)
  assert.ok(grootsteGat(gepakt) < 180_000, `slot ${grootsteGat(gepakt) / 1000} s niet verlengd (lease 180 s)`)
  assert.ok(!o.meldingen.some(m => m.soort === 'slot_kwijt'))
})

test('pauze na te veel logins: het slot blijft van ons, het vangnet-script logt niet in (#598)', async () => {
  const gepakt = []
  const o = opzet({ duurMin: 25, timers: true, slot: (nu) => { gepakt.push(nu.getTime()); return true },
    handlers: { ritmonitor: async () => { nepSessies.laatste.url = 'https://www.loginpostnl.net/login/'; throw new Error('weg') } } })
  await draaiDepot(o.deps)
  assert.ok(o.meldingen.some(m => m.soort === 'te_veel_logins'), 'er was een pauze')
  assert.ok(grootsteGat(gepakt) < 180_000, `slot ${grootsteGat(gepakt) / 1000} s niet verlengd tijdens de pauze`)
})

test('een ander pakt het slot midden in een taak: taak breekt af, sessie dicht, melding, opnieuw wachten (#598)', async () => {
  let vanAnder = null
  const o = opzet({ duurMin: 10, timers: true,
    slot: (nu) => (vanAnder && nu.getTime() >= vanAnder && nu.getTime() < vanAnder + 4 * 60_000 ? false : true),
    handlers: { ritmonitor: async (ctx, dag) => {
      if (!vanAnder) { vanAnder = o.klok.nu().getTime() + 30_000; await o.klok.slaap(140_000) }
      return okRitmonitor(ctx, dag)
    } } })
  await draaiDepot(o.deps)
  assert.ok(o.meldingen.some(m => m.soort === 'slot_kwijt'), 'melding slot_kwijt')
  assert.ok(o.log.includes('dicht:1:slot_kwijt'), 'eigen sessie dicht: nooit twee sessies tegelijk')
  assert.ok(o.log.includes('open:2'), 'daarna, met het slot terug, een nieuwe sessie')
})

test('fout 460 midden in de ritmonitor: herlogin, taak opnieuw, geen "gegooid"-melding en geen nieuwe login (#598)', async () => {
  let n = 0
  const o = opzet({ duurMin: 3, handlers: { ritmonitor: async (ctx, dag) => {
    if (++n === 1) { ctx.sessie.herloginTaak = 1; ctx.sessie.fouten460.push(Date.now()); throw new Error('page.evaluate: Execution context was destroyed, most likely because of a navigation') }
    return okRitmonitor(ctx, dag)
  } } })
  await draaiDepot(o.deps)
  assert.equal(o.gebeurtenissen[0].soort, 'herlogin')
  assert.equal(o.gebeurtenissen[0].actie, 'opnieuw_openen')
  assert.ok(!o.meldingen.some(m => m.soort === 'gegooid'), 'geen vals alarm')
  assert.equal(o.log.filter(x => x.startsWith('open')).length, 1, 'geen nieuwe login')
  assert.ok(n >= 2, 'de taak is opnieuw gedaan')
})

test('vaak 460 (iemand anders gebruikt de login): één melding sessie_ingetrokken per uur (#598)', async () => {
  const o = opzet({ duurMin: 20, handlers: { ritmonitor: async (ctx, dag) => {
    ctx.sessie.fouten460.push(o.klok.nu().getTime())
    return okRitmonitor(ctx, dag)
  } } })
  await draaiDepot(o.deps)
  const m = o.meldingen.filter(x => x.soort === 'sessie_ingetrokken')
  assert.equal(m.length, 1, `${m.length} meldingen`)
  assert.ok(o.gebeurtenissen.some(g => g.soort === 'sessie_ingetrokken' && g.aantal >= 3))
})

test('startpagina alleen bij de eerste blik (scherm nog aan het openen): geen "gegooid" (#598, 05-11 08:30)', async () => {
  let blik = 0
  const o = opzet({ duurMin: 2, handlers: { ritmonitor: okRitmonitor } })
  o.deps.opStartpagina = async () => ++blik === 1
  await draaiDepot(o.deps)
  assert.ok(!o.gebeurtenissen.some(g => g.soort === 'gegooid'))
  assert.ok(!o.meldingen.some(m => m.soort === 'gegooid'))
})

// Twee taken zoals op 05-11 bij Den Hoorn: de ritmonitor (elke minuut) lukt, Plannen (35 s per
// poging) mislukt steeds. Vroeger: 243 pogingen, geen melding, geen nieuwe login.
test('taak die steeds mislukt terwijl de ritmonitor lukt: nieuwe login, dan remmen en één melding (#598)', async () => {
  const pogingen = []
  const taken = [
    { naam: 'ritmonitor', prioriteit: 30, volgende: (dag, nu) => {
      const l = dag.ritmonitor?.laatsteOm ? new Date(dag.ritmonitor.laatsteOm).getTime() : 0
      return nu.getTime() - l >= 60_000 ? { nu: true } : { om: new Date(l + 60_000) }
    } },
    { naam: 'plannen', prioriteit: 20, volgende: () => ({ nu: true }) },
  ]
  const o = opzet({ duurMin: 60, handlers: {
    ritmonitor: okRitmonitor,
    plannen: async () => { pogingen.push(o.klok.nu().getTime()); await o.klok.slaap(35_000); throw new Error('PostNL reageerde niet binnen de wachttijd') },
  } })
  o.deps.taken = taken
  await draaiDepot(o.deps)
  assert.equal(o.meldingen.filter(m => m.soort === 'taak_faalt').length, 1, 'precies één melding')
  assert.ok(o.log.filter(x => x.startsWith('open')).length >= 2, 'een nieuwe login na 3 gewone fouten van dezelfde taak')
  assert.ok(pogingen.length < 25, `${pogingen.length} pogingen in een uur (vroeger ~60)`)
  assert.ok(o.ritmonitor.length >= 40, 'de ritmonitor ging gewoon door')
})

test('startHartslag: verlengt alleen zolang de lus leeft; een ander met het slot breekt de taak af (#598)', async () => {
  const { startHartslag } = await import('../src/depot.js')
  let slag = null
  const elke = (ms, fn) => { slag = fn; return () => { slag = null } }
  let leeft = true
  let vanOns = true
  let verlengd = 0
  const h = startHartslag({ elke, ms: 60_000, levend: () => leeft, verleng: async () => { verlengd++; return vanOns }, log: { warn() {} } })
  await slag(); await slag()
  assert.equal(verlengd, 2)
  leeft = false
  await slag()
  assert.equal(verlengd, 2, 'vastgelopen lus: geen verlenging, het slot verloopt en het vangnet neemt over')
  leeft = true
  vanOns = false
  await slag()
  await assert.rejects(metLimiet(new Promise(() => {}), 60_000, 'plannen', h.kwijt), /slot kwijt/i)
  assert.equal(h.weg, true)
  h.stop()
  assert.equal(slag, null)
})

// ---- matransport#599: meldingen met oorzaak, en een taak over zijn limiet echt afbreken ----

test('slot lang bezet: één melding per keer wachten, met wie het slot heeft (#599)', async () => {
  const o = opzet({ duurMin: 16, slot: () => false, cfg: { slotWachtMaxMin: 1 }, handlers: { ritmonitor: okRitmonitor } })
  o.deps.opslag.slotHouder = async () => 'postnl-ritmonitor:123:abc'
  await draaiDepot(o.deps)
  const m = o.meldingen.filter(x => x.soort === 'slot_lang_bezet')
  assert.equal(m.length, 1, `${m.length} meldingen in 16 min (vroeger elke 5 s één)`)
  assert.match(m[0].detail, /postnl-ritmonitor:123:abc/)
})

test('slot kwijt: de melding noemt de nieuwe houder (#599)', async () => {
  let ronde = 0
  const o = opzet({ duurMin: 3, slot: () => { ronde++; return ronde !== 3 }, handlers: { ritmonitor: okRitmonitor } })
  o.deps.opslag.slotHouder = async () => 'postnl-dagplanning:9:x'
  await draaiDepot(o.deps)
  assert.match(o.meldingen.find(m => m.soort === 'slot_kwijt').detail, /postnl-dagplanning:9:x/)
})

test('te veel logins: de melding noemt het aantal in het laatste uur en wat er misging (#599)', async () => {
  const o = opzet({ duurMin: 12, handlers: { ritmonitor: async () => { nepSessies.laatste.url = 'https://www.loginpostnl.net/login/'; throw new Error('weg') } } })
  await draaiDepot(o.deps)
  assert.match(o.meldingen.find(m => m.soort === 'te_veel_logins').detail, /4 logins in het laatste uur.*verlopen \d+x/)
})

test('`bezig` zegt de waakhond ook buiten de handler wat de lus doet: inloggen, taak, afhandeling (#599)', async () => {
  const bezig = new Map()
  const fases = []
  const kijk = () => { const b = bezig.get(DEPOT.naam); if (b) fases.push(`${b.taak}:${b.fase}`) }
  const o = opzet({ duurMin: 1, handlers: { ritmonitor: async (ctx, dag) => { kijk(); return okRitmonitor(ctx, dag) } } })
  o.deps.bezig = bezig
  const maak = o.deps.maakSessie
  o.deps.maakSessie = (d) => {
    const s = maak(d)
    const open = s.openen
    const einde = s.taakEinde
    s.openen = async () => { kijk(); return open() }
    s.taakEinde = async (...a) => { kijk(); return einde(...a) }
    return s
  }
  await draaiDepot(o.deps)
  assert.deepEqual(fases.slice(0, 3), ['ritmonitor:inloggen', 'ritmonitor:taak', 'ritmonitor:afhandeling'])
  assert.equal(bezig.size, 0, 'na het stoppen leeg')
})

test('taak over limiet die op het stopsein reageert: geen contextwissel, volgende taak gaat door (#600)', async () => {
  let n = 0
  let gezienGestopt = false
  const o = opzet({ duurMin: 3, cfg: { taakLimietSec: { ...mergeInstellingenEcht({}).taakLimietSec, ritmonitor: 1 }, taakAfbouwSec: 1 }, handlers: {
    ritmonitor: async (ctx, dag) => {
      if (++n > 1) return okRitmonitor(ctx, dag)
      // Werkt door tot het stopsein komt, zoals de lussen in de handlers.
      await new Promise(r => { const t = setInterval(() => { if (ctx.gestopt()) { gezienGestopt = true; clearInterval(t); r() } }, 5) })
      throw new Error('gestopt')
    },
  } })
  // De afbouwtijd echt laten lopen: de nep-klok slaapt anders in nul tijd.
  const nep = o.klok.slaap
  o.klok.slaap = (ms) => (ms === 1000 ? new Promise(r => setTimeout(r, 200)) : nep(ms))
  await draaiDepot(o.deps)
  assert.equal(gezienGestopt, true, 'de handler zag het stopsein')
  assert.equal(o.log.filter(r => String(r).startsWith('segment')).length, 0)
})

test('taak over limiet die niet stopt: de context gaat dicht, zonder nieuwe login (#600)', async () => {
  let n = 0
  const o = opzet({ duurMin: 3, cfg: { taakLimietSec: { ...mergeInstellingenEcht({}).taakLimietSec, ritmonitor: 1 }, taakAfbouwSec: 1 }, handlers: {
    ritmonitor: async (ctx, dag) => (++n === 1 ? new Promise(() => {}) : okRitmonitor(ctx, dag)),
  } })
  await draaiDepot(o.deps)
  assert.ok(n >= 2, 'de lus gaat door met de volgende taak')
  assert.equal(o.log.filter(r => String(r).startsWith('segment')).length, 1, 'één keer de context dicht')
  assert.equal(o.log.filter(r => String(r).startsWith('open')).length, 1, 'geen nieuwe login')
})

test('nieuw videosegment mislukt: sessie dicht en de lus gaat door, geen crash van het depot (#600)', async () => {
  let n = 0
  const o = opzet({ duurMin: 3, cfg: { taakLimietSec: { ...mergeInstellingenEcht({}).taakLimietSec, ritmonitor: 1 }, taakAfbouwSec: 1 }, handlers: {
    ritmonitor: async (ctx, dag) => (++n === 1 ? new Promise(() => {}) : okRitmonitor(ctx, dag)),
  } })
  nepSessies.segmentFaalt = true
  try {
    await draaiDepot(o.deps)
  } finally { nepSessies.segmentFaalt = false }
  assert.ok(o.log.includes('dicht:1:fout'), 'sessie dicht met reden fout')
  assert.ok(o.log.some(r => String(r).startsWith('open:2')), 'de volgende taak logt opnieuw in')
})

// ── Proxy geweigerd (matransport#613) ──────────────────────────────────────────────────────────────
// 07-11: Decodo weigerde na een mislukte betaling elke login met 407. De sessiehouder zag alleen
// "Planning-menu niet zichtbaar", logde 10 uur lang elke 11 min opnieuw in en gaf 110x te_veel_logins.
const START = '2026-11-02T10:00:00+01:00'
const minNa = (min) => new Date(START).getTime() + min * 60_000
// Wat naarDepot gooit bij een 407, met de proxy van de poging eraan (Sessie.openen).
const geweigerd = () => Object.assign(new ProxyGeweigerdError('De proxy-aanbieder weigert de login (407)'), { proxy: { server: 'http://proxy.test:10003' } })
const ritmonitorLukt = async (ctx, dag) => ({ ...ritmonitorOk(dag), dag: { ...dag, ritmonitor: { laatsteOm: ctx.nu.toISOString() } } })

test('proxy geweigerd bij het inloggen: één melding, geen logins tot de toets weer lukt, wachtende opdracht meteen niet uitgevoerd', async () => {
  const hersteldNa = 25
  let hersteldOm = null
  // Inloggen faalt op de proxy tot de toets voor het eerst weer 200 geeft.
  nepSessies.openFout = () => (hersteldOm === null ? geweigerd() : null)
  const toetsen = []
  const p = plannerOpdracht('p1')
  const nietGestart = []
  const o = opzet({
    duurMin: 40, opdrachten: p.opdrachten, nietGestart,
    toetsProxy: (proxy, nu) => {
      toetsen.push({ server: proxy?.server, om: nu.getTime() })
      if (nu.getTime() >= minNa(hersteldNa)) { hersteldOm = nu.getTime(); return { status: 200, geweigerd: false, fout: null } }
      return { status: 407, geweigerd: true, fout: null }
    },
    handlers: { ritmonitor: ritmonitorLukt, planner: async () => { throw new Error('planner mag niet draaien') } },
  })
  // Zodra een opdracht "niet gestart" is, staat hij niet meer op wacht.
  o.deps.opslag.opdrachtNietGestart = async (soort, id, reden) => { nietGestart.push({ soort, id, reden }); p.klaar = true; return true }
  try {
    await draaiDepot(o.deps)
  } finally { nepSessies.openFout = null }
  const logins = o.log.filter(x => x.startsWith('open'))
  assert.equal(logins.length, 2, `één mislukte login, en pas na het herstel weer één (${logins.join(', ')})`)
  assert.equal(o.meldingen.filter(m => m.soort === 'proxy_geweigerd').length, 1, 'één melding, niet elke 5 min')
  const melding = o.meldingen.find(m => m.soort === 'proxy_geweigerd')
  assert.equal(melding.bron, 'decodo-proxy', 'eigen bron: de push op postnl-sessie is 6 uur gedempt')
  assert.ok(`${melding.soort} (Waddinxveen): ${melding.detail}`.slice(0, 100).includes('betaling'), 'de oorzaak staat binnen de 100 tekens van de push')
  assert.equal(o.meldingen.filter(m => m.soort === 'proxy_hersteld').length, 1)
  assert.ok(!o.meldingen.some(m => m.soort === 'te_veel_logins'), 'geen te_veel_logins meer')
  assert.equal(toetsen[0].server, 'http://proxy.test:10003', 'zonder pool-gegevens: de proxy van de mislukte login')
  assert.ok(toetsen.slice(1).every((t, i) => t.om - toetsen[i].om >= 5 * 60_000 - 1), 'tussen twee toetsen ten minste proxyToetsMin')
  assert.deepEqual(nietGestart.map(x => [x.soort, x.id]), [['planner', 'p1']])
  assert.match(nietGestart[0].reden, /proxy/)
  assert.ok(o.ritmonitor.some(r => r.ok), 'na het herstel gewoon verder')
})

test('alleen tunnelfouten midden in een taak en de toets zegt 407: sessie dicht als proxy_geweigerd, wachten', async () => {
  let n = 0
  const o = opzet({
    duurMin: 12,
    toetsProxy: (proxy, nu) => (nu.getTime() >= minNa(8) ? { status: 200, geweigerd: false } : { status: 407, geweigerd: true }),
    handlers: { ritmonitor: async (ctx, dag) => {
      if (++n === 1) { ctx.sessie.tunnelFouten = 3; throw new Error('locator.click: Timeout 30000ms exceeded') }
      return ritmonitorLukt(ctx, dag)
    } },
  })
  await draaiDepot(o.deps)
  assert.ok(o.log.includes('dicht:1:proxy_geweigerd'))
  assert.equal(o.gebeurtenissen[0].soort, 'proxy_geweigerd')
  assert.equal(o.gebeurtenissen[0].actie, 'proxy_wacht')
  assert.equal(o.log.filter(x => x.startsWith('open')).length, 2)
})

test('tunnelfouten maar de proxy werkt (toets 200): een gewone fout, geen wachtstand en geen proxymelding', async () => {
  let n = 0
  const o = opzet({
    duurMin: 3,
    toetsProxy: () => ({ status: 200, geweigerd: false }),
    handlers: { ritmonitor: async (ctx, dag) => {
      if (++n === 1) { ctx.sessie.tunnelFouten = 1; throw new Error('locator.click: Timeout 30000ms exceeded') }
      return ritmonitorLukt(ctx, dag)
    } },
  })
  await draaiDepot(o.deps)
  assert.equal(o.gebeurtenissen[0].soort, 'fout')
  assert.ok(!o.meldingen.some(m => m.soort.startsWith('proxy_')))
  assert.equal(o.log.filter(x => x.startsWith('open')).length, 1)
})

test('opdracht waarvoor het inloggen steeds mislukt: na 3 keer niet uitgevoerd met uitleg, niet pas na een uur', async () => {
  const p = plannerOpdracht('p2')
  const nietGestart = []
  nepSessies.openFout = () => new Error('Planning-menu niet zichtbaar na 90s (url: https://depot-a.example/index.html)')
  const o = opzet({ duurMin: 40, opdrachten: p.opdrachten, handlers: { ritmonitor: ritmonitorLukt, planner: async () => { throw new Error('planner mag niet draaien') } } })
  o.deps.opslag.opdrachtNietGestart = async (soort, id, reden) => { nietGestart.push({ soort, id, reden, om: o.klok.nu().getTime() }); p.klaar = true; return true }
  try {
    await draaiDepot(o.deps)
  } finally { nepSessies.openFout = null }
  assert.equal(nietGestart.length, 1)
  assert.deepEqual([nietGestart[0].soort, nietGestart[0].id], ['planner', 'p2'])
  assert.match(nietGestart[0].reden, /inloggen/)
  assert.ok(nietGestart[0].om - minNa(0) < 30 * 60_000, `binnen een half uur (${Math.round((nietGestart[0].om - minNa(0)) / 60_000)} min)`)
})

test('407 midden in een taak (bv. het RVA-tabblad): sessie dicht als proxy_geweigerd, en elke keer de huidige proxy toetsen', async () => {
  let n = 0
  const toetsen = []
  const o = opzet({
    duurMin: 12,
    // Hersteld met andere poorten (07-11): de oude ingang blijft 407 geven, de nieuwe werkt.
    toetsProxy: (proxy, nu) => { toetsen.push(proxy.server); return proxy.server.endsWith(':20001') ? { status: 200, geweigerd: false } : { status: 407, geweigerd: true } },
    handlers: { ritmonitor: async (ctx, dag) => {
      if (++n === 1) { ctx.sessie.proxy407 = 2; throw new Error('RVA niet in beeld na 90 s (url: https://pnl-rva.p15.cldsvc.net/)') }
      return ritmonitorLukt(ctx, dag)
    } },
  })
  o.deps.huidigeProxy = () => ({ server: o.klok.nu().getTime() >= minNa(8) ? 'http://proxy.test:20001' : 'http://proxy.test:10002' })
  await draaiDepot(o.deps)
  assert.ok(o.log.includes('dicht:1:proxy_geweigerd'))
  assert.equal(o.meldingen.filter(m => m.soort === 'proxy_geweigerd').length, 1)
  assert.equal(toetsen.at(-1), 'http://proxy.test:20001', 'hersteld op een andere poort: gezien')
  assert.equal(o.meldingen.filter(m => m.soort === 'proxy_hersteld').length, 1)
  assert.equal(o.meldingen.find(m => m.soort === 'proxy_hersteld').bron, 'decodo-proxy')
})

test('losse 407 en de proxy werkt: geen melding, opdrachten blijven staan, gewoon opnieuw inloggen', async () => {
  let n = 0
  const p = plannerOpdracht('p3')
  const nietGestart = []
  const o = opzet({
    duurMin: 3, nietGestart, opdrachten: () => [],
    toetsProxy: () => ({ status: 200, geweigerd: false }),
    handlers: { ritmonitor: async (ctx, dag) => {
      if (++n === 1) { ctx.sessie.proxy407 = 1; throw new Error('locator.click: Timeout 30000ms exceeded') }
      return ritmonitorLukt(ctx, dag)
    } },
  })
  await draaiDepot(o.deps)
  assert.ok(!o.meldingen.some(m => m.soort.startsWith('proxy_')))
  assert.deepEqual(nietGestart, [])
  assert.equal(o.log.filter(x => x.startsWith('open')).length, 2, 'volgende taak logt in')
  assert.equal(p.klaar, false)
})

test('Chromium blijft 407 krijgen terwijl de toets lukt: de loginrem geldt, geen hameren', async () => {
  // Elke login geeft 407, de CONNECT-toets slaagt (flappende aanbieder). Zonder rem: 1800 logins per uur.
  nepSessies.openFout = () => geweigerd()
  const o = opzet({ duurMin: 60, toetsProxy: () => ({ status: 200, geweigerd: false }), handlers: { ritmonitor: ritmonitorLukt } })
  try {
    await draaiDepot(o.deps)
  } finally { nepSessies.openFout = null }
  const logins = o.log.filter(x => x.startsWith('open')).length
  assert.ok(logins <= 4 + 13, `hooguit de rem plus één per toets (${logins})`)
  assert.ok(o.meldingen.some(m => m.soort === 'proxy_geweigerd'), 'en dan wel een melding')
})

test('een time-out van de toets is geen herstel: hij blijft wachten en logt niet in', async () => {
  nepSessies.openFout = () => geweigerd()
  const o = opzet({ duurMin: 20, toetsProxy: () => ({ status: null, geweigerd: false, fout: 'timeout' }), handlers: { ritmonitor: ritmonitorLukt } })
  try {
    await draaiDepot(o.deps)
  } finally { nepSessies.openFout = null }
  assert.equal(o.log.filter(x => x.startsWith('open')).length, 1)
  assert.ok(!o.meldingen.some(m => m.soort === 'proxy_hersteld'))
})

test('wachten op de proxy: elke POLL-ronde vrij om te stoppen, slot kwijt = uit de wachtlus', async () => {
  nepSessies.openFout = () => geweigerd()
  let slotVan = true
  const o = opzet({ duurMin: 3, timers: true, slot: (nu) => { slotVan = nu.getTime() < minNa(1.5); return slotVan }, toetsProxy: () => ({ status: 407, geweigerd: true }), handlers: { ritmonitor: ritmonitorLukt } })
  try {
    await draaiDepot(o.deps)
  } finally { nepSessies.openFout = null }
  assert.ok(o.meldingen.some(m => m.soort === 'slot_kwijt'), 'bovenaan de lus afgehandeld, niet doorgewacht')
})

test('inloggen faalt voor het depot: de teller geldt voor alle wachtende opdrachten, niet per opdracht opnieuw', async () => {
  const a = plannerOpdracht('a')
  const b = plannerOpdracht('b')
  const nietGestart = []
  nepSessies.openFout = () => new Error('Planning-menu niet zichtbaar na 90s')
  const o = opzet({ duurMin: 30, opdrachten: (nu) => [...a.opdrachten(nu), ...b.opdrachten(nu)], handlers: { ritmonitor: ritmonitorLukt, planner: async () => { throw new Error('mag niet') } } })
  const pogingen = () => o.log.filter(x => x.startsWith('open')).length
  o.deps.opslag.opdrachtNietGestart = async (soort, id, reden) => { nietGestart.push({ id, pogingen: pogingen() }); (id === 'a' ? a : b).klaar = true; return true }
  try {
    await draaiDepot(o.deps)
  } finally { nepSessies.openFout = null }
  assert.deepEqual(nietGestart.map(x => x.id).sort(), ['a', 'b'])
  assert.deepEqual(nietGestart.map(x => x.pogingen), [3, 3], 'allebei na de derde poging, niet drie extra per opdracht')
})

test('een geslaagde taak met een losse 407 sluit de sessie niet', async () => {
  const o = opzet({ duurMin: 2, toetsProxy: () => ({ status: 407, geweigerd: true }), handlers: { ritmonitor: async (ctx, dag) => { ctx.sessie.proxy407 = 1; return ritmonitorLukt(ctx, dag) } } })
  await draaiDepot(o.deps)
  assert.ok(!o.log.includes('dicht:1:proxy_geweigerd'))
  assert.equal(o.log.filter(x => x.startsWith('open')).length, 1)
})
