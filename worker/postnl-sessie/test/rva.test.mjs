// node --test — RVA in de sessiehouder (floatops/matransport#569): de taken rva/rvaWakker, 24/7,
// de handler (wacht → bezig → klaar/mislukt, nooit twee keer) en de lus (op volgorde, het juiste
// tabblad beoordelen).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { TAAK } from '../src/taken.js'
import { kies } from '../src/rij.js'
import { mergeInstellingen } from '../src/instellingen.js'
import { nieuweDag } from '../src/dagstatus.js'
import { HANDLERS, rva } from '../src/handlers.js'
import { draaiDepot } from '../src/depot.js'

const AAN = mergeInstellingen({ rva: true })
const UIT = mergeInstellingen({})
const zondagNacht = new Date('2026-11-08T02:00:00+01:00')
const dinsdag = new Date('2026-11-03T10:00:00+01:00')

test('taak rva: alleen met cfg.rva, en steeds de oudste opdracht', () => {
  const dag = { ...nieuweDag('2026-11-03'), aanvragen: [{ id: 'eerst', soort: 'rva' }, { id: 'p', soort: 'planner' }, { id: 'later', soort: 'rva' }] }
  assert.equal(TAAK.rva.volgende(dag, dinsdag, UIT), null)
  assert.deepEqual(TAAK.rva.volgende(dag, dinsdag, AAN).args, { id: 'eerst', soort: 'rva' })
  assert.equal(TAAK.rva.volgende({ ...dag, aanvragen: [] }, dinsdag, AAN), null)
})

test('taak rva gaat vóór OOM PD-taken, maar na een planner-opdracht', () => {
  assert.ok(TAAK.rva.prioriteit > TAAK.ritmonitor.prioriteit && TAAK.rva.prioriteit > TAAK.plannen.prioriteit)
  assert.ok(TAAK.rva.prioriteit < TAAK.planner.prioriteit)
})

test('rva en rvaWakker draaien ook zondagnacht (rvaAltijd), niet als rvaAltijd uit staat', () => {
  const dag = { ...nieuweDag('2026-11-08'), aanvragen: [{ id: 'o1', soort: 'rva' }] }
  assert.equal(TAAK.rva.volgende(dag, zondagNacht, AAN).nu, true)
  assert.equal(TAAK.rvaWakker.volgende(dag, zondagNacht, AAN).nu, true)
  assert.equal(TAAK.rvaWakker.volgende(dag, zondagNacht, mergeInstellingen({ rva: true, rvaAltijd: false })), null)
})

test('rvaWakker: elke rvaWakkerMin, vanaf de laatste keer', () => {
  const dag = { ...nieuweDag('2026-11-03'), rva: { wakkerOm: '2026-11-03T08:55:00Z' } }
  assert.equal(TAAK.rvaWakker.volgende(dag, new Date('2026-11-03T09:00:00Z'), AAN).om.toISOString(), '2026-11-03T09:05:00.000Z')
  assert.equal(TAAK.rvaWakker.volgende(dag, new Date('2026-11-03T09:05:00Z'), AAN).nu, true)
})

test('de lus stopt zondagnacht niet met RVA aan, wel zonder (zoals altijd)', () => {
  const dag = { ...nieuweDag('2026-11-08'), rva: { wakkerOm: '2026-11-08T00:58:00Z' } }
  const met = kies(dag, zondagNacht, AAN)
  assert.ok(met.wachtTot, 'RVA aan: er is altijd een volgende tijd (rvaWakker)')
  assert.equal(met.sessieNodig, true, 'en de sessie blijft open')
  assert.equal(kies(dag, zondagNacht, UIT).wachtTot, null, 'RVA uit: niets meer te doen, de lus stopt')
})

// Nep-Supabase voor rva_opdrachten: onthoudt de updates, `status` bepaalt de compare-and-set.
function nepDb(opdracht) {
  const updates = []
  let rij = opdracht ? { ...opdracht } : null
  const db = {
    updates,
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: rij, error: null }) }) }) }),
      update: (v) => {
        const filters = {}
        const q = {
          eq: (k, w) => { filters[k] = w; return q },
          select: async () => {
            if (filters.status && rij?.status !== filters.status) return { data: [], error: null }
            updates.push(v)
            rij = { ...rij, ...v }
            return { data: [{ id: rij.id }], error: null }
          },
        }
        return q
      },
    }),
  }
  return db
}

