// node --test — de planner-taak van de sessiehouder (floatops/matransport#562 stap 2): de opdracht
// in de open sessie uitvoeren met de planner-logica van postnl-planner (hier vervangen door een nep).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HANDLERS, planner, stopBijPlannerOpdracht, RVA_STOP_MS } from '../src/handlers.js'
import { nieuweDag } from '../src/dagstatus.js'

const dag = { ...nieuweDag('2026-11-03'), aanvragen: [{ id: 't1', soort: 'planner' }] }
const supabaseMet = (taak) => ({ from: () => ({ select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: taak, error: null }) }) }) }) })
const sessie = () => ({ page: {}, depot: { naam: 'Depot A' }, lezingen: 0 })

test('opdracht al opgepakt door het vangnet-script (status bezig): niets uitvoeren', async () => {
  let aangeroepen = false
  planner.laad = async () => ({ verwerk: async () => { aangeroepen = true } })
  const uit = await HANDLERS.planner({ sessie: sessie(), supabase: supabaseMet({ id: 't1', status: 'bezig', soort: 'ophalen' }) }, dag, { id: 't1' })
  assert.equal(aangeroepen, false)
  assert.deepEqual(uit.dag.aanvragen, [])
})

test('gelukt: planner krijgt deze sessie (geen eigen login), aanvraag klaar, doorvoer wordt bewaard', async () => {
  let opties = null
  planner.laad = async () => ({ verwerk: async (taak, o) => { opties = o; return { fout: null, telling: { gelukt: 2 }, runId: 'r1' } } })
  const s = sessie()
  const uit = await HANDLERS.planner({ sessie: s, nu: new Date('2026-11-03T09:00:00Z'), supabase: supabaseMet({ id: 't1', status: 'wacht', soort: 'doorvoeren' }) }, dag, { id: 't1' })
  assert.equal(uit.dag.plannerOm, '2026-11-03T09:00:00.000Z', 'sessie blijft daarna nog even open (rij.js)')
  assert.equal(typeof opties.metSessie, 'function', 'sessie-aanbieder meegegeven')
  assert.equal(opties.stapStart, 'PostNL-sessie open')
  assert.deepEqual(uit.dag.aanvragen, [])
  assert.equal(uit.bewaren, true)
  assert.equal(uit.plannerRun, 'r1')
  assert.equal(s.lezingen, 1)
})

test('mislukt: gooit voor de herstel-beoordeling, gemarkeerd als al gelogd door de planner', async () => {
  planner.laad = async () => ({ verwerk: async () => ({ fout: new Error('PostNL reageerde niet'), telling: {}, runId: 'r2' }) })
  await assert.rejects(
    HANDLERS.planner({ sessie: sessie(), supabase: supabaseMet({ id: 't1', status: 'wacht', soort: 'ophalen' }) }, dag, { id: 't1' }),
    (err) => err.alGelogd === true && err.plannerRun === 'r2' && err.gebeurtenis.uitkomst === 'mislukt' && err.bewaren === false,
  )
})

test('na een planner-opdracht blijft de sessie sluitNaLeegMin open, daarna dicht', async () => {
  const { kies } = await import('../src/rij.js')
  const { mergeInstellingen: echt } = await import('../src/instellingen.js')
  const mergeInstellingen = (c = {}) => echt({ gisterenNalezen: false, ...c })
  const cfg = mergeInstellingen({ sessieOpenHouden: false, plannenVerversen: false })
  const d = { ...nieuweDag('2026-11-03'), ochtend: { gelezenOm: '2026-11-03T04:31:00Z' }, shifts: { '01': { deadline: '2026-11-03T13:00:00Z' } }, plannerOm: '2026-11-03T05:00:00Z' }
  assert.equal(kies(d, new Date('2026-11-03T05:05:00Z'), cfg).sessieNodig, true, '5 min later: open')
  assert.equal(kies(d, new Date('2026-11-03T05:11:00Z'), cfg).sessieNodig, false, '11 min later: dicht (06:11, vóór de ritmonitor)')
})

test('standaard blijft de sessie de hele werkdag open, ook tussen de ochtendlezing en de eerste deadline', async () => {
  const { kies } = await import('../src/rij.js')
  const { mergeInstellingen: echt } = await import('../src/instellingen.js')
  const mergeInstellingen = (c = {}) => echt({ gisterenNalezen: false, ...c })
  const d = { ...nieuweDag('2026-11-03'), ochtend: { gelezenOm: '2026-11-03T04:31:00Z' }, shifts: { '01': { deadline: '2026-11-03T07:00:00Z' } }, laatsteTaakOm: '2026-11-03T04:55:00Z' }
  const k = kies(d, new Date('2026-11-03T05:00:00Z'), mergeInstellingen({ plannenVerversen: false }))
  assert.equal(k.taak, undefined, 'niets te doen tot de deadline')
  assert.equal(k.sessieNodig, true, 'maar de sessie blijft open')
})

