// Instellingen van de sessiehouder (floatops/matransport#562). Dit zijn de standaardwaarden; per
// klant kan elke waarde overschreven worden in de tabel `postnl_instellingen` (kolom
// `instellingen`, jsonb) zonder deploy. Tijden zijn NL-wandklok "HH:MM".
export const STANDAARD = Object.freeze({
  // Werktijden
  ochtendVanaf: '05:30',          // vanaf wanneer de nieuwe dag in PostNL staat
  ritmonitorUiterlijk: '08:00',   // vangnet: ritmonitor start hoe dan ook om deze tijd
  eindtijd: '23:00',              // daarna gaat de sessie dicht
  rustdagen: [0],                 // 0 = zondag
  ritmonitorIntervalSec: 60,
  hercontroleMin: 0,              // na de deadline: zo snel als het kan kijken of de shift geautoriseerd is (ondergrens in min)
  vangnetMin: 30,                 // na de deadline zonder autorisatie: toch definitief lezen
  naVangnetKijkenMin: 1440,       // na het vangnet blijven kijken tot de autorisatie (de hele dag), dan nog één keer lezen
  dagNietBeschikbaarWachtMin: 5,  // dag staat nog niet in PostNL: zo lang wachten
  // Sessie de hele werkdag open (eerste taak tot de eindtijd), ook als er even niets te doen is:
  // een planner-opdracht vóór de deadline hoeft dan nooit in te loggen. Verloopt hij toch, dan
  // logt de volgende taak in hetzelfde tabblad opnieuw in (naarDepot). Uit = sluitNaLeegMin.
  sessieOpenHouden: true,
  // In stille tijd elke zoveel minuten de Dagplanning opnieuw openen (taak 'wakker'): houdt de sessie
  // levend, en is hij toch verlopen, dan meteen opnieuw inloggen in hetzelfde tabblad, vóór een
  // planner-opdracht erop moet wachten. 0 = uit.
  wakkerHoudenMin: 10,
  // Plannen-tab vanzelf bijwerken (taak 'plannen'): per shift tot zijn deadline, zo snel als het kan
  // (eigenaar 03-11: geen vaste wachttijd; is al het andere gedaan, dan weer ritten of stops). Om de
  // beurt wat het langst geleden is; de shift die iemand in Plannen open heeft, gaat voor.
  // Alleen verschillen gaan naar de app. De minuten zijn een ondergrens (0 = meteen weer).
  plannenVerversen: true,
  plannenRittenMin: 0,
  plannenStopsMin: 0,
  plannenKijkerStopsMin: 0,
  plannenKijkerVoorsprongSec: 120,  // zoveel eerder aan de beurt dan de rest
  // RVA (Route Volgorde Applicatie, matransport#569): opdrachten uit de app in een tweede tabblad
  // van deze sessie, zelfde login. Standaard uit; per klant aanzetten in postnl_instellingen.
  // rvaAltijd: ook 's nachts en op zondag (de lus stopt dan niet). rvaWakkerMin: zo vaak het
  // Rittenoverzicht in het RVA-tabblad verversen, zodat de sessie leeft. Echt opslaan in RVA alleen
  // met RVA_ECHT=ja in de omgeving van de worker.
  rva: false,
  rvaAltijd: true,
  rvaWakkerMin: 10,
  sluitNaLeegMin: 10,             // zonder sessieOpenHouden: dicht als de volgende taak verder weg ligt
  // Herstel
  gegooidVensterMin: 2,           // twee keer eruit gegooid binnen dit venster = nieuwe login
  maxFoutenAchtereen: 3,          // zoveel gewone fouten achter elkaar = nieuwe login
  maxLoginsPerUur: 4,             // meer = pauze + melding (niet blijven hameren op PostNL)
  pauzeMin: 10,
  // Sessie
  slotLeaseSec: 180,              // lease van het sessie-slot; alleen verlengd na een geslaagde taak
  slotWachtMaxMin: 12,            // zo lang wachten op een ander (vangnet-script) dat het slot heeft
  contextWissel: true,            // nieuw videosegment met dezelfde cookies, geen login (gemeten 02-11: blijft ingelogd)
  segmentMin: 30,                 // videosegment
  browserVernieuwenUur: 4,
  levensduurMargeMin: 15,         // vóór een planner-opdracht: vernieuwen als de sessie zo dicht bij haar einde is
  codeCheckMin: 5,
  taakLimietSec: { ochtend: 900, definitief: 420, ritmonitor: 150, planner: 1500, depotUrl: 300, wakker: 120, plannen: 300, rva: 900, rvaWakker: 120 },
})

function isObject(v) { return v && typeof v === 'object' && !Array.isArray(v) }

// Standaard + wat de klant heeft ingesteld. Onbekende sleutels en verkeerde types vallen weg,
// zodat een tikfout in de database nooit de worker laat crashen.
export function mergeInstellingen(eigen, basis = STANDAARD) {
  const uit = {}
  for (const [k, standaard] of Object.entries(basis)) {
    const v = eigen?.[k]
    if (v === undefined || v === null) uit[k] = standaard
    else if (isObject(standaard)) uit[k] = mergeInstellingen(isObject(v) ? v : {}, standaard)
    else if (Array.isArray(standaard)) uit[k] = Array.isArray(v) ? v : standaard
    else if (typeof v === typeof standaard && (typeof v !== 'string' || /^\d{2}:\d{2}$/.test(v))) uit[k] = v
    else uit[k] = standaard
  }
  return uit
}

export function hhmmNaarMin(hhmm) {
  const [u, m] = String(hhmm).split(':').map(Number)
  return u * 60 + m
}
