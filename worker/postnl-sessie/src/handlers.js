// Wat elke taak in de browser doet (floatops/matransport#562). Elke handler krijgt de open sessie
// en de dagstatus, en geeft { dag, run } terug: de nieuwe dagstatus en wat er in worker_run_log
// moet. Lukt iets niet, dan gooit hij: de depot-lus classificeert de fout en herstelt.
import { openDagplanning } from '../../credentials-shared/src/postnl/login.js'
import { dagplanningRitten } from '../../credentials-shared/src/postnl/ritten.js'
import { schrijfDagplanning } from '../../credentials-shared/src/postnl/schrijver.js'
import { deadlineUitTekst } from '../../credentials-shared/src/postnl/tekst.js'
import { leesDeadlineTekst, volgMendix } from '../../postnl-planner/src/mendix.js'
import { kiesDag, dagVenster, shiftsOpScherm, kiesShift } from '../../credentials-shared/src/postnl/dagplanningScherm.js'
import { naOchtend, naOchtendNietBeschikbaar, naDefinitief, naRitmonitor, aanvraagKlaar } from './dagstatus.js'

const dagLabel = (datum) => { const [j, m, d] = datum.split('-'); return `${d}-${m}-${j}` }

export class DagNietBeschikbaar extends Error {}

// Dagplanning openen op de dag van vandaag. Staat de dag er nog niet: DagNietBeschikbaar.
// Geeft { geopend, vanaf } voor dagVenster: alleen de antwoorden en ritten van deze dag.
async function naarDag(sessie, datum) {
  const geopend = sessie.antwoorden.length
  await openDagplanning(sessie.page, sessie.depot, { log: sessie.log })
  try {
    const { vanaf } = await kiesDag(sessie.page, dagLabel(datum), sessie.antwoorden)
    return { geopend, vanaf }
  } catch (err) {
    if (err.dagOntbreekt) throw new DagNietBeschikbaar(err.message)
    throw err
  }
}

// Eén shift kiezen en de antwoorden + deadline van PostNL teruggeven.
async function leesShift(sessie, shift, datum) {
  const vanaf = sessie.antwoorden.length
  await kiesShift(sessie.page, shift, sessie.antwoorden)
  const deadline = deadlineUitTekst(await leesDeadlineTekst(sessie.page), datum)
  return { antwoorden: sessie.antwoorden.slice(vanaf), deadline }
}

async function schrijf(ctx, gelezen, datum) {
  const uit = await schrijfDagplanning(ctx.supabase, { klantId: ctx.klantId, datum, depot: ctx.depot.naam, gelezen, kolommen: ctx.kolommen })
  if (uit.tegenstrijdig?.length) {
    throw Object.assign(new Error(`Twee verschillende versies van rit(ten) ${uit.tegenstrijdig.join(', ')}: niet geschreven`), { deels: uit })
  }
  if (uit.kanaalOnbekend.length) {
    // Niet stil: deze ritten zijn niet geschreven, en dat staat in de run-log.
    throw Object.assign(new Error(`Kanaal onbekend voor rit(ten) ${uit.kanaalOnbekend.join(', ')}: niet geschreven`), { deels: uit })
  }
  return uit
}

// De planner (postnl-planner/src/index.js) pas laden als er een opdracht is: hij leest bij het
// laden zijn omgeving, en de tests van de sessiehouder hebben die niet. Tests vervangen hem.
export const planner = { laad: () => import('../../postnl-planner/src/index.js') }

