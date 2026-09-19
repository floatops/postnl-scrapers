// Neutrale logs voor een publieke repo.
//
// Deze repo is bewust publiek (gratis Actions-minuten), dus iedereen kan de run-logs
// lezen. Met één klant was dat onschuldig; met meerdere klanten zou uit depotnamen,
// portaal-URL's en foutmeldingen publiek af te leiden zijn welke bedrijven FloatOps
// gebruiken. Besluit eigenaar 2026-09-19: publiek houden en de logs neutraal maken
// (alternatief was privé maken, ~3.500 Actions-minuten per klant per maand).
//
// Aanpak: één keer per run de console zelf filteren, i.p.v. elk van de ~60 logregels
// los aanpassen — dan is ook een logregel die iemand later toevoegt vanzelf neutraal.
// Wat er gemaskeerd wordt:
//   - depotnamen → een stabiele korte code (`D-3f2a`), afgeleid van klant + naam. De
//     echte namen staan in worker_run_log (privé), dus intern altijd te herleiden.
//   - gebruikersnamen van de portaal-logins → `<login>`
//   - elke URL → `<url>` (de portaal-URL bevat de depot-code van PostNL)
//   - Error-objecten → alleen de eerste regel van de melding, gemaskeerd; geen stack
//     (de volledige fout staat al in worker_run_log.foutmelding)
// Alleen actief in GitHub Actions (GITHUB_ACTIONS=true). Lokaal blijft alles leesbaar.

import crypto from 'node:crypto'

export function depotCode(klantId, depotNaam) {
  const h = crypto.createHash('sha256').update(`${klantId ?? ''}|${depotNaam ?? ''}`).digest('hex')
  return `D-${h.slice(0, 4)}`
}

function maakMasker(klantId, depots) {
  // Langste namen eerst, zodat "Den Hoorn Noord" niet eerst als "Den Hoorn" matcht.
  const namen = depots.map(d => d.naam).filter(Boolean).sort((a, b) => b.length - a.length)
  const logins = depots.map(d => d.username).filter(Boolean).sort((a, b) => b.length - a.length)
  const ontsnap = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const naamRegex = namen.length ? new RegExp(namen.map(ontsnap).join('|'), 'gi') : null
  const loginRegex = logins.length ? new RegExp(logins.map(ontsnap).join('|'), 'g') : null
  const codes = Object.fromEntries(namen.map(n => [n.toLowerCase(), depotCode(klantId, n)]))

  return function maskeer(tekst) {
    let t = String(tekst)
    t = t.replace(/https?:\/\/[^\s"'`)\]]+/g, '<url>')
    if (loginRegex) t = t.replace(loginRegex, '<login>')
    if (naamRegex) t = t.replace(naamRegex, (m) => codes[m.toLowerCase()] ?? 'D-????')
    return t
  }
}

function naarTekst(arg, maskeer) {
  if (arg instanceof Error) return maskeer(arg.message.split('\n')[0])
  if (typeof arg === 'string') return maskeer(arg)
  if (arg === null || arg === undefined || typeof arg !== 'object') return maskeer(String(arg))
  try { return maskeer(JSON.stringify(arg)) } catch { return '<object>' }
}

/**
 * Filtert console.log/warn/error voor de rest van dit proces. Aanroepen zodra de
 * depots bekend zijn (na getDepots), vóór het eerste log dat een depot noemt.
 * Geeft de maskeerfunctie terug, voor plekken die zelf tekst samenstellen.
 */
export function installeerNeutraleConsole({ klantId, depots = [], forceer = false }) {
  const maskeer = maakMasker(klantId, depots)
  if (!forceer && process.env.GITHUB_ACTIONS !== 'true') return maskeer
  for (const niveau of ['log', 'warn', 'error', 'info']) {
    const origineel = console[niveau].bind(console)
    console[niveau] = (...args) => origineel(...args.map(a => naarTekst(a, maskeer)))
  }
  console.log(`Publieke log: depotnamen en URL's gemaskeerd (${depots.length} depot(s) → ${depots.map(d => depotCode(klantId, d.naam)).join(', ') || 'geen'})`)
  return maskeer
}
