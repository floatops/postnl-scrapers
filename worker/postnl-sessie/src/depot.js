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
import { SEL_PLANNING, opStartpagina, LOGIN_MAX_SEC } from '../../credentials-shared/src/postnl/login.js'

const MIN = 60_000
const POLL_MS = 15_000   // vangnet: zo vaak kijken of er een planner-opdracht is (de wekker is meteen)
// Eigen bron in db_fout_log (matransport#613): check_operationele_fouten dempt per bron 6 uur. Op de
// gedeelde bron postnl-sessie zou een eerdere melding van die dag deze push stil tegenhouden. De push
// toont de eerste bevinding (op bronnaam) en de eerste 100 tekens: daarom deze naam en een korte tekst.
export const PROXY_BRON = 'decodo-proxy'
// Wat de gebruiker ziet bij een opdracht die niet kon beginnen (matransport#613).
export const REDEN_PROXY = 'Niet uitgevoerd: PostNL was niet bereikbaar (de verbinding via de proxy werd geweigerd). Probeer het opnieuw zodra dit is opgelost.'
export const REDEN_LOGIN = 'Niet uitgevoerd: inloggen bij PostNL lukte steeds niet. Probeer het over een paar minuten opnieuw.'

export function slotSleutel(klantId, depotNaam) { return `${klantId}:${depotNaam}` }

// Taak uitvoeren met een tijdslimiet. Een vastgelopen Playwright-aanroep gooit dan een fout in
// plaats van de lus voor altijd stil te zetten. `afbreken` (optioneel): een belofte die afwijst als
// de taak meteen moet stoppen (het sessie-slot is kwijt).
export async function metLimiet(belofte, ms, naam, afbreken = null) {
  let t
  const limiet = new Promise((_, nee) => { t = setTimeout(() => nee(Object.assign(new Error(`Taak ${naam} duurde langer dan ${Math.round(ms / 1000)} s`), { limiet: true })), ms) })
  try { return await Promise.race([belofte, limiet, ...(afbreken ? [afbreken] : [])]) } finally { clearTimeout(t) }
}

