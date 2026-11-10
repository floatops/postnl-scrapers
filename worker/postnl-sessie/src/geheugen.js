// Geheugenwacht van de sessiehouder (floatops/matransport#578). Puur: de beslissing, los van Node.
//
// Op 04-11 liep de sessiehouder vier keer vol (heap out of memory, exit 134), één keer midden in
// een Plannen-opdracht. Zo'n crash laat een opdracht op 'bezig' staan en geeft een nieuwe login.
// Daarom kijkt het proces elke minuut naar zijn eigen heap, en herstart het netjes ná de lopende
// taak (exit 42, zoals bij nieuwe code) ruim voordat V8 de grens haalt. De crashes gebeurden bij
// ~3,3 GB heap.
//
// De heap is niet het hele verhaal (06-11, matransport#600): bij 200 MB heap gebruikte het proces
// 1,8 GB, en de browsers samen nog eens tot 2,4 GB. Daarom meet de wacht ook het totaal: dit proces
// plus al zijn kinderen, als PSS (gedeeld geheugen eerlijk verdeeld, rss telt dat dubbel), en toetst
// dat aan de reservering per depot.
//
//   ok           niets doen
//   waarschuwen  één melding (de wachtdog pusht naar super_admin); blijft draaien
//   herstarten   lopende taak afmaken, dan exit 42: de wrapper start meteen opnieuw
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export function beoordeelGeheugen({ heapMb, limietMb, cfg, gewaarschuwd = false }) {
  if (!limietMb || !Number.isFinite(heapMb)) return 'ok'
  const deel = heapMb / limietMb
  if (deel >= cfg.geheugenHerstartDeel) return 'herstarten'
  if (deel >= cfg.geheugenWaarschuwDeel && !gewaarschuwd) return 'waarschuwen'
  return 'ok'
}

// Hetzelfde voor het totaal: de grens hangt aan het aantal depots van de klant.
export function beoordeelTotaal({ totaalMb, depots, cfg, gewaarschuwd = false }) {
  if (!Number.isFinite(totaalMb) || !depots) return 'ok'
  const reserve = cfg.geheugenReserveBasisMb + depots * cfg.geheugenReserveMbPerDepot
  if (totaalMb >= reserve * cfg.geheugenTotaalHerstartDeel) return 'herstarten'
  if (totaalMb >= reserve && !gewaarschuwd) return 'waarschuwen'
  return 'ok'
}

export function geheugenTekst({ heapMb, limietMb, rssMb, totaal = null, werkMapMb = null, vrijGb = null }) {
  const delen = [`heap ${Math.round(heapMb)} MB van ${Math.round(limietMb)} MB (${Math.round((heapMb / limietMb) * 100)}%), rss ${Math.round(rssMb)} MB`]
  if (totaal) delen.push(`totaal ${totaal.totaalMb} MB (proces ${totaal.procesMb}, browsers ${totaal.browsersMb})`)
  if (werkMapMb != null) delen.push(`werkmap ${werkMapMb} MB`)
  if (vrijGb != null) delen.push(`schijf vrij ${vrijGb} GB`)
  const verdeling = verdelingTekst(totaal)
  if (verdeling) delen.push(verdeling)
  return delen.join(', ')
}

// ---- Waar gaat het geheugen naartoe (matransport#668) ----------------------------------------
// Alleen meten. Per browser (één per depot, herkend aan `--floatops-depot=<slug>` op de
// commandoregel, sessie.js) de soorten Chromium-processen, en voor het Node-proces wat in V8 zit en
// wat erbuiten (malloc, Playwright-buffers, code). Elke minuut en per taak een regel in het
// dagbestand (maakGeheugenLog), rapport met scripts/geheugen-rapport.mjs.

// Argumenten uit /proc/<pid>/cmdline. Normaal gescheiden door \0, maar Chromium herschrijft bij
// processen uit de zygote (tabbladen, gpu) zijn argv als één tekst met spaties (gemeten op de VPS
// 10-11). Daarom op beide splitsen; de paden van Playwright bevatten geen spaties.
const argDelen = (cmdline) => String(cmdline ?? '').split(/[\0\s]+/).filter(Boolean)

// Soort proces uit /proc/<pid>/cmdline.
export function soortUitCmdline(cmdline) {
  const args = argDelen(cmdline)
  const exe = path.basename(args[0] ?? '')
  const type = args.find(a => a.startsWith('--type='))?.slice(7) ?? null
  if (/ffmpeg/i.test(exe)) return 'video'
  if (type === 'renderer') return 'tabblad'
  if (type === 'gpu-process') return 'gpu'
  if (type === 'utility') return 'hulp'
  if (type === 'zygote') return 'zygote'
  if (type) return 'overig'
  if (/chrom|headless_shell/i.test(exe)) return 'browser'
  return 'overig'
}

