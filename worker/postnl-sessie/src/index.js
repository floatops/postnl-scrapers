// postnl-sessie — de sessiehouder: per depot één doorlopende PostNL-sessie voor de ochtendlezing,
// de definitieve lezing per shift en de ritmonitor (floatops/matransport#562). Uitleg:
// ../POSTNL_SESSIE.md.
//
// Draait per klant als één proces op de VPS (setsid + flock, gestart door de cronjob
// postnl-sessie-bewaker; zie matransport worker/vps-server). Exitcodes:
//   0   gestopt (signaal, einde dag of de vaste herstart 's nachts; de bewaker start hem opnieuw)
//   42  nieuwe code in de checkout: de wrapper start meteen opnieuw
//   1   fout; de bewaker start hem binnen 2 minuten opnieuw, de oude scripts vangen het op
import 'dotenv/config'
import { randomUUID } from 'node:crypto'
import { getHeapStatistics } from 'node:v8'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { getDepots } from '../../credentials-shared/src/index.js'
import { installeerNeutraleConsole } from '../../credentials-shared/src/publiekLog.js'
import { login } from '../../credentials-shared/src/postnl/login.js'
import { toetsProxy, huidigeProxy } from '../../credentials-shared/src/proxyPool.js'
import { beschikbareKolommen } from '../../credentials-shared/src/postnl/schrijver.js'
import { maakRitmonitor } from '../../postnl-ritmonitor/src/ritmonitor.js'
import { maakOpslag } from './opslag.js'
import path from 'node:path'
import { Sessie, WORKER, WERK_ROOT } from './sessie.js'
import { draaiDepot } from './depot.js'
import { HANDLERS, planner, rva } from './handlers.js'
import { schatLevensduur } from './levensduur.js'
import { maakRitmonitorTeller } from './runlog.js'
import { maakDepotBeheer } from './depots.js'
import { beslisCode, codeVersie, codeVersieBijStart, codeVersieFout, gewijzigdePaden, headVerschovenOp, MAPPEN } from './codeversie.js'
import { beoordeelGeheugen, beoordeelTotaal, compact, geheugenTekst, maakGeheugenLog, meetTotaal, metGrens, mapMb, verschilTaak, vrijGb } from './geheugen.js'
import { dagelijkseHerstartNu } from './herstart.js'
import { depotSlug } from '../../credentials-shared/src/sessieVideo.js'
import { waakhondMs } from './instellingen.js'
import { zetTijdInLog, tijdStempel } from '../../credentials-shared/src/tijdLog.js'
import fs from 'node:fs/promises'

function vereis(naam) {
  const v = process.env[naam]
  if (!v) throw new Error(`Ontbrekende env variabele: ${naam}`)
  return v
}

