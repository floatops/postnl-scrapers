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
import { execFileSync } from 'node:child_process'
import { chromium } from 'playwright'
import { createClient } from '@supabase/supabase-js'
import { getDepots } from '../../credentials-shared/src/index.js'
import { installeerNeutraleConsole } from '../../credentials-shared/src/publiekLog.js'
import { login } from '../../credentials-shared/src/postnl/login.js'
import { beschikbareKolommen } from '../../credentials-shared/src/postnl/schrijver.js'
import { maakRitmonitor } from '../../postnl-ritmonitor/src/ritmonitor.js'
import { maakOpslag } from './opslag.js'
import { Sessie, WORKER } from './sessie.js'
import { draaiDepot } from './depot.js'
import { HANDLERS } from './handlers.js'
import { schatLevensduur } from './levensduur.js'
import { maakRitmonitorTeller } from './runlog.js'

function vereis(naam) {
  const v = process.env[naam]
  if (!v) throw new Error(`Ontbrekende env variabele: ${naam}`)
  return v
}

const KLANT_ID = vereis('KLANT_ID')
const supabase = createClient(vereis('SUPABASE_URL'), vereis('SUPABASE_SERVICE_ROLE_KEY'), { auth: { persistSession: false } })
const headless = String(process.env.POSTNL_HEADLESS ?? 'true').toLowerCase() !== 'false'
const log = console

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

function codeVersie() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim() } catch { return null }
}

async function main() {
  const opslag = maakOpslag({ supabase, klantId: KLANT_ID, log })
  const cfg = await opslag.instellingen()
  const depots = await getDepots(supabase, KLANT_ID, 'postnl')
  installeerNeutraleConsole({ klantId: KLANT_ID, depots })
  if (!depots.length) { log.log('Geen PostNL-depots voor deze klant'); return }
  const kolommen = await beschikbareKolommen(supabase)
  const ritmonitor = maakRitmonitor({ supabase, klantId: KLANT_ID, login: (page, depot) => login(page, depot, { log }), log })
  const teller = maakRitmonitorTeller({ opslag, depots: depots.map(d => d.naam), log })

  // Nieuwe code in de checkout: de lopende taken afmaken en met 42 stoppen.
  const versie = codeVersie()
  const codeCheck = setInterval(() => {
    const nu = codeVersie()
    if (versie && nu && nu !== versie) { log.log(`Nieuwe code (${nu.slice(0, 7)}): herstart na de lopende taak`); stop = true; exitCode = 42 }
  }, cfg.codeCheckMin * 60_000)

  // Gemeten levensduur per depot, elk uur ververst.
  const schattingen = {}
  const verversSchatting = async () => { for (const d of depots) schattingen[d.naam] = schatLevensduur(await opslag.levensduren(d.naam)) }
  await verversSchatting()
  const schattingTimer = setInterval(verversSchatting, 3600_000)

  // Waakhond: als geen enkele depot-lus meer voortgang maakt, is er iets vastgelopen dat de
  // tijdslimiet niet ving. Dan hard stoppen; de bewaker start opnieuw, het slot verloopt vanzelf.
  let voortgang = Date.now()
  const maxStil = (Math.max(...Object.values(cfg.taakLimietSec)) + 300) * 1000
  const waakhond = setInterval(async () => {
    if (Date.now() - voortgang > maxStil) {
      await melden({ soort: 'vastgelopen', detail: `${Math.round((Date.now() - voortgang) / 60000)} min geen voortgang; proces stopt` })
      process.exit(1)
    }
  }, 30_000)

  const klok = { nu: () => { voortgang = Date.now(); return new Date() }, slaap: (ms) => new Promise(r => setTimeout(r, ms)) }

  const naRun = async (r) => {
    const id = await opslag.runStart(r.worker)
    const { worker, trace, ...velden } = r
    await opslag.runEinde(id, { ...velden, ...(trace ? { video_paths: [{ soort: 'trace', storage_path: trace }] } : {}) })
  }

  log.log(`Sessiehouder gestart voor ${depots.length} depot(s), houder ${houder}`)
  const uitkomsten = await Promise.allSettled(depots.map(depot => draaiDepot({
    depot, klantId: KLANT_ID, cfg, opslag, klok, log, houder, melden, naRun,
    stop: () => stop,
    schatting: () => schattingen[depot.naam] ?? null,
    telRitmonitor: (d, r) => teller.tel(d, r),
    handlers: HANDLERS,
    ctx: { supabase, klantId: KLANT_ID, depot, kolommen, ritmonitor },
    maakSessie: (d) => new Sessie({ depot: d, klantId: KLANT_ID, supabase, chromium, opslag, cfg, log, headless }),
  })))
  for (const [i, u] of uitkomsten.entries()) {
    if (u.status === 'rejected') {
      exitCode = exitCode || 1
      await melden({ soort: 'depot_gestopt', depot: depots[i].naam, detail: String(u.reason?.message ?? u.reason).slice(0, 300) })
    }
  }
  await teller.flush()
  clearInterval(codeCheck); clearInterval(schattingTimer); clearInterval(waakhond); teller.stop()
}

main()
  .then(() => process.exit(exitCode))
  .catch(async (err) => { log.error(err); await melden({ soort: 'gestopt', detail: String(err?.message ?? err).slice(0, 300) }).catch(() => {}); process.exit(1) })