export function depotUitCmdline(cmdline) {
  const a = argDelen(cmdline).find(x => x.startsWith('--floatops-depot='))
  return a ? a.slice('--floatops-depot='.length) || null : null
}

const SOORTEN = ['browser', 'tabblad', 'gpu', 'hulp', 'zygote', 'overig']

// Puur. `rijen`: [{ pid, ppid, cmdline, pssMb }] van alle nakomelingen van `wortel`. Elke
// nakomeling hoort bij de tak (direct kind van de wortel) waar hij onder hangt; een tak met een
// depot-merk is de browser van dat depot. ffmpeg (video's) start Playwright vanuit Node zelf: dat is
// een eigen tak, `videoMb`. Wat nergens bij past: `overigMb`.
export function verdeel(wortel, rijen) {
  const perPid = new Map(rijen.map(r => [r.pid, r]))
  const takVan = (r) => {
    let x = r
    for (let i = 0; i < 64 && x && x.ppid !== wortel; i++) x = perPid.get(x.ppid)
    return x?.ppid === wortel ? x : null
  }
  const browsers = {}
  let videoMb = 0
  let overigMb = 0
  for (const r of rijen) {
    const mb = r.pssMb ?? 0
    const tak = takVan(r)
    const depot = tak ? depotUitCmdline(tak.cmdline) : null
    const soort = soortUitCmdline(r.cmdline)
    if (depot) {
      const b = browsers[depot] ??= { totaalMb: 0, tabbladen: 0, ...Object.fromEntries(SOORTEN.map(s => [s, 0])) }
      const s = SOORTEN.includes(soort) ? soort : 'overig'
      b[s] += mb
      b.totaalMb += mb
      if (s === 'tabblad') b.tabbladen++
    } else if (soort === 'video' || (tak && soortUitCmdline(tak.cmdline) === 'video')) videoMb += mb
    else overigMb += mb
  }
  for (const b of Object.values(browsers)) for (const k of Object.keys(b)) if (k !== 'tabbladen') b[k] = Math.round(b[k])
  return { browsers, videoMb: Math.round(videoMb), overigMb: Math.round(overigMb) }
}

// Node-proces in MB uit process.memoryUsage(). `buitenV8Mb`: rss min de V8-heap (malloc, buffers,
// code, stacks). Blijft dat na de ochtend hoog terwijl de heap zakt, dan helpt een andere
// malloc-instelling; groeit de heap, dan houdt de code zelf iets vast.
export function nodeDelen(m) {
  const mb = (b) => Math.round((Number(b) || 0) / 1048576)
  return { heapMb: mb(m.heapUsed), heapTotaalMb: mb(m.heapTotal), externMb: mb(m.external), buffersMb: mb(m.arrayBuffers), rssMb: mb(m.rss), buitenV8Mb: Math.max(0, mb(m.rss) - mb(m.heapTotal)) }
}

// Voor de kwartierregel in het log.
export function verdelingTekst(totaal) {
  const delen = []
  if (totaal?.node) delen.push(`proces: heap ${totaal.node.heapMb}/${totaal.node.heapTotaalMb}, buiten V8 ${totaal.node.buitenV8Mb} (buffers ${totaal.node.buffersMb})`)
  for (const [depot, x] of Object.entries(totaal?.browsers ?? {})) {
    delen.push(`browser ${depot} ${x.totaalMb} (tabbladen ${x.tabbladen}x ${x.tabblad}, gpu ${x.gpu}, hoofd ${x.browser}, hulp ${x.hulp + x.zygote + x.overig})`)
  }
  if (totaal?.videoMb) delen.push(`video ${totaal.videoMb}`)
  return delen.join('; ')
}

// Klein formaat voor het dagbestand.
export function compact(meting) {
  if (!meting) return null
  const { totaalMb, procesMb, browsersMb, videoMb, overigMb, node, browsers } = meting
  return { totaalMb, procesMb, browsersMb, videoMb, overigMb, node, browsers }
}

// Verschil tussen twee metingen, voor één depot (zijn browser) en het geheel. Het proces delen de
// depots: draaien er twee taken tegelijk, dan zit de ander er ook in.
export function verschilTaak(voor, na, depot) {
  if (!voor || !na) return null
  const d = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? b - a : null)
  return {
    totaalMb: d(voor.totaalMb, na.totaalMb),
    procesMb: d(voor.procesMb, na.procesMb),
    heapMb: d(voor.node?.heapMb, na.node?.heapMb),
    browserMb: d(voor.browsers?.[depot]?.totaalMb ?? 0, na.browsers?.[depot]?.totaalMb ?? 0),
    tabbladMb: d(voor.browsers?.[depot]?.tabblad ?? 0, na.browsers?.[depot]?.tabblad ?? 0),
  }
}

