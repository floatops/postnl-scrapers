// Welke depots krijgen een sessie, welke loggen opnieuw in, welke stoppen? Puur (floatops/matransport#562).
//
// Een PostNL-login toevoegen, wijzigen, uitzetten of verwijderen op Instellingen → Inloggegevens
// geeft via de database-trigger postnl_sessie_koppeling een seintje aan de sessiehouder (de VPS
// raakt het wekkerbestand aan). Die leest dan de depots opnieuw uit de database (géén PostNL-
// login) en vergelijkt per depot een vingerafdruk van naam, URL en login:
//   starten     nieuw depot: één login, één tabblad
//   herstarten  URL, gebruikersnaam of wachtwoord gewijzigd: sessie dicht, opnieuw inloggen
//   stoppen     depot uitgezet of verwijderd: sessie dicht
// Lopende depots zonder wijziging blijven in hun sessie.
import { createHash } from 'node:crypto'

export function vingerafdruk(depot) {
  return createHash('sha256').update([depot.naam, depot.url, depot.username, depot.password].map(x => String(x ?? '')).join('\n')).digest('hex').slice(0, 16)
}

// lopend: Map naam → vingerafdruk van de lopende sessies. uitDatabase: getDepots().
export function depotWijzigingen(lopend, uitDatabase) {
  const starten = []
  const herstarten = []
  const gezien = new Set()
  for (const d of uitDatabase ?? []) {
    if (!d?.naam || !d.url || gezien.has(d.naam)) continue
    gezien.add(d.naam)
    if (!lopend.has(d.naam)) starten.push(d)
    else if (lopend.get(d.naam) !== vingerafdruk(d)) herstarten.push(d)
  }
  const stoppen = [...lopend.keys()].filter(n => !gezien.has(n))
  return { starten, herstarten, stoppen }
}

// Beheer van de lopende depot-lussen. `startLus(depot, lus)` start de lus en geeft een promise die
// eindigt als de lus stopt (de lus kijkt zelf naar `lus.stop`). Los van de browser, zodat het te
// testen is (test/planning.test.mjs).
export function maakDepotBeheer({ startLus, log = console, isGestopt = () => false }) {
  const lopend = new Map()   // naam → { vingerafdruk, stop, klaar }
  let herstartsBezig = 0

  const start = (depot) => {
    if (lopend.has(depot.naam)) return
    const lus = { vingerafdruk: vingerafdruk(depot), stop: false }
    lus.klaar = Promise.resolve()
      .then(() => startLus(depot, lus))
      .catch(() => {})
      .finally(() => { if (lopend.get(depot.naam) === lus) lopend.delete(depot.naam) })
    lopend.set(depot.naam, lus)
  }

  const verwerk = (uitDatabase, reden) => {
    if (isGestopt()) return { starten: [], herstarten: [], stoppen: [] }
    const w = depotWijzigingen(new Map([...lopend].map(([n, l]) => [n, l.vingerafdruk])), uitDatabase)
    for (const naam of w.stoppen) {
      log.log(`[${naam}] Login uitgezet of verwijderd (${reden}): sessie stopt`)
      lopend.get(naam).stop = true
    }
    for (const d of w.herstarten) {
      log.log(`[${d.naam}] Login gewijzigd (${reden}): opnieuw inloggen`)
      const oud = lopend.get(d.naam)
      oud.stop = true
      herstartsBezig++
      oud.klaar.finally(() => { herstartsBezig--; if (!isGestopt()) start(d) })
    }
    for (const d of w.starten) { log.log(`[${d.naam}] Nieuw depot (${reden}): eigen sessie`); start(d) }
    return w
  }

  // Tot alle lussen klaar zijn, ook die er onderweg bij kwamen of opnieuw startten.
  const wacht = async (pollMs = 1000) => {
    while (lopend.size || herstartsBezig) await new Promise(r => setTimeout(r, pollMs))
  }

  return { verwerk, wacht, lopend, get herstartsBezig() { return herstartsBezig } }
}
