// postnl-sessie — de sessiehouder: per depot één doorlopende PostNL-sessie voor de ochtendlezing,
// de definitieve lezing per shift en de ritmonitor (floatops/matransport#562). Uitleg:
// ../POSTNL_SESSIE.md.
//
// Draait per klant als één proces op de VPS (setsid + flock, gestart door de cronjob
// postnl-sessie-bewaker; zie matransport worker/vps-server). Exitcodes:
//   0   gestopt (signaal of einde dag)
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
import { beschikbareKolommen } from '../../credentials-shared/src/postnl/schrijver.js'
import { maakRitmonitor } from '../../postnl-ritmonitor/src/ritmonitor.js'
import { maakOpslag } from './opslag.js'
import path from 'node:path'
import { Sessie, WORKER, WERK_ROOT } from './sessie.js'
import { draaiDepot } from './depot.js'
import { HANDLERS } from './handlers.js'
import { schatLevensduur } from './levensduur.js'
import { maakRitmonitorTeller } from './runlog.js'
import { maakDepotBeheer } from './depots.js'
import { codeVersie, gewijzigdePaden, raaktSessiehouder } from './codeversie.js'
import { beoordeelGeheugen, beoordeelTotaal, geheugenTekst, meetTotaal, mapMb, vrijGb } from './geheugen.js'
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
  const { error } = await supabase.from('db_fout_log').insert({ bron: WORKER, melding: `${m.soort}${m.depot ? ` (${m.depot})` : ''}: ${m.detail ?? ''}`.slice(0, 500), context: { klant_id: KLANT_ID, ...m } })
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
  let versie = codeVersie()
  const codeCheck = setInterval(() => {
    const nu = codeVersie()
    if (!versie || !nu || nu === versie) return
    const paden = gewijzigdePaden(versie, nu)
    if (paden && !raaktSessiehouder(paden)) {
      log.log(`Nieuwe code (${nu.slice(0, 7)}) raakt de sessiehouder niet: geen herstart`)
      versie = nu
      return
    }
    log.log(`Nieuwe code (${nu.slice(0, 7)}): herstart na de lopende taak`); stop = true; exitCode = 42
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
  const geheugenCheck = setInterval(async () => {
    try {
      const m = process.memoryUsage()
      const meting = { heapMb: m.heapUsed / 1048576, limietMb, rssMb: m.rss / 1048576, totaal: await meetTotaal() }
      hoogste = Math.max(hoogste, meting.totaal?.totaalMb ?? 0)
      if (Date.now() - geheugenGelogd >= cfg.geheugenLogMin * 60_000) {
        geheugenGelogd = Date.now()
        const volledig = { ...meting, werkMapMb: await mapMb(werkMap), vrijGb: await vrijGb() }
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
    }
  }, 60_000)

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
  const bezig = new Map()   // depot → { taak, sinds } (depot.js)
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
        depot, klantId: KLANT_ID, cfg, opslag, klok, log, houder, melden, naRun, bezig,
        stop: () => stop || lus.stop,
        schatting: () => schattingen[depot.naam] ?? null,
        telRitmonitor: (d, r) => teller.tel(d, r),
        handlers: HANDLERS,
        ctx: { supabase, klantId: KLANT_ID, depot, kolommen, ritmonitor, plannerSignaal: () => plannerSignaal },
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
    if (!cfg.rva) await herleesInstellingen('RVA-opdracht')
    for (const w of [...wekkers]) w()
  })
  const uurCheck = setInterval(() => herlees('controle per uur'), 3600_000)

  // Wachten tot alle lussen klaar zijn, ook die er onderweg bij kwamen of opnieuw startten.
  await beheer.wacht()
  clearInterval(wekkerCheck); clearInterval(plannerCheck); clearInterval(rvaCheck); clearInterval(uurCheck)
  await teller.flush()
  clearInterval(codeCheck); clearInterval(geheugenCheck); clearInterval(schattingTimer); clearInterval(waakhond); teller.stop()
}

main()
  .then(() => process.exit(exitCode))
  .catch(async (err) => { log.error(err); await melden({ soort: 'gestopt', detail: String(err?.message ?? err).slice(0, 300) }).catch(() => {}); process.exit(1) })
