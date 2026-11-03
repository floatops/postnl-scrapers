// Hoe lang blijft een PostNL-sessie geldig? Per tabblad gemeten (floatops/matransport#562).
//
// Moet de sessiehouder in een tabblad opnieuw inloggen terwijl dat tabblad al ingelogd was, dan heeft
// PostNL de sessie laten verlopen. De duur is de tijd sinds het vorige inloggen in dat tabblad;
// `stilMin` is de tijd sinds de laatste afgeronde taak in dat tabblad (verliep hij midden in het
// werk, of na een stille periode?). Een contextwissel (nieuw videosegment, zelfde cookies) zet de
// klok niet terug: dat is dezelfde sessie. Puur, zodat het met een nepklok te testen is.

export function maakLevensmeter({ tab, klok = () => Date.now() }) {
  let gestart = false
  let levendSinds = null
  let laatsteTaak = null
  return {
    get gestart() { return gestart },
    // Na het eerste geslaagde inloggen in dit tabblad: vanaf nu telt een nieuwe login als verloop.
    start() {
      if (gestart) return
      gestart = true
      levendSinds = klok()
      laatsteTaak = levendSinds
    },
    taakKlaar() { if (gestart) laatsteTaak = klok() },
    // Er wordt in dit tabblad ingelogd. Geeft een meting als het een verloop was, anders null.
    login({ taak = null } = {}) {
      if (!gestart) return null
      const nu = klok()
      const meting = {
        tab,
        duurMin: Math.round((nu - levendSinds) / 6000) / 10,
        stilMin: Math.round((nu - laatsteTaak) / 6000) / 10,
        taak,
      }
      levendSinds = nu
      laatsteTaak = nu
      return meting
    },
  }
}

// "3 u 12 min" voor het log.
export function duurTekst(min) {
  const m = Math.round(min)
  return m >= 60 ? `${Math.floor(m / 60)} u ${m % 60} min` : `${m} min`
}
