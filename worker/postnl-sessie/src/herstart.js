// Vaste dagelijkse herstart van de sessiehouder (floatops/matransport#668). Puur, met test.
//
// Tot 10-11 herstartte hij alleen doordat de VPS hem na 19 uur stopte (`timeoutSec` in
// matransport worker/vps-server). Dat moment schoof elke dag op (10-11: 05:01, vlak voor de
// ochtendlezing) en kon zo midden in de ochtend van Plannen vallen. Nu stopt hij zelf, op een vast
// rustig moment ('s nachts, `dagelijkseHerstartOm`), na de lopende taak. De 19 uur is nu een
// vangnet van 26 uur, ruim boven een dag.
//
// Het proces stopt dan met exit 0: de wrapper houdt op en de bewaker-cron (elke 2 min) start hem
// opnieuw, met een vers logbestand voor de nieuwe dag (bij exit 42 bleef het oude logbestand open).
// Draait hij om die tijd, dan staat RVA aan voor de klant, en start de bewaker hem dus ook 's nachts.

// Minuut van de dag op de NL-wandklok.
export function nlMinuut(ms) {
  const delen = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms))
  const waarde = (soort) => Number(delen.find(d => d.type === soort)?.value)
  return waarde('hour') * 60 + waarde('minute')
}

// Moet het proces nu herstarten? Ja als het laatste herstartmoment (NL "HH:MM") minstens
// `minLooptijdMin` ná de start viel: start hij om 02:30 (na een crash), dan niet om 03:00 alweer een
// login, maar pas de nacht erna (ruim binnen het vangnet van 26 uur). Een gemist moment (een lange
// taak liep over 03:00) volgt gewoon na die taak.
export function dagelijkseHerstartNu({ nuMs, startMs, om, minLooptijdMin = 60 }) {
  const m = /^(\d{2}):(\d{2})$/.exec(String(om ?? ''))
  if (!m || !Number.isFinite(nuMs) || !Number.isFinite(startMs)) return false
  const omMin = Number(m[1]) * 60 + Number(m[2])
  const sindsOm = (nlMinuut(nuMs) - omMin + 1440) % 1440   // minuten sinds het laatste herstartmoment
  const laatsteOm = nuMs - sindsOm * 60_000 - (nuMs % 60_000)
  return laatsteOm - startMs >= minLooptijdMin * 60_000
}
