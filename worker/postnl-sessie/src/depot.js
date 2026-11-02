// De lus van één depot (floatops/matransport#562): kiezen, uitvoeren, controleren, herstellen,
// opslaan, en het slot vasthouden. Alles wat met de buitenwereld praat komt binnen via `deps`,
// zodat de lus met nep-onderdelen te testen is (test/depot.test.mjs).
import { kies } from './rij.js'
import { classificeer, herstel } from './gezondheid.js'
import { voorDatum, voegAanvraagToe, aanvraagKlaar } from './dagstatus.js'
import { moetVernieuwen } from './levensduur.js'
import { vandaagNl } from '../../credentials-shared/src/postnl/tekst.js'
import { SEL_PLANNING, opStartpagina } from '../../credentials-shared/src/postnl/login.js'

const MIN = 60_000
const POLL_MS = 15_000   // zo vaak kijken of er een planner-opdracht is, ook als er niets te doen is

export function slotSleutel(klantId, depotNaam) { return `${klantId}:${depotNaam}` }

// Taak uitvoeren met een tijdslimiet. Een vastgelopen Playwright-aanroep gooit dan een fout in
// plaats van de lus voor altijd stil te zetten.
export async function metLimiet(belofte, ms, naam) {
  let t
  const limiet = new Promise((_, nee) => { t = setTimeout(() => nee(Object.assign(new Error(`Taak ${naam} duurde langer dan ${Math.round(ms / 1000)} s`), { limiet: true })), ms) })
  try { return await Promise.race([belofte, limiet]) } finally { clearTimeout(t) }
}

