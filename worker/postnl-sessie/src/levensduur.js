// Hoe lang blijft een PostNL-sessie geldig? Gemeten, niet aangenomen (floatops/matransport#562).
//
// Gewone lezingen laten een sessie gewoon verlopen: zo meet elke dag zichzelf (einde_reden
// 'verlopen' in postnl_sessies). De schatting is het 10e percentiel van die duren, pas vanaf
// `minimum` metingen. Zonder schatting wordt er nooit vooraf vernieuwd.

export function schatLevensduur(durenMin, minimum = 3) {
  const d = durenMin.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  if (d.length < minimum) return null
  return d[Math.floor((d.length - 1) * 0.1)]
}

// Vóór een schrijvende taak (planner): eerst een verse sessie als deze te dicht bij haar einde zit.
export function moetVernieuwen({ leeftijdMin, schattingMin, margeMin = 15 }) {
  if (schattingMin === null || schattingMin === undefined) return false
  return leeftijdMin >= schattingMin - margeMin
}