const nepSessie = () => ({
  depot: { naam: 'Depot A', username: 'u', password: 'p' }, lezingen: 0, herlogins: 0, leeftijdMin: 30,
  log: { log() {}, warn() {}, error() {} },
  rvaPage: null,
  async rvaTab() { this.rvaPage = this.rvaPage ?? { naam: 'rva-tab', on() {} }; return this.rvaPage },
})
const opdracht = { id: 'o1', status: 'wacht', rit: 'proefrit', weekdag: 'Za', handelingen: [{ soort: 'richting', regel: { postcode: '1234AB', straat: 'Appelstraat', van: 1, tm: 9, evenOneven: 'Oneven' }, richting: 'Aflopend' }] }
const dag = () => ({ ...nieuweDag('2026-11-03'), aanvragen: [{ id: 'o1', soort: 'rva' }] })
const nu = new Date('2026-11-03T09:00:00Z')

test('rva-handler: opdracht staat al niet meer op wacht → niets doen, aanvraag weg', async () => {
  let uitgevoerd = false
  rva.laad = async () => ({ voerUit: async () => { uitgevoerd = true } })
  const db = nepDb({ ...opdracht, status: 'bezig' })
  const uit = await HANDLERS.rva({ sessie: nepSessie(), supabase: db, klantId: 'k', nu }, dag(), { id: 'o1' })
  assert.equal(uitgevoerd, false)
  assert.deepEqual(uit.dag.aanvragen, [])
  assert.equal(db.updates.length, 0)
})

test('rva-handler: gelukt in het RVA-tabblad, regel-object wordt sleutel, proefstand zonder RVA_ECHT', async () => {
  delete process.env.RVA_ECHT
  let mee = null
  rva.laad = async () => ({
    regelSleutel: (r) => `${r.postcode}|${r.straat}|${r.van}|${r.tm}|${r.evenOneven}`.toLowerCase(),
    openRva: async (page) => { assert.equal(page.naam, 'rva-tab'); return { ingelogd: false } },
    voerUit: async (page, mendix, o, opties) => {
      mee = { page, o, opties }
      await opties.opStap({ stap: 'Wijziging 1 van 1', voortgang: 20 })
      return { stappen: [{ nr: 1, soort: 'richting', ok: true }], opgeslagen: opties.echt, na: [1, 2, 3] }
    },
  })
  const db = nepDb(opdracht)
  const s = nepSessie()
  const uit = await HANDLERS.rva({ sessie: s, supabase: db, klantId: 'k', nu }, dag(), { id: 'o1' })
  assert.equal(mee.page.naam, 'rva-tab', 'in het tweede tabblad, geen nieuwe login')
  assert.equal(mee.opties.echt, false)
  assert.deepEqual(mee.o, { rit: 'proefrit', dag: 'Za', handelingen: [{ ...opdracht.handelingen[0], regel: '1234ab|appelstraat|1|9|oneven' }] })
  assert.deepEqual(db.updates.map(u => [u.status ?? u.stap, u.voortgang]), [['bezig', 5], ['Wijziging 1 van 1', 20], ['klaar', 100]], 'voortgangsbalk: elke stap live')
  assert.match(db.updates.at(-1).melding, /Proefstand/)
  assert.equal(uit.bewaren, true, 'ook in de proefstand: opname 30 dagen bewaren')
  assert.deepEqual(uit.dag.aanvragen, [])
  assert.equal(uit.dag.rva.wakkerOm, nu.toISOString())
  assert.equal(uit.run.status, 'ok')
  assert.equal(s.lezingen, 1)
})

test('rva-handler: RVA_ECHT=ja → echt opslaan, opname bewaren', async () => {
  process.env.RVA_ECHT = 'ja'
  let echt = null
  rva.laad = async () => ({ regelSleutel: () => 'x', openRva: async () => ({ ingelogd: false }), voerUit: async (p, m, o, opties) => { echt = opties.echt; return { stappen: [], opgeslagen: true, na: [] } } })
  const db = nepDb(opdracht)
  const uit = await HANDLERS.rva({ sessie: nepSessie(), supabase: db, klantId: 'k', nu }, dag(), { id: 'o1' })
  assert.equal(echt, true)
  assert.equal(uit.bewaren, true)
  assert.equal(db.updates.at(-1).melding, 'Opgeslagen in RVA')
  delete process.env.RVA_ECHT
})

