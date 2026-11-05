// De lus van één depot (floatops/matransport#562): kiezen, uitvoeren, controleren, herstellen,
// opslaan, en het slot vasthouden. Alles wat met de buitenwereld praat komt binnen via `deps`,
// zodat de lus met nep-onderdelen te testen is (test/depot.test.mjs).
import { kies } from './rij.js'
import { TAKEN } from './taken.js'
import { classificeer, herstel } from './gezondheid.js'
import { naTaak, remTaken } from './taakrem.js'
import { voorDatum, voegAanvraagToe, aanvraagKlaar } from './dagstatus.js'
import { moetVernieuwen } from './levensduur.js'
import { vandaagNl } from '../../credentials-shared/src/postnl/tekst.js'
import { SEL_PLANNING, opStartpagina } from '../../credentials-shared/src/postnl/login.js'

const MIN = 60_000
const POLL_MS = 15_000   // vangnet: zo vaak kijken of er een planner-opdracht is (de wekker is meteen)

export function slotSleutel(klantId, depotNaam) { return `${klantId}:${depotNaam}` }

// Taak uitvoeren met een tijdslimiet. Een vastgelopen Playwright-aanroep gooit dan een fout in
// plaats van de lus voor altijd stil te zetten. `afbreken` (optioneel): een belofte die afwijst als
// de taak meteen moet stoppen (het sessie-slot is kwijt).
export async function metLimiet(belofte, ms, naam, afbreken = null) {
  let t
  const limiet = new Promise((_, nee) => { t = setTimeout(() => nee(Object.assign(new Error(`Taak ${naam} duurde langer dan ${Math.round(ms / 1000)} s`), { limiet: true })), ms) })
  try { return await Promise.race([belofte, limiet, ...(afbreken ? [afbreken] : [])]) } finally { clearTimeout(t) }
}

// Hartslag van het sessie-slot (matransport#598). Het slot is een lease van `slotLeaseSec` (180 s).
// Tot 05-11 werd het alleen tussen twee taken verlengd, terwijl een taak 300–1500 s mag duren en de
// pauze na te veel logins 10 min is: het slot verliep dan, en de losse scripts logden zelf in
// (Waddinxveen 05-11: 7 extra logins). Nu verlengt een hartslag het elke `slotHartslagSec`, ook
// tijdens een taak en een pauze, maar alleen zolang de lus binnen zijn eigen grens zit
// (`levendTot`). Loopt de lus vast buiten elke tijdslimiet om, dan stopt de hartslag vanzelf en
// verloopt het slot zoals vroeger: het vangnet neemt dan binnen 3 min over.
// `elke(ms, fn)` geeft een stopfunctie (in de tests een nep-klok). Geeft { stop, kwijt }:
// `kwijt` wijst af zodra het verlengen mislukt omdat een ander het slot heeft.
export function startHartslag({ elke, ms, verleng, levend, log = console }) {
  let nee
  const kwijt = new Promise((_, n) => { nee = n })
  kwijt.catch(() => {})
  let bezig = false
  let weg = false
  const stop = elke(ms, async () => {
    if (bezig || weg || !levend()) return
    bezig = true
    try {
      if (!(await verleng())) {
        weg = true
        nee(Object.assign(new Error('Sessie-slot kwijt tijdens de taak'), { slotKwijt: true }))
      }
    } catch (e) {
      // Databasehapering: de volgende slag probeert opnieuw; de lease geeft twee kansen.
      log.warn?.(`Sessie-slot verlengen mislukt (volgende slag opnieuw): ${e.message}`)
    } finally { bezig = false }
  })
  return { stop, kwijt, get weg() { return weg } }
}

// Een `elke` met echte timers (de productieklok geeft er zelf een mee).
const elkeEcht = (ms, fn) => { const t = setInterval(fn, ms); return () => clearInterval(t) }

