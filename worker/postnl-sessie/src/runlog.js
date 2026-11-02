// De ritmonitor-lezingen van de sessiehouder samengevat in worker_run_log (floatops/matransport#562).
// Eén rij per 7 minuten onder de naam `postnl-ritmonitor`, met per depot het aantal lezingen en
// welke depots 0 ritten zonder bevestiging gaven. Zo blijven de bestaande wachtdogs
// (check_worker_staleness, check_ritmonitor_eindtijd) en de koppelingsbadge werken zoals bij het
// losse script, dat elke 7 minuten één rij schreef.

export function samenvatting(depots, perDepot) {
  const lezingen = {}
  const mislukt = []
  const leegOnbevestigd = []
  let rijen = 0
  for (const d of depots) {
    const p = perDepot[d]
    if (!p) continue
    lezingen[d] = p.ok
    rijen += p.maxRijen
    if (p.ok === 0 && p.fouten.length) mislukt.push({ depot: d, fout: p.fouten.at(-1) })
    if (p.ok > 0 && p.maxRijen === 0 && !p.leegBevestigd) leegOnbevestigd.push(d)
    if (p.ok === 0) leegOnbevestigd.push(d)
  }
  const actief = Object.keys(lezingen)
  if (!actief.length) return null
  const status = mislukt.length === actief.length ? 'mislukt' : mislukt.length ? 'deels_mislukt' : 'ok'
  return {
    status, depots_ok: actief.length - mislukt.length, depots_mislukt: mislukt.length ? mislukt : null,
    rijen_gelezen: rijen, lezingen, leeg_onbevestigd: [...new Set(leegOnbevestigd)],
    ...(status === 'mislukt' ? { foutmelding: `Alle depots faalden: ${mislukt.map(m => `${m.depot} (${m.fout})`).join('; ')}` } : {}),
  }
}

export function maakRitmonitorTeller({ opslag, depots, log, intervalMs = 7 * 60_000 }) {
  let perDepot = {}
  let runId = null
  const timer = setInterval(() => { flush().catch(e => log.error(`Ritmonitor-run schrijven mislukt: ${e.message}`)) }, intervalMs)

  async function flush() {
    const s = samenvatting(depots, perDepot)
    perDepot = {}
    if (!s) return
    const id = runId ?? await opslag.runStart('postnl-ritmonitor')
    runId = null
    await opslag.runEinde(id, s)
  }

  return {
    tel(depot, { ok, rijen = 0, leegBevestigd = false, fout = null }) {
      const p = perDepot[depot] ??= { ok: 0, maxRijen: 0, leegBevestigd: false, fouten: [] }
      if (ok) { p.ok++; p.maxRijen = Math.max(p.maxRijen, rijen); p.leegBevestigd = p.leegBevestigd || leegBevestigd }
      else p.fouten.push(String(fout ?? 'onbekend').slice(0, 200))
    },
    flush,
    stop() { clearInterval(timer) },
  }
}
