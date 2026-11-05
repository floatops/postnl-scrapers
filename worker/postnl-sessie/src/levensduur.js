// Hoe lang blijft een PostNL-sessie geldig? Gemeten, niet aangenomen (floatops/matransport#562).
//
// Gewone lezingen laten een sessie gewoon verlopen: zo meet elke dag zichzelf (einde_reden
// 'verlopen' in postnl_sessies). De schatting is het 10e percentiel van die duren, pas vanaf
// `minimum` metingen. Zonder schatting wordt er nooit vooraf vernieuwd.
//
// Minimum 5 (was 3, matransport#598): de twee "metingen" tot 05-11 (49 en 150 min) waren geen
// verlopen sessies maar een vastgelopen taak en een sessie die PostNL steeds introk, terwijl er
// ook sessies van 8 en 10 uur waren. Met nog één zo'n meting werd de schatting 49 min, en logde
// de sessiehouder vóór bijna elke planner-opdracht opnieuw in. Welke metingen meetellen:
// levensdurenUit in opslag.js.
export function schatLevensduur(durenMin, minimum = 5) {
  const d = durenMin.filter(x => Number.isFinite(x) && x > 0).sort((a, b) => a - b)
  if (d.length < minimum) return null
  return d[Math.floor((d.length - 1) * 0.1)]
}

// Vóór een schrijvende taak (planner): eerst een verse sessie als deze te dicht bij haar einde zit.
export function moetVernieuwen({ leeftijdMin, schattingMin, margeMin = 15 }) {
  if (schattingMin === null || schattingMin === undefined) return false
  return leeftijdMin >= schattingMin - margeMin
}