// Het uurtotaal van fouten 460 voor de melding `sessie_ingetrokken`.
export function herloginsLaatsteUur(tijden, nuMs) {
  return tijden.filter(t => nuMs - t <= 60 * 60_000)
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
  let laatsteGegooidMelding = null
  let laatsteIngetrokkenMelding = null
  let rem = {}   // fouten per taak (taakrem.js)

  // Hartslag: alleen zolang de lus binnen zijn eigen grens zit (zie startHartslag).
  // `klok.tijd` (zonder bijwerking): de productieklok telt elke klok.nu() als voortgang voor de
  // waakhond (index.js). De hartslag mag die niet aanroepen, anders ziet de waakhond een
  // vastgelopen lus nooit meer.
  const tijd = klok.tijd ?? (() => klok.nu().getTime())
  let levendTot = 0
  const levend = (ms) => { levendTot = klok.nu().getTime() + ms + 60_000 }
  let hartslag = null
  function hartslagAan() {
    hartslag?.stop()
    levend(cfg.slotLeaseSec * 1000)
    hartslag = startHartslag({
      elke: klok.elke ?? elkeEcht, ms: cfg.slotHartslagSec * 1000, log,
      verleng: () => opslag.slotPak(sleutel, houder, cfg.slotLeaseSec),
      levend: () => tijd() < levendTot,
    })
  }
  function hartslagUit() { hartslag?.stop(); hartslag = null }

  // Het slot: wachten tot het vrij is (een vangnet-script kan nog bezig zijn), nooit ertussen.
  async function slotHouden() {
    hartslagUit()
    const begin = klok.nu()
    let gemeld = false
    for (;;) {
      if (await opslag.slotPak(sleutel, houder, cfg.slotLeaseSec)) {
        hartslagAan()
        // Met het slot in de hand is niemand anders met dit depot bezig: een opdracht die nog op
        // 'bezig' staat, is van een gecrasht proces (matransport#578).
        await opslag.ruimVerweesdePlannerOp?.(depot.naam)
        // Idem een sessierij zonder einde (matransport#591). Een eigen sessie is hier nooit open:
        // bij de start nog niet, na slot_kwijt al gesloten.
        await opslag.sluitVerweesdeSessiesAf?.(depot.naam)
        return true
      }
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
    log.log(`${label} Sessie dicht (${reden})`)
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
      // RVA-opdrachten (matransport#569), oudste eerst: de taak 'rva' pakt steeds de eerste.
      if (cfg.rva && opslag.rvaOpdrachten) {
        const rva = await opslag.rvaOpdrachten(depot.naam)
        if (rva) {
          for (const o of rva) dag = voegAanvraagToe(dag, { id: o.id, soort: 'rva', depot: depot.naam })
          for (const a of dag.aanvragen.filter(a => a.soort === 'rva')) if (!rva.some(o => o.id === a.id)) dag = aanvraagKlaar(dag, a.id)
          // Volgorde van de wachtrij (opslag.rvaVolgorde, matransport#573): wat iemand opslaat of in de
          // app open heeft gaat voor, ook als het later binnenkwam dan een al bekende bulk-lezing.
          const plek = new Map(rva.map((o, i) => [o.id, i]))
          const opVolgorde = dag.aanvragen.filter(a => a.soort === 'rva').sort((a, b) => (plek.get(a.id) ?? 1e9) - (plek.get(b.id) ?? 1e9))
          let j = 0
          dag = { ...dag, aanvragen: dag.aanvragen.map(a => (a.soort === 'rva' ? opVolgorde[j++] : a)) }
        }
      }

      // Wie heeft Plannen open voor dit depot? Die shift krijgt de stops vaker (taak 'plannen').
      if (cfg.plannenVerversen && opslag.plannenKijkers) dag = { ...dag, plannenKijkers: await opslag.plannenKijkers(depot.naam, dag.datum) }

      // Slot verlengen bij elke ronde: de lus leeft. Kwijt (lease verlopen, bv. na een lange
      // hapering)? Dan eerst de sessie dicht en opnieuw wachten, nooit verder zonder slot.
      if (hartslag?.weg || !(await opslag.slotPak(sleutel, houder, cfg.slotLeaseSec))) {
        // Wie heeft het nu? Op 05-11 was de melding leeg en moest dat uit proxy_gebruik_log (#599).
        const ander = await opslag.slotHouder?.(sleutel).catch(() => null)
        log.warn(`${label} Sessie-slot kwijt, nu van ${ander ?? 'niemand (verlopen)'}`)
        await sluit('slot_kwijt')
        await melden({ soort: 'slot_kwijt', depot: depot.naam, detail: `nu van ${ander ?? 'niemand (verlopen)'}` })
        if (!(await slotHouden())) break
        continue
      }
      levend(POLL_MS)

      // Een taak die steeds mislukt, wacht steeds langer (taakrem.js); de rest gaat gewoon door.
      const k = kies(dag, nu, cfg, remTaken(deps.taken ?? TAKEN, rem, nu))
      // Vandaag niets meer te doen (na de eindtijd, of een rustdag zonder opdrachten): stoppen.
      // De cronjob start het proces morgen opnieuw; een late planner-opdracht pakt het
      // planner-script zelf op.
      if (!k.taak && !k.wachtTot) { await sluit('nacht'); break }
      if (!k.taak) {
        if (sessie && !k.sessieNodig) await sluit('leeg')
        const wacht = k.wachtTot ? Math.min(k.wachtTot - nu, POLL_MS) : POLL_MS
        levend(wacht)
        // Wekbaar: een planner-opdracht (wekker van de VPS) breekt dit wachten meteen af.
        await (klok.wekbaar ?? klok.slaap)(Math.max(1_000, wacht))
        continue
      }

      const taak = k.taak.naam
      const limietMs = (cfg.taakLimietSec[taak] ?? 300) * 1000
      let uitkomst = null
      let fout = null
      try {
        // Inloggen (tot 90 s naar het depot, plus de login zelf) valt ook binnen de hartslag.
        levend(limietMs + 180_000)
        if (!sessie) await nieuweSessie()
        // Vóór schrijvend werk: een verse sessie als de oude dicht bij haar gemeten einde zit.
        if (k.taak.schrijft && moetVernieuwen({ leeftijdMin: sessie.leeftijdMin, schattingMin: deps.schatting(), margeMin: cfg.levensduurMargeMin })) {
          await sluit('vernieuwd_voor_schrijven')
          await nieuweSessie()
        }
        await sessie.taakBegin(taak)
        levend(limietMs)
        uitkomst = await metLimiet(handlers[taak]({ ...deps.ctx, sessie, nu, cfg }, dag, k.args), limietMs, taak, hartslag?.kwijt)
      } catch (err) {
        fout = err
      }

      // Slot kwijt tijdens de taak (een ander heeft het nu): niets beoordelen, meteen dicht en
      // opnieuw wachten. Bovenaan de lus gebeurt dat (sluit + melding slot_kwijt).
      if (fout?.slotKwijt) {
        await sessie?.taakEinde(taak, { incident: true, tab: k.taak.tab ?? 'oompd' }).catch(() => null)
        continue
      }

      // Hoe staat de sessie ervoor, ook na een geslaagde taak? Een RVA-taak laat het OOM PD-tabblad
      // ongemoeid (dat kan na een verse login nog op de startpagina staan): dan het RVA-tabblad
      // beoordelen, alleen op loginpagina/crash/fout, niet op de OOM PD-startpagina.
      const rvaTaak = k.taak.tab === 'rva'
      const page = rvaTaak ? sessie?.rvaPage : sessie?.page
      const planningZichtbaar = page && !rvaTaak ? await page.locator(SEL_PLANNING).first().isVisible().catch(() => false) : null
      // Elke taak eindigt op zijn eigen scherm. Staat de pagina dan op de startpagina, dan heeft
      // PostNL de sessie teruggezet (een andere sessie werkt met dezelfde login).
      // Twee keer kijken, 2 s ertussen: tijdens het openen van een scherm staat de startpagina er
      // nog even. Op 05-11 08:30–08:46 gaf één keer kijken zo 7 valse "gegooid" en 2 onnodige
      // logins (matransport#598).
      const kijkStart = deps.opStartpagina ?? opStartpagina
      let startpagina = page && !rvaTaak ? await kijkStart(page) : false
      if (startpagina) {
        await klok.slaap(2_000)
        startpagina = await kijkStart(page)
      }
      const herlogin = rvaTaak ? 0 : (sessie?.herloginTaak ?? 0)
      const soort = !sessie ? (fout ? classificeer({ fout }) : 'gezond')
        : classificeer({ url: page?.url?.() ?? '', depotHost: rvaTaak ? null : sessie.depotHost, fout, planningZichtbaar: fout ? planningZichtbaar : null, opStartpagina: startpagina, herlogin })
      let actie = herstel(soort, { recent, logins, nu: klok.nu(), cfg })
      recent.push({ soort, at: klok.nu() })
      if (recent.length > 20) recent.shift()

      // Per taak tellen (taakrem.js): ook als andere taken tussendoor lukken.
      const perTaak = naTaak(rem, { taak, opAanvraag: k.taak.opAanvraag, soort, fout, nu: klok.nu(), cfg })
      rem = perTaak.stand
      if (perTaak.nieuweLogin && actie === 'opnieuw_openen') {
        actie = logins.filter(t => klok.nu() - t <= 60 * MIN).length >= cfg.maxLoginsPerUur ? 'pauze' : 'nieuwe_login'
      }
      if (perTaak.melding) await melden({ ...perTaak.melding, depot: depot.naam })

      // PostNL trekt de sessie vaak in (fout 460): iemand anders gebruikt waarschijnlijk deze login.
      // Hoogstens één melding per uur, met het aantal; de gebeurtenis telt mee voor de levensmeter.
      if (sessie?.fouten460?.length) {
        sessie.fouten460 = herloginsLaatsteUur(sessie.fouten460, klok.nu().getTime())
        const n = sessie.fouten460.length
        if (n >= cfg.herloginMeldenPerUur && (!laatsteIngetrokkenMelding || klok.nu() - laatsteIngetrokkenMelding >= 60 * MIN)) {
          laatsteIngetrokkenMelding = klok.nu()
          await opslag.gebeurtenis(sessie.id, { soort: 'sessie_ingetrokken', aantal: n })
          await melden({ soort: 'sessie_ingetrokken', depot: depot.naam, detail: `PostNL trok de sessie ${n}x in het afgelopen uur in (fout 460) en logde stil opnieuw in. Gebruikt iemand anders deze login in een browser?` })
        }
      }

      const incident = soort !== 'gezond'
      // Elke taak behalve de ritmonitor (elke minuut, die staat samengevat in de run-log) in het log.
      if (!incident && !fout && taak !== 'ritmonitor' && (!['wakker', 'plannen', 'rvaWakker', 'rvaBijlezen'].includes(taak) || uitkomst?.melding)) {
        const l = uitkomst?.run?.lezingen?.[depot.naam]
        log.log(`${label} ${taak} klaar${uitkomst?.melding ? `: ${uitkomst.melding}` : ''}${l ? ` (${l.nieuw ?? 0} nieuw, ${l.bijgewerkt ?? 0} bijgewerkt)` : ''}`)
      }
      // Een doorvoer (planner) wijzigt PostNL: trace en video altijd 30 dagen bewaren (fout/).
      const tracePad = sessie ? await sessie.taakEinde(taak, { incident: incident || Boolean(uitkomst?.bewaren || fout?.bewaren), tab: k.taak.tab ?? 'oompd' }) : null
      if (incident) {
        log.warn(`${label} ${taak}: ${soort}${fout ? ` (${String(fout.message).split('\n')[0]})` : ''} → ${actie}`)
        const herloginsUur = sessie?.fouten460?.length ?? 0
        await opslag.gebeurtenis(sessie?.id, { soort, taak, actie, fout: fout ? String(fout.message).slice(0, 300) : null, trace: tracePad, ...(herloginsUur ? { herlogins: herloginsUur } : {}) })
        // Er hoort niemand anders met deze login in te loggen: altijd melden.
        // Hoogstens eens per 30 min een melding (03-11: 69 meldingen op één dag); de gebeurtenis
        // staat er altijd.
        if (soort === 'gegooid' && (!laatsteGegooidMelding || klok.nu() - laatsteGegooidMelding >= 30 * MIN)) {
          laatsteGegooidMelding = klok.nu()
          await melden({ soort: 'gegooid', depot: depot.naam, detail: `tijdens ${taak}; trace ${tracePad ?? 'niet opgeslagen'}` })
        }
      } else if (sessie && (!sessie.laatsteOkGemeld || klok.nu() - sessie.laatsteOkGemeld > 5 * MIN)) {
        sessie.laatsteOkGemeld = klok.nu()
        await opslag.sessieBij(sessie.id, { laatste_ok_at: klok.nu().toISOString(), lezingen: sessie.lezingen })
      }
      const g = uitkomst?.gebeurtenis ?? fout?.gebeurtenis
      if (g) await opslag.gebeurtenis(sessie?.id, { ...g, trace: tracePad })
      // De planner schrijft zijn eigen run-log; daar komt het pad van de trace (VPS) bij.
      const plannerRun = uitkomst?.plannerRun ?? fout?.plannerRun
      if (plannerRun && tracePad) await opslag.runOpnames(plannerRun, [{ soort: 'trace', storage_path: tracePad }])

      if (uitkomst) {
        // laatsteTaakOm: wanneer er voor het laatst iets in PostNL gebeurde (taak 'wakker').
        dag = { ...uitkomst.dag, laatsteTaakOm: klok.nu().toISOString() }
        await bewaar()
        if (uitkomst.run) await naRun({ ...uitkomst.run, trace: tracePad })
        if (uitkomst.ritmonitor) telRitmonitor(depot.naam, { ok: true, ...uitkomst.ritmonitor })
        if (uitkomst.melding === 'autorisatie_niet_gezien') await melden({ soort: 'autorisatie_niet_gezien', depot: depot.naam, detail: uitkomst.gebeurtenis?.shift })
      } else if (fout) {
        // Een taak die bij een fout zijn eigen volgende tijd meegeeft (plannen): niet meteen opnieuw.
        if (fout.dag) { dag = fout.dag; await bewaar() }
        if (taak === 'ritmonitor') telRitmonitor(depot.naam, { ok: false, fout: fout.message })
        else if (!fout.alGelogd && k.taak.worker) await naRun({ worker: k.taak.worker, status: 'mislukt', depots_mislukt: [{ depot: depot.naam, fout: String(fout.message).slice(0, 300) }], foutmelding: String(fout.message).slice(0, 500), trace: tracePad })
      }

      // Na elk incident even ademen: geen strakke lus van mislukte pogingen tegen PostNL.
      if (incident) await klok.slaap(2_000)

      if (actie === 'nieuwe_login') {
        await sluit(soort, { fout, uitkomst: soort === 'blokkade' ? 'blokkade' : undefined })
      } else if (actie === 'pauze') {
        await sluit(soort, { fout })
        await melden({ soort: 'te_veel_logins', depot: depot.naam, detail: `${logins.length} logins; ${cfg.pauzeMin} min pauze` })
        // Het slot blijft van ons tijdens de pauze: anders logt het vangnet-script juist in, en dat
        // is precies het hameren dat de pauze moet voorkomen (05-11 08:56 en 09:00, #598).
        levend(cfg.pauzeMin * MIN)
        await klok.slaap(cfg.pauzeMin * MIN)
      } else if (actie === 'opnieuw_openen' && sessie) {
        // Bij de volgende taak opent de handler het scherm opnieuw; niets extra nodig.
      } else if (soort === 'database') {
        await klok.slaap(10_000)
      }

      // Videosegment of browser vernieuwen (alleen tussen taken).
      if (sessie && cfg.contextWissel && Date.now() - sessie.segmentOm >= cfg.segmentMin * MIN) {
        levend(180_000)
        const nogIngelogd = await sessie.nieuwSegment()
        if (!nogIngelogd) await opslag.gebeurtenis(sessie.id, { soort: 'contextwissel_nieuwe_login' })
      } else if (sessie && !cfg.contextWissel && sessie.leeftijdMin >= cfg.browserVernieuwenUur * 60) {
        // Alleen zonder contextwissel: met contextwissel is elk videosegment al kort, en een nieuwe
        // login om de 4 uur is dan onnodig (03-11 12:17: beide depots opnieuw ingelogd).
        await sluit('vernieuwd')
      }
    }
  } finally {
    levend(120_000)   // netjes sluiten (video opslaan) mag het slot niet kosten
    await sluit(stop() ? 'herstart' : 'nacht')
    await bewaar()
    hartslagUit()
    await opslag.slotLos(sleutel, houder)
  }
  return { reden: 'stop', laatsteVoortgang }
}