const KLANT_ID = vereis('KLANT_ID')
const supabase = createClient(vereis('SUPABASE_URL'), vereis('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const headless = String(process.env.POSTNL_HEADLESS ?? 'true').toLowerCase() !== 'false'
const log = console

zetTijdInLog()   // datum en tijd op elke logregel (#599)

let stop = false
let exitCode = 0
const houder = `${WORKER}:${process.pid}:${randomUUID().slice(0, 8)}`

process.on('SIGTERM', () => { log.log('SIGTERM: netjes stoppen na de lopende taak'); stop = true })
process.on('SIGINT', () => { log.log('SIGINT: netjes stoppen na de lopende taak'); stop = true })
process.on('unhandledRejection', (err) => log.error('Onverwachte fout (gaat door):', err?.message ?? err))

// Melding voor super_admin: db_fout_log → check_operationele_fouten() → push binnen 15 min.
async function melden(m) {
  log.warn(`Melding ${m.soort}${m.depot ? ` [${m.depot}]` : ''}: ${m.detail ?? ''}`)
  const { error } = await supabase.from('db_fout_log').insert({ bron: m.bron ?? WORKER, melding: `${m.soort}${m.depot ? ` (${m.depot})` : ''}: ${m.detail ?? ''}`.slice(0, 500), context: { klant_id: KLANT_ID, ...m } })
  if (error) log.error(`Melden mislukt: ${error.message}`)
}

async function main() {
  const opslag = maakOpslag({ supabase, klantId: KLANT_ID, log })
  // POSTNL_SESSIE_INSTELLINGEN (json): alleen voor een handmatige proef, bv. 's nachts met andere
  // werktijden. Gaat boven de instellingen van de klant; zonder variabele niets anders.
  const cfg = await opslag.instellingen(process.env.POSTNL_SESSIE_INSTELLINGEN ? JSON.parse(process.env.POSTNL_SESSIE_INSTELLINGEN) : null)
  const depots = await getDepots(supabase, KLANT_ID, 'postnl')
  installeerNeutraleConsole({ klantId: KLANT_ID, depots })
  if (!depots.length) { log.log('Geen PostNL-depots voor deze klant'); return }
  const kolommen = await beschikbareKolommen(supabase)
  const ritmonitor = maakRitmonitor({ supabase, klantId: KLANT_ID, login: (page, depot) => login(page, depot, { log }), log })
  const teller = maakRitmonitorTeller({ opslag, depots: depots.map(d => d.naam), log })

  // Nieuwe code in de checkout die de sessiehouder raakt: de lopende taken afmaken en met 42
  // stoppen. Code van een andere worker (bv. postnl-rva) geeft geen herstart (codeversie.js).
  // Lukt het bepalen van de versie niet (git weigert, matransport#622), dan één melding: zonder
  // versie merkt dit proces nieuwe code niet op en kan het half op oude code blijven draaien.
  const startMs = Date.now()
  let versie = await codeVersieBijStart()
  let onbekendGemeld = false
  let onbekendGelogdOp = 0
  const versieOnbekend = (wanneer) => {
    if (Date.now() - onbekendGelogdOp >= 60 * 60_000) { // hoogstens één logregel per uur
      onbekendGelogdOp = Date.now()
      log.warn(`Codeversie onbekend (${wanneer}): ${codeVersieFout()}`)
    }
    if (onbekendGemeld) return
    onbekendGemeld = true
    // Eigen bron: check_operationele_fouten dempt per bron 6 uur, en onder 'postnl-sessie' zou
    // een eerdere melding van die dag deze push tegenhouden.
    melden({ bron: 'postnl-sessie-codeversie', soort: 'codeversie_onbekend', detail: `git rev-parse HEAD faalt ${wanneer} (${codeVersieFout()}); nieuwe code wordt niet opgemerkt` })
      .catch(err => log.error(`Melden mislukt: ${err?.message ?? err}`))
  }
  if (versie) log.log(`Codeversie bij de start: ${versie.slice(0, 7)}`)
  else versieOnbekend('bij de start')

  // Planner en RVA meteen laden, uit dezelfde versie als de rest (matransport#622): pas bij de
  // eerste taak laden gaf na een deploy nieuwe planner-code naast oude gedeelde modules
  // ("does not provide an export named …"). Mislukt het hier, dan probeert de taak het later.
  for (const [naam, m] of [['planner', planner], ['rva', rva]]) {
    try { await m.laad() } catch (err) { log.error(`Vooraf laden van ${naam} mislukt (taak probeert later): ${err?.message ?? err}`) }
  }

  const codeCheck = setInterval(() => {
    const nu = codeVersie()
    const paden = versie && nu && nu !== versie ? gewijzigdePaden(versie, nu) : null
    let verschovenNaStart = null
    if (!versie && nu) { const op = headVerschovenOp(); verschovenNaStart = op == null ? null : op > startMs }
    const besluit = beslisCode(versie, nu, paden, { verschovenNaStart })
    if (besluit === 'gelijk') return
    if (besluit === 'onbekend') { versieOnbekend('tijdens het draaien'); return }
    if (besluit === 'aannemen') {
      log.log(`Codeversie weer bekend (${nu.slice(0, 7)}), sinds de start niet verschoven: geen herstart`)
      versie = nu
      return
    }
    if (besluit === 'geen_herstart') {
      const geladenMap = (paden ?? []).filter(p => MAPPEN.some(m => p.startsWith(m)))
      log.log(`Nieuwe code (${nu.slice(0, 7)}) raakt de sessiehouder niet: geen herstart (${paden?.length ?? 0} paden gewijzigd${geladenMap.length ? `, in zijn mappen alleen documentatie/tests: ${geladenMap.length}` : ', geen in zijn mappen'})`)
      versie = nu
      return
    }
    log.log(versie
      ? `Nieuwe code (${nu.slice(0, 7)}): herstart na de lopende taak`
      : `Codeversie weer bekend (${nu.slice(0, 7)}), was onbekend bij de start: herstart na de lopende taak`)
    stop = true; exitCode = 42
  }, cfg.codeCheckMin * 60_000)

  // Geheugenwacht (geheugen.js, matransport#578, #600): elke minuut de heap en het totaal met
  // browsers; elk kwartier in het log, met de werkmap en de vrije schijf. Te vol: melding en netjes
  // herstarten na de lopende taak, nooit een crash midden in een opdracht.
  const limietMb = getHeapStatistics().heap_size_limit / 1048576
  const werkMap = path.join(WERK_ROOT, KLANT_ID)
  let gewaarschuwd = false
  let totaalGewaarschuwd = false
  let geheugenGelogd = 0
  let schijfGemeld = 0
  let hoogste = 0
  const bezig = new Map()   // depot → { taak, fase, sinds } (depot.js); ook in de geheugenregel per minuut
  // Dagbestand met de verdeling (matransport#668): elke minuut en per taak een regel, naast het
  // logbestand van de VPS (die ruimt het na 14 dagen op). Lokaal (zonder LOG) niets.
  const geheugenLog = maakGeheugenLog({ map: process.env.LOG ? path.dirname(process.env.LOG) : null, klantId: KLANT_ID, log })
  // Eén meting tegelijk, elk deel begrensd (matransport#668): een hangende /proc- of schijflezing mag
  // de wacht niet stil laten stoppen, en tikken mogen zich niet opstapelen.
  let meetLoopt = false
  const geheugenCheck = setInterval(async () => {
    if (meetLoopt) return
    meetLoopt = true
    try {
      const m = process.memoryUsage()
      const meting = { heapMb: m.heapUsed / 1048576, limietMb, rssMb: m.rss / 1048576, totaal: await metGrens(meetTotaal(), 10_000) }
      hoogste = Math.max(hoogste, meting.totaal?.totaalMb ?? 0)
      if (cfg.geheugenMeten && meting.totaal) {
        await geheugenLog({ soort: 'minuut', ...compact(meting.totaal), bezig: Object.fromEntries([...bezig].map(([d, b]) => [depotSlug(d), `${b.taak} (${b.fase})`])) })
      }
      if (Date.now() - geheugenGelogd >= cfg.geheugenLogMin * 60_000) {
        geheugenGelogd = Date.now()
        const volledig = { ...meting, werkMapMb: await metGrens(mapMb(werkMap), 10_000), vrijGb: await metGrens(vrijGb(), 10_000) }
        log.log(`Geheugen: ${geheugenTekst(volledig)}, hoogste sinds start ${hoogste} MB`)
        const schijfTe = volledig.vrijGb != null && volledig.vrijGb < cfg.schijfVrijMinGb
        if ((schijfTe || volledig.werkMapMb > cfg.werkMapMaxMb) && Date.now() - schijfGemeld >= 3600_000) {
          schijfGemeld = Date.now()
          await melden({ soort: 'schijf_hoog', detail: `werkmap ${volledig.werkMapMb} MB, schijf vrij ${volledig.vrijGb ?? '?'} GB` })
        }
      }
      const oordeel = beoordeelGeheugen({ ...meting, cfg, gewaarschuwd })
      const oordeelTotaal = beoordeelTotaal({ totaalMb: meting.totaal?.totaalMb, depots: depots.length, cfg, gewaarschuwd: totaalGewaarschuwd })
      if (oordeel === 'waarschuwen' || oordeelTotaal === 'waarschuwen') {
        if (oordeel === 'waarschuwen') gewaarschuwd = true
        if (oordeelTotaal === 'waarschuwen') totaalGewaarschuwd = true
        await melden({ soort: 'geheugen_hoog', detail: geheugenTekst(meting) })
      }
      if ((oordeel === 'herstarten' || oordeelTotaal === 'herstarten') && !stop) {
        log.log(`Geheugen te vol (${geheugenTekst(meting)}): herstart na de lopende taak`)
        stop = true; exitCode = 42   // eerst dit: een mislukte melding mag de herstart niet tegenhouden
        await melden({ soort: 'geheugen_herstart', detail: `${geheugenTekst(meting)}; herstart na de lopende taak` })
      }
    } catch (e) {
      log.warn(`Geheugenmeting mislukt (volgende minuut opnieuw): ${e.message}`)
    } finally {
      meetLoopt = false
    }
  }, 60_000)

  // Vaste herstart elke nacht (herstart.js, matransport#668): na de lopende taak, exit 0. De
  // bewaker-cron start hem binnen 2 min opnieuw (draait hij 's nachts, dan staat RVA aan).
  const herstartCheck = setInterval(() => {
    if (stop || !cfg.dagelijkseHerstart) return
    if (!dagelijkseHerstartNu({ nuMs: Date.now(), startMs, om: cfg.dagelijkseHerstartOm })) return
    log.log(`Vaste herstart (${cfg.dagelijkseHerstartOm}): stoppen na de lopende taak, de bewaker start opnieuw`)
    stop = true; exitCode = 0
  }, 60_000)

  // Geheugen per taak (depot.js, matransport#668). Hooguit 5 s per meting, gooit nooit.
  const geheugenPerTaak = {
    meet: () => (cfg.geheugenMeten ? metGrens(meetTotaal(), 5_000) : null),
    naTaak: async ({ depot, taak, voor, duurMs, login, soort, trace }) => {
      try {
        if (!cfg.geheugenMeten || !voor) return
        const na = await metGrens(meetTotaal(), 5_000)
        const slug = depotSlug(depot)
        const verschil = verschilTaak(voor, na, slug)
        await geheugenLog({ soort: 'taak', depot: slug, taak, duurMs, login, uitkomst: soort, trace, verschil, voor: { totaalMb: voor.totaalMb, procesMb: voor.procesMb, heapMb: voor.node?.heapMb, browser: voor.browsers?.[slug] ?? null }, na: compact(na) })
        if (verschil && Math.abs(verschil.totaalMb ?? 0) >= cfg.geheugenTaakLogMb) {
          const t = (x) => (x == null ? '?' : `${x > 0 ? '+' : ''}${x}`)
          log.log(`[${depot}] Geheugen ${taak}${login ? ' (met login)' : ''}: ${t(verschil.totaalMb)} MB in ${Math.round(duurMs / 1000)} s (browser ${t(verschil.browserMb)}, waarvan tabbladen ${t(verschil.tabbladMb)}; proces ${t(verschil.procesMb)}, heap ${t(verschil.heapMb)}), nu ${na.totaalMb} MB`)
        }
      } catch (e) { log.warn(`Geheugen per taak niet gemeten: ${e.message}`) }
    },
  }

  // Gemeten levensduur per depot, elk uur ververst.
  const schattingen = {}
  const verversSchatting = async () => { for (const d of depots) schattingen[d.naam] = schatLevensduur(await opslag.levensduren(d.naam)) }
  await verversSchatting()
  const schattingTimer = setInterval(verversSchatting, 3600_000)

  // Waakhond: als geen enkele depot-lus meer voortgang maakt, is er iets vastgelopen dat de
  // tijdslimiet niet ving. Dan hard stoppen; de bewaker start opnieuw, het slot verloopt vanzelf.
  // De melding zegt welke taak per depot liep (#599). Hoogstens 10 s op de melding wachten en één
  // keer afgaan: een hangende database mag het stoppen niet tegenhouden, en elke tik van 30 s gaf
  // anders opnieuw een melding. waakhondMs per tik: de limieten kunnen per klant wijzigen.
  let voortgang = Date.now()
  let waakhondAf = false
  const waakhond = setInterval(async () => {
    if (waakhondAf || !(Date.now() - voortgang > waakhondMs(cfg))) return
    waakhondAf = true
    const wat = [...bezig].map(([d, b]) => `${d}: ${b.taak} (${b.fase}) sinds ${tijdStempel(b.sinds)}`).join('; ') || 'geen lopende taak'
    // finally: ook als de melding mislukt stopt het proces. Dit is het laatste vangnet.
    try {
      await Promise.race([
        melden({ soort: 'vastgelopen', detail: `${Math.round((Date.now() - voortgang) / 60000)} min geen voortgang (${wat}); proces stopt` }),
        new Promise(r => setTimeout(r, 10_000)),
      ])
    } finally {
      process.exit(1)
    }
  }, 30_000)

  // `wekbaar`: wachten dat de planner-wekker meteen afbreekt (alleen het wachten tussen taken).
  const wekkers = new Set()
  const klok = {
    nu: () => { voortgang = Date.now(); return new Date() },
    tijd: () => Date.now(),   // zonder bijwerking: voor de hartslag van het slot (depot.js, #598)
    slaap: (ms) => new Promise(r => setTimeout(r, ms)),
    wekbaar: (ms) => new Promise((r) => {
      const klaar = () => { clearTimeout(t); wekkers.delete(klaar); r() }
      const t = setTimeout(klaar, ms)
      wekkers.add(klaar)
    }),
  }

  const naRun = async (r) => {
    const id = await opslag.runStart(r.worker)
    const { worker, trace, ...velden } = r
    await opslag.runEinde(id, { ...velden, ...(trace ? { video_paths: [{ soort: 'trace', storage_path: trace }] } : {}) })
  }

  // Wanneer de VPS het laatst een Plannen-opdracht meldde: een lopende verversronde (taak plannen)
  // houdt dan op tussen twee ritten, zodat de opdracht niet hoeft te wachten (matransport#578).
  let plannerSignaal = 0
  let rvaSignaal = 0

  log.log(`Sessiehouder gestart voor ${depots.length} depot(s), houder ${houder}`)
  // Per depot één lus (één browser, één tabblad, één login), elk met een eigen stop-vlag.
  // Een PostNL-login toevoegen, wijzigen, uitzetten of verwijderen op Inloggegevens geeft een
  // seintje: de database-trigger postnl_sessie_koppeling → VPS → het wekkerbestand. Dan worden de
  // depots opnieuw gelezen (database, geen PostNL-login) en per depot gestart, opnieuw ingelogd of
  // gestopt (depots.js). Eens per uur hetzelfde als vangnet, voor een seintje dat verloren ging.
  const beheer = maakDepotBeheer({
    log, isGestopt: () => stop,
    startLus: (depot, lus) => {
      teller.depot(depot.naam)
      return draaiDepot({
        depot, klantId: KLANT_ID, cfg, opslag, klok, log, houder, melden, naRun, bezig, geheugen: geheugenPerTaak,
        stop: () => stop || lus.stop,
        schatting: () => schattingen[depot.naam] ?? null,
        telRitmonitor: (d, r) => teller.tel(d, r),
        toetsProxy,
        huidigeProxy: () => huidigeProxy(supabase),
        handlers: HANDLERS,
        ctx: { supabase, klantId: KLANT_ID, depot, kolommen, ritmonitor, plannerSignaal: () => plannerSignaal, rvaSignaal: () => rvaSignaal, rvaStop: { om: 0 } },
        maakSessie: (d) => new Sessie({ depot: d, klantId: KLANT_ID, supabase, chromium, opslag, cfg, log, headless }),
      }).catch(async (err) => {
        exitCode = exitCode || 1
        await melden({ soort: 'depot_gestopt', depot: depot.naam, detail: String(err?.message ?? err).slice(0, 300) })
      })
    },
  })
  // Instellingen opnieuw lezen (elk uur, bij een seintje en bij een RVA-opdracht): RVA aan- of
  // uitzetten in postnl_instellingen werkt dan zonder herstart (matransport#569). In hetzelfde
  // object, zodat elke depot-lus het bij zijn volgende ronde ziet; rvaWakker opent dan het tabblad.
  const herleesInstellingen = async (reden) => {
    try {
      const nieuw = await opslag.instellingen(process.env.POSTNL_SESSIE_INSTELLINGEN ? JSON.parse(process.env.POSTNL_SESSIE_INSTELLINGEN) : null)
      if (JSON.stringify(nieuw) === JSON.stringify(cfg)) return
      log.log(`Instellingen gewijzigd (${reden})${nieuw.rva !== cfg.rva ? `: RVA ${nieuw.rva ? 'aan' : 'uit'}` : ''}`)
      Object.assign(cfg, nieuw)
    } catch (err) { log.warn(`Instellingen opnieuw lezen mislukt (${reden}): ${err.message}`) }
  }
  const herlees = async (reden) => {
    if (stop) return
    await herleesInstellingen(reden)
    try {
      const w = beheer.verwerk(await getDepots(supabase, KLANT_ID, 'postnl'), reden)
      if (!w.starten.length && !w.herstarten.length && !w.stoppen.length) log.log(`Depots gecontroleerd (${reden}): geen wijziging`)
    } catch (err) { log.warn(`Depots opnieuw lezen mislukt (${reden}): ${err.message}`) }
  }

  beheer.verwerk(depots, 'start')

  // Wekkerbestanden van de VPS: alleen de wijzigtijd telt (een stat, goedkoop).
  const volgWekker = async (pad, ms, bij) => {
    if (!pad) return null
    const tijd = async () => (await fs.stat(pad).catch(() => null))?.mtimeMs ?? null
    let laatste = await tijd()
    return setInterval(async () => {
      const t = await tijd()
      if (t && t !== laatste) { laatste = t; await bij() }
    }, ms)
  }
  const wekkerCheck = await volgWekker(process.env.POSTNL_SESSIE_WEKKER, 15_000, () => herlees('inloggegevens gewijzigd'))
  // Planner-opdracht (VPS /run/postnl-planner terwijl dit proces draait): elke seconde kijken en de
  // wachtende depot-lussen meteen wekken. Die lezen dan planning_taken (elke 15 s als vangnet).
  const plannerCheck = await volgWekker(process.env.POSTNL_PLANNER_WEKKER, 1_000, () => {
    log.log('Planner-opdracht: meteen oppakken')
    plannerSignaal = Date.now()
    for (const w of [...wekkers]) w()
  })
  // RVA-opdracht uit de app (VPS /run/postnl-rva, matransport#569): idem, meteen oppakken. De lus
  // leest rva_opdrachten ook elke 15 s als vangnet.
  const rvaCheck = await volgWekker(process.env.POSTNL_RVA_WEKKER, 1_000, async () => {
    log.log('RVA-opdracht: meteen oppakken')
    // Ook een lopende verversronde houdt dan op tussen twee ritten: daar wachtte een opdracht uit de
    // app tot ruim een minuut op (06-11: tot 92 s, matransport#600). Geremd per depot, zie handlers.js.
    rvaSignaal = Date.now()
    if (!cfg.rva) await herleesInstellingen('RVA-opdracht')
    for (const w of [...wekkers]) w()
  })
  const uurCheck = setInterval(() => herlees('controle per uur'), 3600_000)

  // Wachten tot alle lussen klaar zijn, ook die er onderweg bij kwamen of opnieuw startten.
  await beheer.wacht()
  clearInterval(wekkerCheck); clearInterval(plannerCheck); clearInterval(rvaCheck); clearInterval(uurCheck)
  await teller.flush()
  clearInterval(codeCheck); clearInterval(geheugenCheck); clearInterval(herstartCheck); clearInterval(schattingTimer); clearInterval(waakhond); teller.stop()
}

main()
  .then(() => process.exit(exitCode))
  .catch(async (err) => { log.error(err); await melden({ soort: 'gestopt', detail: String(err?.message ?? err).slice(0, 300) }).catch(() => {}); process.exit(1) })
