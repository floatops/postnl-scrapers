// node --test — de planner-taak van de sessiehouder (floatops/matransport#562 stap 2): de opdracht
// in de open sessie uitvoeren met de planner-logica van postnl-planner (hier vervangen door een nep).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HANDLERS, planner } from '../src/handlers.js'
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
  const { mergeInstellingen } = await import('../src/instellingen.js')
  const cfg = mergeInstellingen({})
  const d = { ...nieuweDag('2026-11-03'), ochtend: { gelezenOm: '2026-11-03T04:31:00Z' }, shifts: { '01': { deadline: '2026-11-03T13:00:00Z' } }, plannerOm: '2026-11-03T05:00:00Z' }
  assert.equal(kies(d, new Date('2026-11-03T05:05:00Z'), cfg).sessieNodig, true, '5 min later: open')
  assert.equal(kies(d, new Date('2026-11-03T05:11:00Z'), cfg).sessieNodig, false, '11 min later: dicht (06:11, vóór de ritmonitor)')
})