test('plannen-handler: loopt er een Plannen-opdracht, dan niet ertussen, wel de tijd vastleggen', async () => {
  let aangeroepen = false
  planner.laad = async () => ({ verversPlanning: async () => { aangeroepen = true } })
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: [{ id: 'x' }], error: null }) }) }) }) }) }
  const nu = new Date('2026-11-03T06:00:00Z')
  const uit = await HANDLERS.plannen({ sessie: sessie(), supabase, klantId: 'k', nu }, dag, { soort: 'stops', shifts: ['07'] })
  assert.equal(aangeroepen, false)
  assert.equal(uit.dag.plannen.stopsOm['07'], nu.toISOString())
})

test('verversronde houdt op zodra er na het begin een Plannen-opdracht binnenkomt (matransport#578)', () => {
  let signaal = 1000
  const stoppen = stopBijPlannerOpdracht({ plannerSignaal: () => signaal }, 2000)
  assert.equal(stoppen(), false, 'signaal van vóór de ronde: doorlezen')
  signaal = 2500
  assert.equal(stoppen(), true, 'opdracht binnen tijdens de ronde: ophouden')
  assert.equal(stopBijPlannerOpdracht({}, 2000)(), false, 'zonder signaal (losse scripts): nooit ophouden')
})

test('een RVA-opdracht stopt een ronde, hoogstens eens per 5 min per depot, en de stand blijft staan (#600)', () => {
  let rva = 0
  const ctx = { rvaSignaal: () => rva, rvaStop: { om: 0 } }
  const begin = RVA_STOP_MS * 2
  const stoppen = stopBijPlannerOpdracht(ctx, begin)
  assert.equal(stoppen(), false)
  rva = begin + 1
  assert.equal(stoppen(), true, 'eerste keer: ophouden')
  assert.equal(stoppen(), true, 'en blijven ophouden in deze ronde')
  assert.equal(stopBijPlannerOpdracht(ctx, begin + 1000)(), false, 'volgende ronde binnen 5 min: doorlezen, anders hongeren de achterste ritten uit')
  rva = begin + RVA_STOP_MS + 1
  assert.equal(stopBijPlannerOpdracht(ctx, begin + RVA_STOP_MS)(), true, 'na 5 min weer wel')
})

test('de laatste lezing stopt niet voor RVA, wel voor Plannen en het stopsein (#600)', () => {
  const signaal = 3000
  const ctx = { rvaSignaal: () => signaal, rvaStop: { om: 0 } }
  assert.equal(stopBijPlannerOpdracht(ctx, 2000, { rva: false })(), false)
  assert.equal(stopBijPlannerOpdracht({ plannerSignaal: () => 3000 }, 2000, { rva: false })(), true)
  assert.equal(stopBijPlannerOpdracht({ gestopt: () => true }, 2000, { rva: false })(), true)
})

function supabaseGeenOpdrachten() {
  return { from: () => ({ select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: [], error: null }) }) }) }) }) }
}

test('plannen-handler: de laatste lezing telt pas als de ronde helemaal klaar is (#600)', async () => {
  const opties = []
  let gestopt = false
  planner.laad = async () => ({ verversPlanning: async (p, m, o) => { opties.push(o); return { stops: { nieuw: 0, gewijzigd: 0, weg: 0 }, ritten: null, gestopt } } })
  const nu = new Date('2026-11-03T12:00:00Z')
  const s = { ...sessie(), page: { locator: () => ({ first: () => ({ isVisible: async () => true, waitFor: async () => {}, click: async () => {} }) }), url: () => 'https://x/', goto: async () => null, waitForLoadState: async () => {}, getByText: () => ({ first: () => ({ waitFor: async () => {} }) }), on() {}, waitForTimeout: async () => {} }, log: { log() {}, warn() {} } }
  const ctx = { sessie: s, supabase: supabaseGeenOpdrachten(), klantId: 'k', nu }
  const uit = await HANDLERS.plannen(ctx, dag, { soort: 'stops', shifts: ['07'], naAutorisatie: true })
  assert.equal(opties[0].naDeadline, true)
  assert.equal(uit.dag.plannen.stopsDefinitiefOm['07'], nu.toISOString())
  gestopt = true
  const nog = await HANDLERS.plannen(ctx, dag, { soort: 'stops', shifts: ['07'], naAutorisatie: true })
  assert.equal(nog.dag.plannen.stopsDefinitiefOm?.['07'], undefined, 'gestopt: de volgende keer opnieuw')
  assert.equal(nog.dag.plannen.stopsOm['07'], nu.toISOString(), 'wel de tijd, voor de beurtrol')
})