test('rva-handler: fout → mislukt met de reden, geen herhaling (aanvraag weg), gooit voor de herstel-beoordeling', async () => {
  rva.laad = async () => ({
    regelSleutel: () => 'x', openRva: async () => ({ ingelogd: false }),
    voerUit: async () => { throw Object.assign(new Error('Geen Wijzig-knop'), { soort: 'geen_rechten', stappen: [] }) },
  })
  const db = nepDb(opdracht)
  await assert.rejects(
    HANDLERS.rva({ sessie: nepSessie(), supabase: db, klantId: 'k', nu }, dag(), { id: 'o1' }),
    (err) => err.dag.aanvragen.length === 0 && err.bewaren === true,
  )
  assert.equal(db.updates.at(-1).status, 'mislukt')
  assert.equal(db.updates.at(-1).melding, '[geen_rechten] Geen Wijzig-knop')
})

test('rvaWakker: Rittenoverzicht verversen; was de sessie verlopen, dan een gebeurtenis', async () => {
  let ververst = 0
  rva.laad = async () => ({ openRva: async () => ({ ingelogd: true }), naarRittenoverzicht: async () => { ververst++ } })
  const s = nepSessie()
  const uit = await HANDLERS.rvaWakker({ sessie: s, nu }, nieuweDag('2026-11-03'))
  assert.equal(ververst, 1)
  assert.equal(uit.gebeurtenis.soort, 'rva_verlopen_stil')
  assert.equal(s.herlogins, 1)
  assert.equal(uit.dag.rva.wakkerOm, nu.toISOString())
})

test('lus: twee RVA-opdrachten na elkaar op volgorde, en een OOM PD-startpagina telt bij RVA niet als gegooid', async () => {
  const start = new Date('2026-11-08T02:00:00+01:00').getTime()  // zondagnacht
  let t = start
  const klok = { nu: () => new Date(t), slaap: async (ms) => { t += ms } }
  const volgorde = []
  const gebeurtenissen = []
  let wachtend = [{ id: 'a' }, { id: 'b' }]
  const sessie = {
    id: 's1', depotHost: 'depot-a.example', leeftijdMin: 1, segmentOm: Date.now(), lezingen: 0,
    page: { url: () => 'https://depot-a.example/index.html', locator: () => ({ first: () => ({ isVisible: async () => true }) }) },
    rvaPage: { url: () => 'https://pnl-rva.p15.cldsvc.net/index.html' },
    async openen() {}, async taakBegin() {}, async taakEinde() { return null }, async sluiten() {},
  }
  await draaiDepot({
    depot: { naam: 'Depot A' }, klantId: 'k', houder: 'h', cfg: AAN, klok, log: { log() {}, warn() {}, error() {} },
    stop: () => t - start > 3 * 60_000,
    maakSessie: () => sessie,
    handlers: {
      rva: async (ctx, d, { id }) => { volgorde.push(id); wachtend = wachtend.filter(o => o.id !== id); return { dag: { ...d, aanvragen: d.aanvragen.filter(a => a.id !== id) }, run: null } },
      rvaWakker: async (ctx, d) => ({ dag: { ...d, rva: { wakkerOm: ctx.nu.toISOString() } }, run: null }),
    },
    ctx: {}, opStartpagina: async () => true, schatting: () => null,
    melden: async () => {}, naRun: async () => {}, telRitmonitor: () => {},
    opslag: {
      dagstatus: async () => null, bewaarDagstatus: async () => {}, plannerOpdrachten: async () => [],
      rvaOpdrachten: async () => wachtend, slotPak: async () => true, slotLos: async () => {},
      gebeurtenis: async (id, g) => { gebeurtenissen.push(g) }, sessieBij: async () => {},
    },
  })
  assert.deepEqual(volgorde, ['a', 'b'], 'op volgorde van binnenkomst, elk één keer')
  assert.equal(gebeurtenissen.filter(g => g.soort === 'gegooid').length, 0, 'OOM PD op de startpagina telt niet bij een RVA-taak')
})