export const HANDLERS = {
  // Opdracht uit de Plannen-tab (#557) in deze open sessie: geen tweede login, geen uitloggen,
  // geen eigen slot (de sessiehouder heeft het). De planner-logica zelf is die van postnl-planner:
  // die zet de opdracht op klaar/mislukt, schrijft zijn run-log en herhaalt een doorvoer nooit.
  async planner(ctx, dag, { id }) {
    const { sessie, supabase } = ctx
    const { data: taak, error } = await supabase.from('planning_taken').select('*').eq('id', id).maybeSingle()
    if (error) throw Object.assign(new Error(`Planner-opdracht niet gelezen: ${error.message}`), { database: true })
    // Al opgepakt (vangnet-script) of afgeblazen: niets doen.
    if (!taak || taak.status !== 'wacht') return { dag: aanvraagKlaar(dag, id), run: null }
    const inDezeSessie = async (depot, doorvoeren, werk) => {
      await openDagplanning(sessie.page, sessie.depot, { log: sessie.log })
      // Per opdracht een nieuwe teller van openstaande PostNL-vragen: in een sessie die uren loopt
      // kan er een blijven openstaan (Den Hoorn 02-11), en die mag de planner niet laten wachten.
      await werk(sessie.page, volgMendix(sessie.page))
    }
    const { verwerk } = await planner.laad()
    const uit = await verwerk(taak, { metSessie: inDezeSessie, stapStart: 'PostNL-sessie open' })
    sessie.lezingen++
    const doorvoer = taak.soort === 'doorvoeren'
    const gebeurtenis = { soort: 'planner', taak_id: id, opdracht: taak.soort, uitkomst: uit.fout ? 'mislukt' : 'klaar', telling: uit.telling }
    // Mislukt: gooien, zodat de lus de sessie beoordeelt (verlopen, gegooid, ...). De planner heeft
    // de opdracht en zijn run-log al afgesloten (alGelogd).
    if (uit.fout) throw Object.assign(uit.fout, { alGelogd: true, gebeurtenis, plannerRun: uit.runId, bewaren: doorvoer })
    return { dag: { ...aanvraagKlaar(dag, id), plannerOm: ctx.nu.toISOString() }, run: null, gebeurtenis, plannerRun: uit.runId, bewaren: doorvoer, melding: doorvoer ? `doorvoer ${JSON.stringify(uit.telling)}` : 'ophalen' }
  },

  // Volle lezing: alle shifts, ritten aanmaken, deadline per shift één keer vastleggen.
  async ochtend(ctx, dag) {
    const { sessie, nu } = ctx
    let keuze
    try {
      keuze = await naarDag(sessie, dag.datum)
    } catch (err) {
      if (err instanceof DagNietBeschikbaar) return { dag: naOchtendNietBeschikbaar(dag, { nu, cfg: ctx.cfg }), run: null, melding: 'dag nog niet in PostNL' }
      throw err
    }
    const shifts = await shiftsOpScherm(sessie.page)
    if (!shifts.length) throw new Error('Geen shifts zichtbaar in de Dagplanning')
    const venster = dagVenster(sessie.antwoorden, keuze)
    const alle = [...venster.antwoorden]
    const perShift = {}
    for (const shift of shifts) {
      const r = await leesShift(sessie, shift, dag.datum)
      alle.push(...r.antwoorden)
      perShift[shift] = { deadline: r.deadline }
    }
    const ritten = dagplanningRitten(alle, { negeer: venster.negeer }).filter(r => !r.datum || r.datum === dag.datum)
    for (const [shift, s] of Object.entries(perShift)) {
      const vanShift = ritten.filter(r => r.shiftPostnl === String(parseInt(shift, 10)))
      s.geautoriseerd = vanShift.length > 0 && vanShift.every(r => r.geautoriseerd === true)
      s.ritten = vanShift.length
    }
    const uit = await schrijf(ctx, ritten, dag.datum)
    sessie.lezingen++
    return {
      dag: naOchtend(dag, { nu, shifts: perShift }),
      run: { worker: 'postnl-dagplanning', status: 'ok', depots_ok: 1, rijen_gelezen: ritten.length,
        lezingen: { [ctx.depot.naam]: { soort: 'ochtend', shifts: Object.keys(perShift).length, bijgewerkt: uit.bijgewerkt, nieuw: uit.nieuw } } },
    }
  },

  // Eén shift na zijn deadline: geautoriseerd? Dan (of via het vangnet) de definitieve lezing.
  async definitief(ctx, dag, { shift }) {
    const { sessie, nu } = ctx
    const keuze = await naarDag(sessie, dag.datum)
    const r = await leesShift(sessie, shift, dag.datum)
    const venster = dagVenster(sessie.antwoorden, keuze)
    const ritten = dagplanningRitten(venster.antwoorden, { negeer: venster.negeer })
      .filter(x => (!x.datum || x.datum === dag.datum) && x.shiftPostnl === String(parseInt(shift, 10)))
    const geautoriseerd = ritten.length > 0 && ritten.every(x => x.geautoriseerd === true)
    const besluit = naDefinitief(dag, shift, { nu, geautoriseerd, cfg: ctx.cfg })
    if (!besluit.schrijven) return { dag: besluit.dag, run: null, melding: `shift ${shift} nog niet geautoriseerd` }
    const uit = await schrijf(ctx, ritten, dag.datum)
    sessie.lezingen++
    return {
      dag: besluit.dag,
      run: { worker: 'postnl-dagplanning', status: 'ok', depots_ok: 1, rijen_gelezen: ritten.length,
        lezingen: { [ctx.depot.naam]: { soort: 'definitief', shift, vangnet: besluit.vangnet, deadline: r.deadline, bijgewerkt: uit.bijgewerkt, nieuw: uit.nieuw } } },
      ...(besluit.vangnet ? { melding: 'autorisatie_niet_gezien', gebeurtenis: { soort: 'autorisatie_niet_gezien', shift } } : {}),
    }
  },

  async ritmonitor(ctx, dag) {
    const { sessie, nu, ritmonitor } = ctx
    await ritmonitor.openRitmonitor(sessie.page, sessie.depot)
    const { rijen, leegBevestigd } = await ritmonitor.leesRitmonitor(sessie.page)
    await ritmonitor.opslaanMonitor(rijen, dag.datum, sessie.depot.naam, leegBevestigd)
    sessie.lezingen++
    const reden = Object.values(dag.shifts ?? {}).some(s => s.geautoriseerdOm) ? 'autorisatie' : Object.values(dag.shifts ?? {}).some(s => s.vangnet) ? 'vangnet_shift' : 'vangnet_tijd'
    // Telt mee in de samengevatte ritmonitor-run (index.js), niet een rij per lezing.
    return { dag: naRitmonitor(dag, { nu, reden }), ritmonitor: { rijen: rijen.length, leegBevestigd } }
  },
}