// Wacht hooguit `ms` tot de handler klaar is. true = klaar (geslaagd of gefaald), false = hij loopt nog.
export async function handlerKlaar(lopend, slaap, ms) {
  let klaar = false
  const einde = Promise.resolve(lopend).then(() => { klaar = true }, () => { klaar = true })
  await Promise.race([einde, slaap(ms)])
  return klaar
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
  let lopend = null
  const stop = elke(ms, async () => {
    if (bezig || weg || !levend()) return
    bezig = true
    lopend = (async () => {
      try {
        if (!(await verleng())) {
          weg = true
          nee(Object.assign(new Error('Sessie-slot kwijt tijdens de taak'), { slotKwijt: true }))
        }
      } catch (e) {
        // Databasehapering: de volgende slag probeert opnieuw; de lease geeft twee kansen.
        log.warn?.(`Sessie-slot verlengen mislukt (volgende slag opnieuw): ${e.message}`)
      } finally { bezig = false; lopend = null }
    })()
    await lopend
  })
  // `klaar`: wacht op een lopende slag, zodat die het slot niet terugzet ná het vrijgeven.
  return { stop, kwijt, klaar: () => lopend ?? Promise.resolve(), get weg() { return weg } }
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
  let laatsteProxyMelding = null
  let rem = {}   // fouten per taak (taakrem.js)
  let loginFoutenAchtereen = 0   // mislukte logins van dit depot, tot er weer een sessie is (matransport#613)

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
    let langGemeldOm = null
    const wie = async () => (await opslag.slotHouder?.(sleutel).catch(() => null)) ?? 'onbekend'
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
      if (!gemeld) { log.log(`${label} Sessie-slot bezet door ${await wie()} — wachten`); gemeld = true }
      // Hoogstens één melding per uur: tot #599 kwam er na de wachttijd elke 5 s een nieuwe.
      if (klok.nu() - begin > cfg.slotWachtMaxMin * MIN && (!langGemeldOm || klok.nu() - langGemeldOm >= 60 * MIN)) {
        langGemeldOm = klok.nu()
        await melden({ soort: 'slot_lang_bezet', depot: depot.naam, detail: `Sessie-slot al ${cfg.slotWachtMaxMin} min bezet door ${await wie()}; de sessiehouder wacht verder` })
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

  // Opdrachten (planner, RVA) die niet kunnen beginnen: op mislukt met de reden en uit de rij
  // (matransport#613). Andere aanvragen (depotUrl) blijven staan.
  async function opdrachtenNietGestart(aanvragen, reden) {
    let n = 0
    for (const a of aanvragen) {
      if (a.soort !== 'planner' && a.soort !== 'rva') continue
      if (await opslag.opdrachtNietGestart?.(a.soort, a.id, reden)) {
        n++
        log.warn(`${label} ${a.soort}-opdracht ${a.id} niet uitgevoerd: ${reden}`)
      }
      dag = aanvraagKlaar(dag, a.id)
    }
    if (n) await bewaar()
    return n
  }

  // De proxy-aanbieder weigert de login (407, alle IP's; 07-11 een mislukte betaling, matransport#613).
  // Inloggen heeft dan geen zin: de sessie is al dicht. Eerst één toets, zodat een losse 407 geen alarm
  // geeft. Weigert hij echt: één melding (hoogstens elke proxyMeldenElkeMin), wachtende en nieuwe
  // opdrachten meteen niet uitgevoerd, en elke proxyToetsMin toetsen, zonder PostNL. Het slot blijft
  // van ons: de losse scripts zouden hetzelfde zien. Elke POLL_MS een ronde, dus stoppen (noodknop,
  // nieuwe code), een gemiste wekker en de waakhond werken gewoon. Getoetst wordt de proxy die een
  // login nu zou krijgen: na een herstel kunnen poorten of login anders zijn.
  async function wachtOpProxy(proxy, fout) {
    const begin = klok.nu()
    const toets = async () => {
      const huidig = await Promise.resolve().then(() => deps.huidigeProxy?.()).catch((e) => { log.warn(`${label} ${e.message}`); return null })
      return deps.toetsProxy(huidig ?? proxy)
    }
    // Alleen een antwoord dat geen 407 is: een time-out zegt niet dat de proxy weer werkt.
    const werkt = (t) => t.status != null && !t.geweigerd
    const meld = async () => {
      if (laatsteProxyMelding && klok.nu() - laatsteProxyMelding < cfg.proxyMeldenElkeMin * MIN) return
      laatsteProxyMelding = klok.nu()
      const sinds = Math.round((klok.nu() - begin) / MIN)
      await melden({ soort: 'proxy_geweigerd', bron: PROXY_BRON, depot: depot.naam, detail: `Decodo weigert de login (407), kijk de betaling na. Geldt voor alle IP's${sinds ? `, al ${sinds} min` : ''}; geen PostNL-login tot de proxy weer werkt (toets elke ${cfg.proxyToetsMin} min). Fout: ${String(fout?.message ?? '').split('\n')[0].slice(0, 160)}` })
    }
    let t = await toets()
    // Alleen onder de loginrem: herstel() kijkt daar bij proxy_wacht niet naar. Blijft Chromium 407
    // krijgen terwijl de toets lukt (flappende aanbieder), dan zou dit zonder rem blijven inloggen.
    const inLaatsteUur = logins.filter(x => klok.nu() - x <= 60 * MIN).length
    if (werkt(t) && inLaatsteUur < cfg.maxLoginsPerUur) {
      log.warn(`${label} Losse 407: de proxy werkt (toets: ${t.status}); gewoon verder`)
      return
    }
    await meld()
    await opdrachtenNietGestart(dag.aanvragen ?? [], REDEN_PROXY)
    let laatsteToets = klok.nu()
    while (!stop() && !hartslag?.weg) {
      levend(POLL_MS)
      deps.bezig?.set(depot.naam, { taak: 'wachten op de proxy', fase: 'afhandeling', sinds: begin })
      // Wekbaar: een nieuwe opdracht krijgt meteen antwoord, niet pas bij de volgende ronde.
      await (klok.wekbaar ?? klok.slaap)(POLL_MS)
      if (stop() || hartslag?.weg) break
      const nieuwe = [
        ...((await opslag.plannerOpdrachten(depot.naam)) ?? []).map(o => ({ id: o.id, soort: 'planner' })),
        ...(cfg.rva && opslag.rvaOpdrachten ? ((await opslag.rvaOpdrachten(depot.naam)) ?? []).map(o => ({ id: o.id, soort: 'rva' })) : []),
      ]
      if (nieuwe.length) await opdrachtenNietGestart(nieuwe, REDEN_PROXY)
      if (klok.nu() - laatsteToets < cfg.proxyToetsMin * MIN) continue
      laatsteToets = klok.nu()
      t = await toets()
      if (werkt(t)) {
        const min = Math.round((klok.nu() - begin) / MIN)
        log.log(`${label} Proxy werkt weer (toets: ${t.status}) na ${min} min wachten`)
        await melden({ soort: 'proxy_hersteld', bron: PROXY_BRON, depot: depot.naam, detail: `De proxy liet de verbinding weer toe (toets: ${t.status}) na ${min} min; de sessiehouder logt weer in` })
        return
      }
      await meld()
    }
  }

  if (!(await slotHouden())) return { reden: 'stop' }

  try {
    while (!stop()) {
      const nu = klok.nu()
      laatsteVoortgang = nu
      deps.bezig?.delete(depot.naam)
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
      let lopend = null                       // de handler, ook als metLimiet al is teruggekomen
      const stopsein = { gestopt: false }     // ctx.gestopt(): de handler moet ophouden (over de limiet)
      // Geheugen vóór en na de taak (matransport#668): alleen meten. deps.geheugen wacht hooguit 5 s en
      // gooit nooit (index.js). Vóór het inloggen: een nieuwe browser telt mee bij deze taak (login).
      const geheugenVoor = deps.geheugen ? await deps.geheugen.meet() : null
      const taakBeginMs = tijd()
      try {
        // Inloggen valt ook binnen de hartslag: OOM PD en het RVA-tabblad, elk hooguit LOGIN_MAX_SEC.
        // Stopt de hartslag tijdens een trage login, dan logt het vangnet ertussendoor in.
        levend(limietMs + 2 * LOGIN_MAX_SEC * 1000)
        // Wat de lus nu doet, voor de melding vastgelopen. Vooral buiten de begrensde handler: daar
        // kan hij echt hangen (inloggen, trace of video opslaan, sluiten).
        deps.bezig?.set(depot.naam, { taak, fase: 'inloggen', sinds: klok.nu() })
        if (!sessie) await nieuweSessie()
        // Vóór schrijvend werk: een verse sessie als de oude dicht bij haar gemeten einde zit.
        if (k.taak.schrijft && moetVernieuwen({ leeftijdMin: sessie.leeftijdMin, schattingMin: deps.schatting(), margeMin: cfg.levensduurMargeMin })) {
          await sluit('vernieuwd_voor_schrijven')
          await nieuweSessie()
        }
        await sessie.taakBegin(taak)
        levend(limietMs)
        deps.bezig?.set(depot.naam, { taak, fase: 'taak', sinds: klok.nu() })
        lopend = handlers[taak]({ ...deps.ctx, sessie, nu, cfg, gestopt: () => stopsein.gestopt }, dag, k.args)
        uitkomst = await metLimiet(lopend, limietMs, taak, hartslag?.kwijt)
      } catch (err) {
        fout = err
      }
      deps.bezig?.set(depot.naam, { taak, fase: 'afhandeling', sinds: klok.nu() })
      levend(240_000)   // de afhandeling hierna (trace opslaan, sluiten met video) telt ook als leven

      // Slot kwijt of over de limiet: de handler moet ophouden. Bij slot kwijt sluit de sessie
      // hieronder; dankzij het sein wordt de rest van een doorvoer 'overgeslagen', niet 'mislukt'.
      if (fout?.slotKwijt || fout?.limiet) stopsein.gestopt = true

      // Over de limiet: metLimiet geeft de lus terug, maar de handler werkt door op dezelfde pagina
      // terwijl de volgende taak begint (matransport#600). Eerst het stopsein: de lussen in de
      // handlers (doorvoeren, RVA, verversen) houden er bij hun volgende stap mee op. Loopt hij dan
      // nog (hij hangt op een Playwright-aanroep), dan sluit de context hieronder, na het opslaan
      // van de trace: dan faalt elke aanroep van de oude handler meteen.
      let handlerLooptNog = false
      if (fout?.limiet && lopend) {
        // Schrijvend werk krijgt meer tijd: na het sein loopt één handeling door, plus Annuleer.
        const afbouwSec = k.taak.schrijft ? cfg.taakAfbouwSchrijfSec : cfg.taakAfbouwSec
        levend(afbouwSec * 1000 + 240_000)
        handlerLooptNog = !(await handlerKlaar(lopend, klok.slaap, afbouwSec * 1000))
        log.warn(`${label} ${taak}: over de limiet; ${handlerLooptNog ? 'handler reageert niet op het stopsein, context gaat dicht' : 'handler gestopt'}`)
        await opslag.gebeurtenis(sessie?.id, { soort: 'taak_limiet', taak, handlerGestopt: !handlerLooptNog })
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
      // Liet de proxy verzoeken niet door (bij het inloggen of midden in de taak)? Dan toetsen of de
      // aanbieder de login weigert. 07-11 (matransport#613) gaf dat 10 uur lang lege pagina's en
      // time-outs, en elke 11 min een nieuwe login, zonder dat ergens "proxy" stond.
      // Een 407 is de aanbieder zelf; alleen een tunnelfout zonder 407 moet nog getoetst worden.
      let proxyGeweigerd = Boolean(fout) && ((sessie?.proxy407 ?? 0) > 0 || (fout.proxy407 ?? 0) > 0)
      const proxyVoorToets = fout?.proxy ?? sessie?.proxy?.proxy ?? null
      const tunnelFout = fout?.proxyFout || (sessie?.tunnelFouten ?? 0) > 0 || (fout?.tunnelFouten ?? 0) > 0
      if (fout && !proxyGeweigerd && fout.name !== 'ProxyGeweigerdError' && deps.toetsProxy && proxyVoorToets && tunnelFout) {
        const t = await deps.toetsProxy(proxyVoorToets)
        proxyGeweigerd = t.geweigerd === true
        log.warn(`${label} ${taak}: de proxy liet verzoeken niet door; toets: ${t.status ?? t.fout}${proxyGeweigerd ? ', de aanbieder weigert de login' : ''}`)
      }
      const soort = !sessie ? (fout ? classificeer({ fout, proxyGeweigerd }) : 'gezond')
        : classificeer({ url: page?.url?.() ?? '', depotHost: rvaTaak ? null : sessie.depotHost, fout, planningZichtbaar: fout ? planningZichtbaar : null, opStartpagina: startpagina, herlogin, proxyGeweigerd })
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

      // Inloggen mislukt steeds (geen sessie na een fout): na opdrachtMaxLoginFouten keer gaan de
      // wachtende opdrachten op niet uitgevoerd, met uitleg, en elke nieuwe zolang dat zo blijft
      // (matransport#613). Per depot, niet per opdracht: de fout geldt voor allemaal. Een geweigerde
      // proxy handelt wachtOpProxy hieronder af.
      if (sessie) {
        loginFoutenAchtereen = 0
      } else if (fout && soort !== 'proxy_geweigerd' && ++loginFoutenAchtereen >= cfg.opdrachtMaxLoginFouten) {
        await opdrachtenNietGestart(dag.aanvragen ?? [], REDEN_LOGIN)
      }

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
      if (deps.geheugen) await deps.geheugen.naTaak({ depot: depot.naam, taak, voor: geheugenVoor, duurMs: tijd() - taakBeginMs, login: Boolean(sessie?.ingelogdOm && sessie.ingelogdOm >= taakBeginMs), soort, trace: Boolean(tracePad) })
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
        if (uitkomst.melding === 'autorisatie_niet_gezien') await melden({ soort: 'autorisatie_niet_gezien', depot: depot.naam, detail: `shift ${uitkomst.gebeurtenis?.shift}: via het vangnet gelezen zonder autorisatie te zien; blijft kijken` })
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
      } else if (actie === 'proxy_wacht') {
        await sluit('proxy_geweigerd', { fout })
        await wachtOpProxy(proxyVoorToets, fout)
      } else if (actie === 'pauze') {
        await sluit(soort, { fout })
        // Met de oorzaak: hoeveel in het laatste uur, en wat er misging (#599).
        const uur = logins.filter(t => klok.nu() - t <= 60 * MIN).length
        const soorten = Object.entries(recent.reduce((a, r) => ({ ...a, [r.soort]: (a[r.soort] ?? 0) + 1 }), {})).filter(([s]) => s !== 'gezond').map(([s, n]) => `${s} ${n}x`).join(', ')
        await melden({ soort: 'te_veel_logins', depot: depot.naam, detail: `${uur} logins in het laatste uur (${logins.length} sinds de start); recent: ${soorten || 'onbekend'}; ${cfg.pauzeMin} min pauze` })
        // Het slot blijft van ons tijdens de pauze: anders logt het vangnet-script juist in, en dat
        // is precies het hameren dat de pauze moet voorkomen (05-11 08:56 en 09:00, #598).
        levend(cfg.pauzeMin * MIN)
        await klok.slaap(cfg.pauzeMin * MIN)
      } else if (actie === 'opnieuw_openen' && sessie) {
        // Bij de volgende taak opent de handler het scherm opnieuw; niets extra nodig.
      } else if (soort === 'database') {
        await klok.slaap(10_000)
      }

      // Videosegment of browser vernieuwen (alleen tussen taken). Ook als een handler over zijn
      // limiet niet stopte: met de context dicht faalt hij meteen, zonder nieuwe login. Loopt ffmpeg
      // achter, dan is de context pas later dicht en faalt hij op zijn eigen time-outs.
      if (sessie && cfg.contextWissel && (handlerLooptNog || Date.now() - sessie.segmentOm >= cfg.segmentMin * MIN)) {
        // Cookies 30 + trace 30 + twee tabbladen 60 + sluiten 150 s; naarDepot en rvaOpenen kunnen elk inloggen.
        const segmentMs = 270_000 + 2 * LOGIN_MAX_SEC * 1000
        levend(segmentMs)
        deps.bezig?.set(depot.naam, { taak: 'nieuw videosegment', fase: 'afhandeling', sinds: klok.nu() })
        try {
          const nogIngelogd = await metLimiet(sessie.nieuwSegment(), segmentMs, 'nieuw videosegment')
          if (!nogIngelogd) await opslag.gebeurtenis(sessie.id, { soort: 'contextwissel_nieuwe_login' })
        } catch (err) {
          // De browser reageert niet of de schijf is vol: dicht, de volgende taak logt opnieuw in.
          // Niet doorgooien: dat zou de hele lus van dit depot stoppen.
          log.warn(`${label} Nieuw videosegment mislukt, sessie dicht: ${String(err.message).split('\n')[0]}`)
          levend(240_000)
          await sluit('fout', { fout: err })
        }
      } else if (sessie && !cfg.contextWissel && (handlerLooptNog || sessie.leeftijdMin >= cfg.browserVernieuwenUur * 60)) {
        // Alleen zonder contextwissel: met contextwissel is elk videosegment al kort, en een nieuwe
        // login om de 4 uur is dan onnodig (03-11 12:17: beide depots opnieuw ingelogd).
        await sluit('vernieuwd')
      }
      if (handlerLooptNog && !(await handlerKlaar(lopend, klok.slaap, cfg.taakAfbouwSec * 1000))) {
        await melden({ soort: 'taak_loopt_door', depot: depot.naam, detail: `${taak} loopt nog na het sluiten van de context` })
      }
    }
  } finally {
    levend(240_000)   // netjes sluiten (video opslaan) mag het slot niet kosten
    deps.bezig?.set(depot.naam, { taak: 'sessie sluiten', fase: 'afhandeling', sinds: klok.nu() })
    await sluit(stop() ? 'herstart' : 'nacht')
    await bewaar()
    const laatste = hartslag
    hartslagUit()
    await Promise.race([laatste?.klaar?.(), new Promise(r => { const t = setTimeout(r, 5_000); t.unref?.() })])
    await opslag.slotLos(sleutel, houder)
    deps.bezig?.delete(depot.naam)
  }
  return { reden: 'stop', laatsteVoortgang }
}