// Nachtlezing (matransport#690): alleen een geslaagde, complete lezing telt als gelezen.
const nepPagina = () => ({ locator: () => ({ first: () => ({ isVisible: async () => true, waitFor: async () => {}, click: async () => {} }) }), url: () => 'https://x/', goto: async () => null, waitForLoadState: async () => {}, getByText: () => ({ first: () => ({ waitFor: async () => {} }) }), on() {}, waitForTimeout: async () => {} })
const nachtCtx = (supabase = supabaseGeenOpdrachten()) => ({ sessie: { ...sessie(), page: nepPagina(), log: { log() {}, warn() {} } }, supabase, klantId: 'k', nu: new Date('2026-11-03T23:10:00Z'), cfg: { dagNietBeschikbaarWachtMin: 5 } })
const nachtDag = nieuweDag('2026-11-04')

test('nacht-handler: geslaagd telt als gelezen, alle shifts, ochtend en shifts blijven leeg', async () => {
  let opties
  planner.laad = async () => ({ verversPlanning: async (p, m, o) => { opties = o; return { ritten: { nieuw: 26, gewijzigd: 0, weg: 0 }, stops: { nieuw: 3500, gewijzigd: 0, weg: 0 }, gestopt: false } } })
  const uit = await HANDLERS.nacht(nachtCtx(), nachtDag)
  assert.equal(opties.shifts, null, 'alle shifts')
  assert.equal(opties.soort, 'stops')
  assert.ok(uit.dag.nacht.gelezenOm)
  assert.deepEqual(uit.dag.ochtend, {}, 'de ochtendlezing van 05:30 blijft staan')
  assert.deepEqual(uit.dag.shifts, {}, 'geen deadlines vastgelegd')
})

test('nacht-handler: dag nog niet in PostNL of een lege lezing: over 5 min opnieuw, niet gelezen', async () => {
  for (const tekst of ['Dag wo 04 nov staat niet in de PostNL-planning.', 'Op 2026-11-04 geen ritten gelezen: lezing niet vertrouwd, de dag staat niet in de PostNL-planning.']) {
    planner.laad = async () => ({ verversPlanning: async () => { throw new Error(tekst) } })
    const ctx = nachtCtx()
    const uit = await HANDLERS.nacht(ctx, nachtDag)
    assert.equal(uit.dag.nacht.gelezenOm, undefined, tekst)
    assert.equal(uit.dag.nacht.nietBeschikbaarTot, new Date(ctx.nu.getTime() + 5 * 60_000).toISOString())
  }
})

test('nacht-handler: onderbroken door een opdracht telt niet als gelezen', async () => {
  planner.laad = async () => ({ verversPlanning: async () => ({ ritten: null, stops: { nieuw: 1, gewijzigd: 0, weg: 0 }, gestopt: true }) })
  const uit = await HANDLERS.nacht(nachtCtx(), nachtDag)
  assert.equal(uit.dag.nacht.gelezenOm, undefined)
  assert.ok(uit.dag.nacht.nietBeschikbaarTot)
})

test('nacht-handler: een lopende Plannen-opdracht gaat voor', async () => {
  let aangeroepen = false
  planner.laad = async () => ({ verversPlanning: async () => { aangeroepen = true } })
  const supabase = { from: () => ({ select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: [{ id: 'x' }], error: null }) }) }) }) }) }
  const uit = await HANDLERS.nacht(nachtCtx(supabase), nachtDag)
  assert.equal(aangeroepen, false)
  assert.equal(uit.dag.nacht.gelezenOm, undefined)
  assert.ok(uit.dag.nacht.nietBeschikbaarTot)
})

test('nacht-handler: een andere fout of databasefout gooit, met de dag erbij voor de 5 min rust', async () => {
  planner.laad = async () => ({ verversPlanning: async () => { throw new Error('PostNL reageerde niet') } })
  await assert.rejects(HANDLERS.nacht(nachtCtx(), nachtDag), (e) => e.message === 'PostNL reageerde niet' && !!e.dag.nacht.nietBeschikbaarTot)
  const kapot = { from: () => ({ select: () => ({ eq: () => ({ in: () => ({ limit: async () => ({ data: null, error: { message: 'weg' } }) }) }) }) }) }
  await assert.rejects(HANDLERS.nacht(nachtCtx(kapot), nachtDag), (e) => e.database === true && !!e.dag.nacht.nietBeschikbaarTot)
})
