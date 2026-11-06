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
  return delen.join(', ')
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

// Eigen proces plus alle kinderen (browsers, ffmpeg). null waar /proc niet bestaat (lokaal op
// Windows). Een proces dat tijdens het meten verdwijnt telt gewoon niet mee.
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
  let browsersMb = 0
  for (const k of kinderenVan(pid, rijen)) browsersMb += pssMbUit(await lees(k, 'smaps_rollup')) ?? 0
  return { procesMb: Math.round(procesMb), browsersMb: Math.round(browsersMb), totaalMb: Math.round(procesMb + browsersMb) }
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