// Belofte met een grens: na `ms` null, en een fout wordt null. Een meting mag een taak nooit laten
// wachten of laten falen.
export function metGrens(belofte, ms) {
  let t
  return Promise.race([
    Promise.resolve(belofte).catch(() => null),
    new Promise(r => { t = setTimeout(() => r(null), ms) }),
  ]).finally(() => clearTimeout(t))
}

// Naam van het dagbestand (NL-datum).
export function geheugenBestand(map, klantId, ms = Date.now()) {
  const dag = new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'Europe/Amsterdam' })
  return path.join(map, `geheugen-${String(klantId).slice(0, 8)}-${dag}.jsonl`)
}

// Schrijft regels naar het dagbestand. Zonder map (lokaal, test) niets. Gooit nooit, wacht hooguit
// 5 s; lukt het niet, dan hoogstens één waarschuwing per uur.
export function maakGeheugenLog({ map, klantId, log = console }) {
  let gewaarschuwd = 0
  return async function schrijf(regel) {
    if (!map) return
    const tekst = JSON.stringify({ t: new Date().toISOString(), ...regel }) + '\n'
    const ok = await metGrens(fs.appendFile(geheugenBestand(map, klantId), tekst).then(() => true), 5_000)
    if (!ok && Date.now() - gewaarschuwd > 3600_000) { gewaarschuwd = Date.now(); log.warn('Geheugenmeting niet weggeschreven (dagbestand)') }
  }
}

// `/proc/<pid>/stat`: "pid (naam) status ppid ...". De naam kan spaties en haakjes bevatten.
export function ouderUitStat(tekst) {
  const veld = String(tekst).slice(String(tekst).lastIndexOf(')') + 2).split(' ')
  const ppid = Number(veld[1])
  return Number.isInteger(ppid) ? ppid : null
}

// Alle pids onder `wortel` (zonder wortel zelf). `rijen`: [{ pid, ppid }].
export function kinderenVan(wortel, rijen) {
  const uit = new Set()
  const rond = [wortel]
  while (rond.length) {
    const p = rond.pop()
    for (const r of rijen) if (r.ppid === p && !uit.has(r.pid) && r.pid !== wortel) { uit.add(r.pid); rond.push(r.pid) }
  }
  return uit
}

export function pssMbUit(rollup) {
  const m = /^Pss:\s+(\d+) kB/m.exec(String(rollup))
  return m ? Number(m[1]) / 1024 : null
}

// Eigen proces plus alle kinderen (browsers, ffmpeg), met de verdeling per browser en de delen van
// het Node-proces (matransport#668). null waar /proc niet bestaat (lokaal op Windows). Een proces
// dat tijdens het meten verdwijnt telt gewoon niet mee.
export async function meetTotaal(pid = process.pid) {
  const lees = (p, f) => fs.readFile(`/proc/${p}/${f}`, 'utf8').catch(() => null)
  const namen = await fs.readdir('/proc').catch(() => null)
  if (!namen) return null
  const rijen = []
  for (const n of namen) {
    if (!/^\d+$/.test(n)) continue
    const s = await lees(n, 'stat')
    if (s) rijen.push({ pid: Number(n), ppid: ouderUitStat(s) })
  }
  const procesMb = pssMbUit(await lees(pid, 'smaps_rollup'))
  if (procesMb == null) return null
  const perPid = new Map(rijen.map(r => [r.pid, r]))
  const kinderen = []
  for (const k of kinderenVan(pid, rijen)) {
    kinderen.push({ ...perPid.get(k), cmdline: (await lees(k, 'cmdline')) ?? '', pssMb: pssMbUit(await lees(k, 'smaps_rollup')) ?? 0 })
  }
  const browsersMb = kinderen.reduce((a, k) => a + k.pssMb, 0)
  return {
    procesMb: Math.round(procesMb), browsersMb: Math.round(browsersMb), totaalMb: Math.round(procesMb + browsersMb),
    node: nodeDelen(process.memoryUsage()),
    ...verdeel(pid, kinderen),
  }
}

// Grootte van een map (MB), zonder symlinks te volgen. 0 als hij niet bestaat.
export async function mapMb(map) {
  let bytes = 0
  const loop = async (d) => {
    for (const n of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
      const p = path.join(d, n.name)
      if (n.isDirectory()) await loop(p)
      else if (n.isFile()) bytes += (await fs.stat(p).catch(() => null))?.size ?? 0
    }
  }
  await loop(map)
  return Math.round(bytes / 1048576)
}

export async function vrijGb(map = os.tmpdir()) {
  const s = await fs.statfs(map).catch(() => null)
  return s ? Math.round((s.bavail * s.bsize) / 1073741824) : null
}