export async function draaiDepot(deps) {
  const { depot, klantId, cfg, opslag, maakSessie, handlers, klok, log, stop, houder, melden, telRitmonitor, naRun } = deps
  const sleutel = slotSleutel(klantId, depot.naam)
  const label = `[${depot.naam}]`
  let dag = voorDatum(await opslag.dagstatus(depot.naam), vandaagNl(klok.nu()))
  let sessie = null
  const recent = []
  const logins = []
  let laatsteVoortgang = klok.nu()

  // Het slot: wachten tot het vrij is (een vangnet-script kan nog bezig zijn), nooit ertussen.
  async function slotHouden() {
    const begin = klok.nu()
    let gemeld = false
    for (;;) {
      if (await opslag.slotPak(sleutel, houder, cfg.slotLeaseSec)) return true
      if (!gemeld) { log.log(`${label} Sessie-slot bezet door een ander proces — wachten`); gemeld = true }
      if (klok.nu() - begin > cfg.slotWachtMaxMin * MIN) {
        await melden({ soort: 'slot_lang_bezet', depot: depot.naam, detail: `Sessie-slot al ${cfg.slotWachtMaxMin} min bezet; de sessiehouder wacht verder` })
      }
      if (stop()) return false
      await klok.slaap(5_000)
    }
  }

  async function sluit(reden, extra) {
    if (!sessie) return
    const s = sessie
    sessie = null
    await s.sluiten(reden, extra).catch(e => log.error(`${label} Sessie sluiten mislukt: ${e.message}`))
  }

  async function nieuweSessie() {
    const s = maakSessie(depot)
    logins.push(klok.nu())
    await s.openen()
    sessie = s
    return s
  }

  async function bewaar() {
    try { await opslag.bewaarDagstatus(depot.naam, dag) } catch (e) { log.error(`${label} ${e.message}`) }
  }

  if (!(await slotHouden())) return { reden: 'stop' }

  try {
    while (!stop()) {
      const nu = klok.nu()
      laatsteVoortgang = nu
      const datum = vandaagNl(nu)
      if (dag.datum !== datum) { dag = voorDatum(dag, datum); await bewaar() }

      // Planner-opdrachten (Plannen, #557) uit de database in de rij zetten / eruit halen.
      const opdrachten = await opslag.plannerOpdrachten(depot.naam)
      if (opdrachten) {
        for (const o of opdrachten) dag = voegAanvraagToe(dag, { id: o.id, soort: 'planner', depot: depot.naam })
        for (const a of dag.aanvragen.filter(a => a.soort === 'planner')) if (!opdrachten.some(o => o.id === a.id)) dag = aanvraagKlaar(dag, a.id)
      }

      // Slot verlengen bij elke ronde: de lus leeft. Kwijt (lease verlopen, bv. na een lange
      // hapering)? Dan eerst de sessie dicht en opnieuw wachten, nooit verder zonder slot.
      if (!(await opslag.slotPak(sleutel, houder, cfg.slotLeaseSec))) {
        await sluit('slot_kwijt')
        await melden({ soort: 'slot_kwijt', depot: depot.naam })
        if (!(await slotHouden())) break
        continue
      }

      const k = kies(dag, nu, cfg)
      // Vandaag niets meer te doen (na de eindtijd, of een rustdag zonder opdrachten): stoppen.
      // De cronjob start het proces morgen opnieuw; een late planner-opdracht pakt het
      // planner-script zelf op.
      if (!k.taak && !k.wachtTot) { await sluit('nacht'); break }
      if (!k.taak) {
        if (sessie && !k.sessieNodig) await sluit('leeg')
        const wacht = k.wachtTot ? Math.min(k.wachtTot - nu, POLL_MS) : POLL_MS
        await klok.slaap(Math.max(1_000, wacht))
        continue
      }

      // Planner: in stap 1 voert het planner-script de opdracht zelf uit. De sessiehouder sluit
      // zijn sessie, geeft het slot vrij en wacht tot de opdracht klaar is (nooit tegelijk ingelogd).
      if (k.taak.naam === 'planner') {
        await sluit('voor_planner')
        await opslag.slotLos(sleutel, houder)
        log.log(`${label} Planner-opdracht: sessie dicht, slot vrij voor het planner-script`)
        const begin = klok.nu()
        for (;;) {
          await klok.slaap(10_000)
          const open = await opslag.plannerOpdrachten(depot.naam)
          if (open && open.length === 0) break
          if (klok.nu() - begin > cfg.taakLimietSec.planner * 1000) { await melden({ soort: 'planner_lang', depot: depot.naam }); break }
          if (stop()) break
        }
        dag = aanvraagKlaar(dag, k.args.id)
        if (!(await slotHouden())) break
        continue
      }

      const taak = k.taak.naam
      let uitkomst = null
      let fout = null
      try {
        if (!sessie) await nieuweSessie()
        // Vóór schrijvend werk: een verse sessie als de oude dicht bij haar gemeten einde zit.
        if (k.taak.schrijft && moetVernieuwen({ leeftijdMin: sessie.leeftijdMin, schattingMin: deps.schatting(), margeMin: cfg.levensduurMargeMin })) {
          await sluit('vernieuwd_voor_schrijven')
          await nieuweSessie()
        }
        await sessie.taakBegin(taak)
        uitkomst = await metLimiet(handlers[taak]({ ...deps.ctx, sessie, nu, cfg }, dag, k.args), (cfg.taakLimietSec[taak] ?? 300) * 1000, taak)
      } catch (err) {
        fout = err
      }

      // Hoe staat de sessie ervoor, ook na een geslaagde taak?
      const page = sessie?.page
      const planningZichtbaar = page ? await page.locator(SEL_PLANNING).first().isVisible().catch(() => false) : null
      // Elke taak eindigt op zijn eigen scherm. Staat de pagina dan op de startpagina, dan heeft
      // PostNL de sessie teruggezet (een andere sessie werkt met dezelfde login).
      const startpagina = page ? await (deps.opStartpagina ?? opStartpagina)(page) : false
      const soort = !sessie ? (fout ? classificeer({ fout }) : 'gezond')
        : classificeer({ url: page?.url?.() ?? '', depotHost: sessie.depotHost, fout, planningZichtbaar: fout ? planningZichtbaar : null, opStartpagina: startpagina })
      const actie = herstel(soort, { recent, logins, nu: klok.nu(), cfg })
      recent.push({ soort, at: klok.nu() })
      if (recent.length > 20) recent.shift()

      const incident = soort !== 'gezond'
      const tracePad = sessie ? await sessie.taakEinde(taak, { incident }) : null
      if (incident) {
        log.warn(`${label} ${taak}: ${soort}${fout ? ` (${String(fout.message).split('\n')[0]})` : ''} → ${actie}`)
        await opslag.gebeurtenis(sessie?.id, { soort, taak, actie, fout: fout ? String(fout.message).slice(0, 300) : null, trace: tracePad })
        // Er hoort niemand anders met deze login in te loggen: altijd melden.
        if (soort === 'gegooid') await melden({ soort: 'gegooid', depot: depot.naam, detail: `tijdens ${taak}; trace ${tracePad ?? 'niet opgeslagen'}` })
      } else if (sessie && (!sessie.laatsteOkGemeld || klok.nu() - sessie.laatsteOkGemeld > 5 * MIN)) {
        sessie.laatsteOkGemeld = klok.nu()
        await opslag.sessieBij(sessie.id, { laatste_ok_at: klok.nu().toISOString(), lezingen: sessie.lezingen })
      }
      if (uitkomst?.gebeurtenis) await opslag.gebeurtenis(sessie?.id, uitkomst.gebeurtenis)

      if (uitkomst) {
        dag = uitkomst.dag
        await bewaar()
        if (uitkomst.run) await naRun({ ...uitkomst.run, trace: tracePad })
        if (uitkomst.ritmonitor) telRitmonitor(depot.naam, { ok: true, ...uitkomst.ritmonitor })
        if (uitkomst.melding === 'autorisatie_niet_gezien') await melden({ soort: 'autorisatie_niet_gezien', depot: depot.naam, detail: uitkomst.gebeurtenis?.shift })
      } else if (fout) {
        if (taak === 'ritmonitor') telRitmonitor(depot.naam, { ok: false, fout: fout.message })
        else await naRun({ worker: k.taak.worker, status: 'mislukt', depots_mislukt: [{ depot: depot.naam, fout: String(fout.message).slice(0, 300) }], foutmelding: String(fout.message).slice(0, 500), trace: tracePad })
      }

      // Na elk incident even ademen: geen strakke lus van mislukte pogingen tegen PostNL.
      if (incident) await klok.slaap(2_000)

      if (actie === 'nieuwe_login') {
        await sluit(soort, { fout, uitkomst: soort === 'blokkade' ? 'blokkade' : undefined })
      } else if (actie === 'pauze') {
        await sluit(soort, { fout })
        await melden({ soort: 'te_veel_logins', depot: depot.naam, detail: `${logins.length} logins; ${cfg.pauzeMin} min pauze` })
        await klok.slaap(cfg.pauzeMin * MIN)
      } else if (actie === 'opnieuw_openen' && sessie) {
        // Bij de volgende taak opent de handler het scherm opnieuw; niets extra nodig.
      } else if (soort === 'database') {
        await klok.slaap(10_000)
      }

      // Videosegment of browser vernieuwen (alleen tussen taken).
      if (sessie && cfg.contextWissel && Date.now() - sessie.segmentOm >= cfg.segmentMin * MIN) {
        const nogIngelogd = await sessie.nieuwSegment()
        if (!nogIngelogd) await opslag.gebeurtenis(sessie.id, { soort: 'contextwissel_nieuwe_login' })
      } else if (sessie && sessie.leeftijdMin >= cfg.browserVernieuwenUur * 60) {
        await sluit('vernieuwd')
      }
    }
  } finally {
    await sluit(stop() ? 'herstart' : 'nacht')
    await bewaar()
    await opslag.slotLos(sleutel, houder)
  }
  return { reden: 'stop', laatsteVoortgang }
}
