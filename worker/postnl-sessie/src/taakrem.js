// Fouten per taak tellen (floatops/matransport#598). Puur.
//
// Waarom: het herstel in gezondheid.js telt fouten achter elkaar over alle taken heen. Lukt de
// ritmonitor tussendoor wel, dan begint die telling steeds opnieuw. Op 05-11 mislukte Plannen bij
// Den Hoorn zo 243 keer achter elkaar (07:10–09:52) zonder één melding en zonder nieuwe login,
// terwijl precies die nieuwe login het had opgelost (#592).
//
// Per taak (niet op aanvraag: een planner- of RVA-opdracht heeft zijn eigen afhandeling):
// - `maxFoutenAchtereen` keer achter elkaar een gewone fout → één keer een nieuwe login;
// - vanaf `taakFoutenRem` keer achter elkaar mislukt → de taak wacht steeds langer (1, 2, 4, 8 …
//   tot `taakRemMaxMin` minuten) en er komt één melding `taak_faalt` met de laatste fout;
// - één keer gelukt → de telling van die taak begint opnieuw.

const MIN = 60_000

// Soorten die als mislukt tellen. 'database' niet: dan ligt het niet aan PostNL of de sessie.
const MISLUKT = new Set(['fout', 'gegooid', 'herlogin', 'verlopen', 'browser_weg', 'blokkade'])

export function naTaak(stand, { taak, opAanvraag = false, soort, fout = null, nu, cfg }) {
  if (opAanvraag) return { stand, nieuweLogin: false, melding: null }
  const vorige = stand[taak] ?? { n: 0, gewoon: 0 }
  if (soort === 'gezond') {
    if (!vorige.n) return { stand, nieuweLogin: false, melding: null }
    const { [taak]: _, ...rest } = stand
    return { stand: rest, nieuweLogin: false, melding: null }
  }
  if (!MISLUKT.has(soort)) return { stand, nieuweLogin: false, melding: null }

  const n = vorige.n + 1
  // Alleen gewone fouten tellen voor een nieuwe login: bij verlopen/blokkade/browser_weg logt het
  // herstel al opnieuw in, en bij gegooid/herlogin is de sessie zelf in orde.
  const gewoon = soort === 'fout' ? vorige.gewoon + 1 : vorige.gewoon
  const nieuweLogin = soort === 'fout' && gewoon === cfg.maxFoutenAchtereen
  let tot = null
  let melding = null
  if (n >= cfg.taakFoutenRem) {
    const wachtMin = Math.min(2 ** (n - cfg.taakFoutenRem), cfg.taakRemMaxMin)
    tot = new Date(nu.getTime() + wachtMin * MIN).toISOString()
    if (n === cfg.taakFoutenRem) {
      melding = { soort: 'taak_faalt', detail: `${taak} ${n}x achter elkaar mislukt; wacht nu steeds langer (tot ${cfg.taakRemMaxMin} min). Laatste fout: ${String(fout?.message ?? soort).split('\n')[0].slice(0, 200)}` }
    }
  }
  return { stand: { ...stand, [taak]: { n, gewoon, tot } }, nieuweLogin, melding }
}

// Het takenregister met de rem erin: een taak die nu zou mogen maar geremd is, komt pas om
// `tot` weer aan de beurt. De rest van de rij (rij.js) blijft gewoon werken.
export function remTaken(taken, stand, nu) {
  const geremd = Object.entries(stand).filter(([, s]) => s.tot && new Date(s.tot) > nu)
  if (!geremd.length) return taken
  const tot = new Map(geremd.map(([naam, s]) => [naam, new Date(s.tot)]))
  return taken.map(t => {
    if (t.opAanvraag || !tot.has(t.naam)) return t
    return { ...t, volgende: (dag, n, cfg) => {
      const v = t.volgende(dag, n, cfg)
      return v?.nu ? { om: tot.get(t.naam) } : v
    } }
  })
}
