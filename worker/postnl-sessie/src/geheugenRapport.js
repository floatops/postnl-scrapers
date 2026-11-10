// Rapport uit de dagbestanden van de geheugenmeting (matransport#668). Puur, met test; het script
// scripts/geheugen-rapport.mjs leest de bestanden en drukt dit af.

const gem = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null)
const max = (xs) => (xs.length ? Math.max(...xs) : null)
const nlUur = (iso) => new Date(iso).toLocaleString('sv-SE', { timeZone: 'Europe/Amsterdam', hour12: false }).slice(0, 13) + ':00'
const getal = (x) => (Number.isFinite(x) ? x : null)

// `regels`: de JSON-objecten uit de dagbestanden. Geeft per uur (minuutregels), per taak en de
// grootste sprongen (taakregels).
export function maakRapport(regels, { top = 15 } = {}) {
  const minuten = regels.filter(r => r.soort === 'minuut' && Number.isFinite(r.totaalMb))
  const taken = regels.filter(r => r.soort === 'taak' && r.verschil)

  const perUur = new Map()
  for (const r of minuten) {
    const u = nlUur(r.t)
    if (!perUur.has(u)) perUur.set(u, [])
    perUur.get(u).push(r)
  }
  const uren = [...perUur].sort(([a], [b]) => a.localeCompare(b)).map(([uur, rs]) => {
    const depots = [...new Set(rs.flatMap(r => Object.keys(r.browsers ?? {})))].sort()
    return {
      uur,
      totaalMaxMb: max(rs.map(r => r.totaalMb)),
      procesGemMb: gem(rs.map(r => r.procesMb).filter(Number.isFinite)),
      heapGemMb: gem(rs.map(r => r.node?.heapMb).filter(Number.isFinite)),
      buitenV8GemMb: gem(rs.map(r => r.node?.buitenV8Mb).filter(Number.isFinite)),
      videoMaxMb: max(rs.map(r => r.videoMb ?? 0)),
      browsers: Object.fromEntries(depots.map(d => {
        const bs = rs.map(r => r.browsers?.[d]).filter(Boolean)
        return [d, { maxMb: max(bs.map(b => b.totaalMb)), tabbladMaxMb: max(bs.map(b => b.tabblad)), tabbladenMax: max(bs.map(b => b.tabbladen)), gpuMaxMb: max(bs.map(b => b.gpu)) }]
      })),
    }
  })

  const perTaak = new Map()
  for (const r of taken) {
    const k = `${r.depot}|${r.taak}`
    if (!perTaak.has(k)) perTaak.set(k, [])
    perTaak.get(k).push(r)
  }
  const taakRijen = [...perTaak].map(([k, rs]) => {
    const [depot, taak] = k.split('|')
    const d = (veld) => rs.map(r => getal(r.verschil?.[veld])).filter(x => x != null)
    return {
      depot, taak, aantal: rs.length, metLogin: rs.filter(r => r.login).length,
      somMb: d('totaalMb').reduce((a, b) => a + b, 0),
      gemMb: gem(d('totaalMb')), maxMb: max(d('totaalMb')),
      browserGemMb: gem(d('browserMb')), tabbladGemMb: gem(d('tabbladMb')), procesGemMb: gem(d('procesMb')),
      duurGemSec: gem(rs.map(r => (r.duurMs ?? 0) / 1000)),
    }
  }).sort((a, b) => b.somMb - a.somMb)

  const sprongen = taken
    .filter(r => Number.isFinite(r.verschil.totaalMb))
    .sort((a, b) => b.verschil.totaalMb - a.verschil.totaalMb)
    .slice(0, top)
    .map(r => ({ t: r.t, depot: r.depot, taak: r.taak, login: Boolean(r.login), duurSec: Math.round((r.duurMs ?? 0) / 1000), ...r.verschil, naMb: r.na?.totaalMb ?? null }))

  return { uren, taken: taakRijen, sprongen, minuten: minuten.length, taakregels: taken.length }
}
