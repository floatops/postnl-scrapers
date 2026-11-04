// Wat elke taak in de browser doet (floatops/matransport#562). Elke handler krijgt de open sessie
// en de dagstatus, en geeft { dag, run } terug: de nieuwe dagstatus en wat er in worker_run_log
// moet. Lukt iets niet, dan gooit hij: de depot-lus classificeert de fout en herstelt.
import { openDagplanning, login } from '../../credentials-shared/src/postnl/login.js'
import { dagplanningRitten, hoortBijShift } from '../../credentials-shared/src/postnl/ritten.js'
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

async function schrijf(ctx, gelezen, datum, { statusNieuw } = {}) {
  const uit = await schrijfDagplanning(ctx.supabase, { klantId: ctx.klantId, datum, depot: ctx.depot.naam, gelezen, kolommen: ctx.kolommen, ...(statusNieuw ? { statusNieuw } : {}) })
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
// De RVA-logica (postnl-rva, matransport#569). Ook pas laden bij de eerste RVA-taak; tests vervangen hem.
export const rva = { laad: () => import('../../postnl-rva/src/index.js') }

// Het RVA-tabblad openen; is de sessie daar verlopen, dan in dat tabblad opnieuw inloggen.
async function rvaKlaar(sessie, r) {
  const page = await sessie.rvaTab()
  const { ingelogd } = await r.openRva(page, { login: (p) => login(p, sessie.depot, { log: sessie.log }) })
  return { page, ingelogd }
}

// Het RVA-tabblad vers laden na een schermfout (matransport#573). true = het staat er weer.
async function herstelRvaTab(sessie, r) {
  try {
    const page = await sessie.rvaTab()
    await page.goto(r.RVA_URL, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    await r.openRva(page, { login: (p) => login(p, sessie.depot, { log: sessie.log }) })
    return true
  } catch {
    return false // bewust: dan gooit de handler de oorspronkelijke fout, en herstelt de depot-lus
  }
}

// Een RVA-opdracht bijwerken. Een databasefout gooit (nooit stil).
async function zetRva(ctx, id, velden, filter = null) {
  let q = ctx.supabase.from('rva_opdrachten').update(velden).eq('id', id).eq('klant_id', ctx.klantId)
  if (filter) q = q.eq('status', filter)
  const { data, error } = await q.select('id')
  if (error) throw Object.assign(new Error(`RVA-opdracht bijwerken: ${error.message}`), { database: true })
  return data ?? []
}

// De gelezen stand van een rit-dag naar rva_regels (matransport#573): dat toont het scherm Rijvolgorde.
async function schrijfRegels(ctx, o, gelezen) {
  const { error } = await ctx.supabase.from('rva_regels').upsert({
    klant_id: ctx.klantId, depot: o.depot, rit: o.rit, weekdag: o.weekdag,
    regels: gelezen.regels, onderbrekingen: gelezen.onderbrekingen, ...(gelezen.revisies ? { revisies: gelezen.revisies } : {}),
    vergrendeld: gelezen.vergrendeld === true, gelezen_at: new Date().toISOString(), opdracht_id: o.id,
  }, { onConflict: 'klant_id,depot,rit,weekdag' })
  if (error) throw Object.assign(new Error(`RVA-regels opslaan: ${error.message}`), { database: true })
}

// Het Rittenoverzicht naar rva_ritten: alleen nieuwe of gewijzigde rijen, en elke 12 uur alles
// (gezien_at; matransport ruimt een rij op die 30 dagen niet gezien is). Geeft het aantal geschreven rijen.
async function schrijfRitten(ctx, r, rijen) {
  const { supabase, klantId, sessie } = ctx
  const depot = sessie.depot.naam
  const { data: bestaand, error } = await supabase.from('rva_ritten')
    .select('sleutel, naam, trip_nummer, ritnummer, dagen, verantwoordelijken, vergrendeld_dagen, gezien_at')
    .eq('klant_id', klantId).eq('depot', depot)
  if (error) throw Object.assign(new Error(`RVA-ritten lezen: ${error.message}`), { database: true })
  const teSchrijven = r.rittenTeSchrijven(bestaand ?? [], rijen, ctx.nu)
  if (!teSchrijven.length) return 0
  const gezien = new Date().toISOString()
  const { error: fout } = await supabase.from('rva_ritten')
    .upsert(teSchrijven.map(x => ({ ...x, klant_id: klantId, depot, gezien_at: gezien })), { onConflict: 'klant_id,depot,sleutel' })
  if (fout) throw Object.assign(new Error(`RVA-ritten opslaan: ${fout.message}`), { database: true })
  return teSchrijven.length
}

// Soorten die bij PostNL direct opslaan (geen Wijzig/Opslaan): alleen met RVA_ECHT=ja.
const RVA_DIRECT = ['kopieren', 'revisie_terug', 'verantwoordelijken']

// Alle shifts en ritten van een dag die al gekozen is (keuze van naarDag).
async function leesDag(sessie, datum, keuze) {
  const shifts = await shiftsOpScherm(sessie.page)
  if (!shifts.length) throw new Error('Geen shifts zichtbaar in de Dagplanning')
  const venster = dagVenster(sessie.antwoorden, keuze)
  const alle = [...venster.antwoorden]
  const perShift = {}
  for (const shift of shifts) {
    const r = await leesShift(sessie, shift, datum)
    alle.push(...r.antwoorden)
    perShift[shift] = { deadline: r.deadline }
  }
  const ritten = dagplanningRitten(alle, { negeer: venster.negeer }).filter(r => !r.datum || r.datum === datum)
  return { ritten, perShift }
}

export const HANDLERS = {
  // De vorige werkdag nalezen (#562): na middernacht is alles geautoriseerd. Alleen verschillen
  // gaan naar ritten (03-11: definitieve cijfers die door een gemiste autorisatie ontbraken).
  async gisteren(ctx, dag, { datum }) {
    const { sessie, nu } = ctx
    let keuze
    try {
      keuze = await naarDag(sessie, datum)
    } catch (err) {
      if (err instanceof DagNietBeschikbaar) {
        return { dag: { ...dag, gisteren: { gelezenOm: nu.toISOString(), datum, nietBeschikbaar: true } }, run: null, melding: `${datum} staat niet meer in PostNL` }
      }
      throw err
    }
    const { ritten, perShift } = await leesDag(sessie, datum, keuze)
    const uit = await schrijf(ctx, ritten, datum, { statusNieuw: 'gereden' })
    sessie.lezingen++
    const melding = uit.bijgewerkt || uit.nieuw ? `${datum}: ${uit.bijgewerkt} bijgewerkt, ${uit.nieuw} nieuw` : null
    return {
      dag: { ...dag, gisteren: { gelezenOm: nu.toISOString(), datum, bijgewerkt: uit.bijgewerkt, nieuw: uit.nieuw } },
      ...(melding ? { melding } : {}),
      run: { worker: 'postnl-dagplanning', status: 'ok', depots_ok: 1, rijen_gelezen: ritten.length,
        lezingen: { [ctx.depot.naam]: { soort: 'gisteren', datum, shifts: Object.keys(perShift).length, bijgewerkt: uit.bijgewerkt, nieuw: uit.nieuw } } },
    }
  },

  // RVA-opdracht (matransport#569): alle wijzigingen van één Opslaan in de app, op één rit-dag, in
  // het RVA-tabblad van deze sessie. Geen tweede login en geen eigen slot. wacht → bezig alleen als
  // hij nog wacht (een opdracht wordt nooit twee keer uitgevoerd), en na een fout geen herhaling:
  // voerUit heeft dan al geannuleerd, de opdracht wordt 'mislukt' met de reden.
  async rva(ctx, dag, { id }) {
    const { sessie, supabase, klantId, nu } = ctx
    const klaar = { ...aanvraagKlaar(dag, id), rva: { ...(dag.rva ?? {}), wakkerOm: nu.toISOString() } }
    const { data: o, error } = await supabase.from('rva_opdrachten').select('*').eq('id', id).eq('klant_id', klantId).maybeSingle()
    if (error) throw Object.assign(new Error(`RVA-opdracht niet gelezen: ${error.message}`), { database: true })
    if (!o || o.status !== 'wacht') return { dag: aanvraagKlaar(dag, id), run: null }
    if (!(await zetRva(ctx, id, { status: 'bezig', gestart_at: new Date().toISOString(), stap: 'RVA openen', voortgang: 5 }, 'wacht')).length) {
      return { dag: aanvraagKlaar(dag, id), run: null }
    }
    const echt = process.env.RVA_ECHT === 'ja'
    const label = `[${sessie.depot.naam}] RVA`
    const log = { log: (...a) => sessie.log.log(label, ...a), warn: (...a) => sessie.log.warn(label, ...a) }
    // Voortgangsbalk in de app: elke stap live naar rva_opdrachten. Mislukt dat bijwerken, dan
    // gaat de opdracht gewoon door (alleen de balk loopt dan achter).
    const opStap = ({ stap, voortgang }) => zetRva(ctx, id, { stap, voortgang }).catch(e => sessie.log.warn(`${label}: voortgang niet bijgewerkt: ${e.message}`))
    const soort = o.soort ?? 'wijzigen'
    // Kopiëren, een revisie terugzetten en verantwoordelijken slaan bij PostNL direct op: in de
    // proefstand niets doen. Geen technische fout, dus niet gooien (geen herstel nodig).
    if (RVA_DIRECT.includes(soort) && !echt) {
      await zetRva(ctx, id, { status: 'mislukt', klaar_at: new Date().toISOString(), stap: null, melding: 'Proefstand: dit slaat in RVA direct op, en RVA_ECHT staat niet aan. Er is niets gewijzigd.' })
      return { dag: klaar, run: null }
    }
    const mendixVan = (page) => volgMendix(page)
    const klaarMet = async (melding, resultaat, gelezen = 0) => {
      await zetRva(ctx, id, { status: 'klaar', klaar_at: new Date().toISOString(), stap: null, voortgang: 100, melding, resultaat })
      sessie.lezingen++
      // bewaren: trace en video van elke RVA-opdracht 30 dagen op de VPS (fout/), ook als hij
      // slaagt en ook in de proefstand: de eerste maand willen we alles kunnen terugkijken.
      return {
        dag: klaar, bewaren: soort !== 'ophalen', melding: `${o.rit} ${o.weekdag}: ${soort} — ${melding}`,
        run: { worker: 'postnl-rva', status: 'ok', depots_ok: 1, rijen_gelezen: gelezen, lezingen: { [sessie.depot.naam]: { opdracht: id, soort, ...resultaat } } },
      }
    }
    // Na een wijziging de nieuwe stand meteen naar de app. Lukt dat niet, dan is de opdracht toch
    // gelukt (de app haalt hem dan zelf op); alleen een waarschuwing.
    const naLezen = async (page) => {
      try {
        await opStap({ stap: 'Nieuwe stand lezen', voortgang: 95 })
        const gelezen = await r.leesRitDag(page, mendixVan(page), o.rit, o.weekdag)
        await schrijfRegels(ctx, o, gelezen)
        return gelezen.regels.length
      } catch (e) {
        log.warn(`nieuwe stand niet gelezen: ${e.message}`)
        return null
      }
    }
    let r
    try {
      r = await rva.laad()
      const { page } = await rvaKlaar(sessie, r)
      const m = mendixVan(page)

      if (soort === 'ophalen') {
        await opStap({ stap: 'Rit-dag openen', voortgang: 30 })
        const gelezen = await r.leesRitDag(page, m, o.rit, o.weekdag)
        await opStap({ stap: 'Regels opslaan', voortgang: 90 })
        await schrijfRegels(ctx, o, gelezen)
        return await klaarMet(`${gelezen.regels.length} regels gelezen`, { regels: gelezen.regels.length }, gelezen.regels.length)
      }

      if (soort === 'kopieren') {
        const { melding } = await r.kopieerNaar(page, m, o.rit, o.weekdag, o.parameters?.naar ?? [], { echt, log, meld: (stap, voortgang) => opStap({ stap, voortgang }) })
        // De doeldagen zijn veranderd: als verouderd markeren, het scherm haalt ze bij openen opnieuw op.
        const { error: fout } = await supabase.from('rva_regels').update({ gelezen_at: null })
          .eq('klant_id', klantId).eq('depot', o.depot).eq('rit', o.rit).in('weekdag', o.parameters?.naar ?? [])
        if (fout) log.warn(`doeldagen niet als verouderd gemarkeerd: ${fout.message}`)
        return await klaarMet(melding, { naar: o.parameters?.naar })
      }

      if (soort === 'revisie_terug') {
        await r.revisieTerug(page, m, o.rit, o.weekdag, o.parameters?.gemaaktOp, { echt, log, meld: (stap, voortgang) => opStap({ stap, voortgang }) })
        const regels = await naLezen(page)
        return await klaarMet('Revisie teruggezet in RVA', { regels }, regels ?? 0)
      }

      if (soort === 'verantwoordelijken') {
        await opStap({ stap: 'Ritverantwoordelijken opslaan', voortgang: 50 })
        const gekozen = await r.zetVerantwoordelijkenVeilig(page, m, o.rit, o.weekdag, o.parameters?.namen ?? [], { echt })
        const { error: fout } = await supabase.from('rva_ritten').update({ verantwoordelijken: gekozen })
          .eq('klant_id', klantId).eq('depot', o.depot).eq('naam', o.rit)
        if (fout) log.warn(`rva_ritten niet bijgewerkt: ${fout.message}`)
        return await klaarMet('Ritverantwoordelijken opgeslagen in RVA', { verantwoordelijken: gekozen.length })
      }

      // wijzigen. Een regel kan als sleutel of als object (postcode, straat, van, tm, evenOneven) komen.
      const handelingen = (o.handelingen ?? []).map(h => ({ ...h, regel: typeof h.regel === 'string' ? h.regel : r.regelSleutel(h.regel ?? {}) }))
      const uit = await r.voerUit(page, m, { rit: o.rit, dag: o.weekdag, handelingen }, { echt, log, opStap })
      const regels = echt ? await naLezen(page) : null
      const melding = (echt ? 'Opgeslagen in RVA' : 'Proefstand: alles gecontroleerd, niets opgeslagen (RVA_ECHT staat niet aan)')
        + (uit.rechtenToegevoegd ? '. Het account is eerst als ritverantwoordelijke toegevoegd.' : '')
      return await klaarMet(melding, { opgeslagen: uit.opgeslagen, stappen: uit.stappen, regels: regels ?? uit.na.length, rechtenToegevoegd: uit.rechtenToegevoegd === true }, uit.na.length)
    } catch (err) {
      const reden = `${err.soort ? `[${err.soort}] ` : ''}${String(err.message).split('\n')[0]}`.slice(0, 500)
      await zetRva(ctx, id, { status: 'mislukt', klaar_at: new Date().toISOString(), stap: null, melding: reden, resultaat: { stappen: err.stappen ?? [] } })
        .catch(e => sessie.log.error(`${label}: opdracht ${id} niet op mislukt gezet: ${e.message}`))
      // Een fout op het RVA-scherm (time-out, venster bleef open) is geen sessieprobleem: alleen het
      // RVA-tabblad opnieuw laden en door met de volgende opdracht. Gooien zou de hele sessie (ook
      // OOM PD) sluiten en opnieuw inloggen; op 04-11 gaven 8 time-outs zo 4 logins en 10 min pauze.
      // Lukt het herladen niet (browser weg, database), dan wel gooien voor het herstel.
      if (!err.database && r && await herstelRvaTab(sessie, r)) {
        log.warn(`${soort} mislukt, RVA-tabblad herladen: ${reden.slice(0, 160)}`)
        return {
          dag: klaar, bewaren: true, melding: `${o.rit} ${o.weekdag}: ${soort} mislukt (${reden.slice(0, 120)})`,
          run: { worker: 'postnl-rva', status: 'mislukt', depots_mislukt: [{ depot: sessie.depot.naam, fout: reden.slice(0, 300) }], foutmelding: reden },
        }
      }
      throw Object.assign(err, { dag: klaar, bewaren: true })
    }
  },

  // Het RVA-tabblad levend houden (matransport#569): het Rittenoverzicht verversen. Was de sessie
  // verlopen, dan is er in dat tabblad opnieuw ingelogd: een meting van de levensduur (gebeurtenis).
  async rvaWakker(ctx, dag) {
    const { sessie, nu } = ctx
    const verder = { ...dag, rva: { ...(dag.rva ?? {}), wakkerOm: nu.toISOString() } }
    try {
      const r = await rva.laad()
      const { page, ingelogd } = await rvaKlaar(sessie, r)
      if (r.leesRitten && ctx.supabase) {
        // Meteen het Rittenoverzicht naar rva_ritten (matransport#573): welke ritten er zijn, met
        // nummer, dagen, slotjes en verantwoordelijken. Mislukt dat, dan blijft het tabblad toch wakker.
        const rijen = await r.leesRitten(page, volgMendix(page))
        await schrijfRitten(ctx, r, rijen).catch(e => sessie.log.warn(`[${sessie.depot.naam}] RVA: ritten niet opgeslagen: ${e.message}`))
      } else {
        await r.naarRittenoverzicht(page, volgMendix(page))
      }
      if (!ingelogd) return { dag: verder, run: null }
      // De meting (sessie_verlopen) legt de levensmeter in sessie.js vast.
      return { dag: verder, run: null, melding: 'RVA-sessie was verlopen; opnieuw ingelogd in het RVA-tabblad' }
    } catch (err) {
      throw Object.assign(err, { dag: verder })
    }
  },

  // Plannen-tab bijwerken in de open sessie (#562): alleen verschillen, alleen ritten vóór hun
  // deadline (postnl-planner verversPlanning). Loopt er een Plannen-opdracht, dan niet ertussen.
  async plannen(ctx, dag, { soort, shifts }) {
    const { sessie, supabase, nu } = ctx
    const p = { ...(dag.plannen ?? {}), stopsOm: { ...(dag.plannen?.stopsOm ?? {}) } }
    // Altijd de tijd vastleggen, ook bij overslaan of een fout: anders meteen opnieuw.
    if (soort === 'ritten') p.rittenOm = nu.toISOString()
    else for (const s of shifts) p.stopsOm[s] = nu.toISOString()
    const verder = { ...dag, plannen: p }
    const { data: lopend, error } = await supabase.from('planning_taken').select('id')
      .eq('klant_id', ctx.klantId).in('status', ['wacht', 'bezig']).limit(1)
    if (error) throw Object.assign(new Error(`Plannen-opdrachten niet gelezen: ${error.message}`), { database: true, dag: verder })
    if (lopend?.length) return { dag: verder, run: null }
    try {
      await openDagplanning(sessie.page, sessie.depot, { log: sessie.log })
      const { verversPlanning } = await planner.laad()
      const uit = await verversPlanning(sessie.page, volgMendix(sessie.page), { depot: sessie.depot.naam, datum: dag.datum, soort, shifts, nu })
      sessie.lezingen++
      const tel = (t) => (t ? t.nieuw + t.gewijzigd + t.weg : 0)
      const tekst = (naam, t) => (tel(t) ? `${naam} ${t.nieuw} nieuw, ${t.gewijzigd} gewijzigd, ${t.weg} weg` : null)
      const delen = [tekst('ritten', uit.ritten), tekst('stops', uit.stops)].filter(Boolean)
      return { dag: verder, run: null, ...(delen.length ? { melding: `shift ${shifts.join(', ')}: ${delen.join('; ')}` } : {}) }
    } catch (err) {
      throw Object.assign(err, { dag: verder })
    }
  },

  // Sessie levend houden (taak 'wakker'). naarDepot logt in hetzelfde tabblad opnieuw in als de
  // sessie verlopen bleek: dat is een meting van de levensduur in stille tijd (gebeurtenis).
  async wakker(ctx, dag) {
    const { sessie } = ctx
    // Eindigen op de Dagplanning: eindigt een taak op de startpagina, dan telt dat als eruit gegooid
    // (proef 03-11 01:32: elke wakker-ronde 'gegooid').
    const { ingelogd } = await openDagplanning(sessie.page, sessie.depot, { log: sessie.log })
    if (!ingelogd) return { dag, run: null }
    // De meting (sessie_verlopen) legt de levensmeter in sessie.js vast.
    return { dag, run: null, melding: 'sessie was verlopen in stille tijd; opnieuw ingelogd in hetzelfde tabblad' }
  },

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
    const { ritten, perShift } = await leesDag(sessie, dag.datum, keuze)
    for (const [shift, s] of Object.entries(perShift)) {
      const vanShift = ritten.filter(r => hoortBijShift(r, shift))
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
      .filter(x => (!x.datum || x.datum === dag.datum) && hoortBijShift(x, shift))
    const geautoriseerd = ritten.length > 0 && ritten.every(x => x.geautoriseerd === true)
    // Geen deadline bij de ochtendlezing (03-11: Den Hoorn shift 01)? Dan nu vastleggen.
    const metDeadline = !dag.shifts?.[shift]?.deadline && r.deadline
      ? { ...dag, shifts: { ...dag.shifts, [shift]: { ...dag.shifts[shift], deadline: r.deadline } } } : dag
    const besluit = naDefinitief(metDeadline, shift, { nu, geautoriseerd, cfg: ctx.cfg })
    if (!besluit.schrijven) return { dag: besluit.dag, run: null, melding: `shift ${shift} nog niet geautoriseerd (${ritten.length} ritten)` }
    const uit = await schrijf(ctx, ritten, dag.datum)
    sessie.lezingen++
    return {
      dag: besluit.dag,
      run: { worker: 'postnl-dagplanning', status: 'ok', depots_ok: 1, rijen_gelezen: ritten.length,
        lezingen: { [ctx.depot.naam]: { soort: besluit.naVangnet ? 'na_autorisatie' : 'definitief', shift, vangnet: besluit.vangnet, geautoriseerd, deadline: r.deadline, bijgewerkt: uit.bijgewerkt, nieuw: uit.nieuw } } },
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
