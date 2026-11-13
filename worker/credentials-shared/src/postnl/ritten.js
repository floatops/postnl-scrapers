// De ritten van de Dagplanning uit de Mendix-antwoorden (floatops/matransport#562). Vervangt het
// lezen van het scherm (`leesShift` in postnl-dagplanning): PostNL stuurt elke waarde die het
// scherm toont ook als data mee, plus wat het scherm niet toont (autorisatie, RideID met kanaal).
import { objectenOver } from './mendix.js'
import { veldenUit } from './velden.js'
import { normaliseerRitnummer, ritIdDelen, shiftCode } from './tekst.js'

const T = {
  rit: 'OperationalPlanning.Ride',
  nummer: 'OperationalPlanning.RideNumber',
  chauffeur: 'Planning.Driver',
  shift: 'OperationalPlanning.Shift',
  scherm: 'OperationalPlanning.DisplayPlanning',
  kanaal: 'Planning.DistributionChannel',
}

// Het kanaal dat het Dagplanning-scherm toont (HD, AD, …), uit de data van PostNL zelf.
// Alleen als het eenduidig is; anders null.
export function schermKanaal(antwoorden) {
  const kanalen = objectenOver(antwoorden, T.kanaal)
  const gekozen = new Set([...objectenOver(antwoorden, T.scherm).values()]
    .map(d => kanalen.get(d['OperationalPlanning.DisplayPlanning_DistributionChannel'])?.DistributionChannelID)
    .filter(Boolean))
  if (gekozen.size === 1) return [...gekozen][0]
  const alle = new Set([...kanalen.values()].map(k => k.DistributionChannelID).filter(Boolean))
  return alle.size === 1 ? [...alle][0] : null
}

// Eén rij per rit: { rit_id, ritnummer, kanaal, datum, shift, shiftPostnl, geautoriseerd, velden }.
// `velden` bevat alleen kolommen die PostNL in deze antwoorden meestuurde. Het kanaal komt uit de
// RideID, anders uit het kanaal van het scherm; is dat ook onbekend, dan is `kanaal` null en
// schrijft de schrijver de rit niet (een gok tussen HD en AD gaf #560).
// `negeer`: guids van ritten die bij een andere dag horen (dagVenster in dagplanningScherm.js).
export function dagplanningRitten(antwoorden, { negeer = new Set() } = {}) {
  const kanaalScherm = schermKanaal(antwoorden)
  const ritten = objectenOver(antwoorden, T.rit)
  const nummers = objectenOver(antwoorden, T.nummer)
  const chauffeurs = objectenOver(antwoorden, T.chauffeur)
  const shifts = objectenOver(antwoorden, T.shift)

  const uit = new Map()
  for (const n of nummers.values()) {
    const rit = ritten.get(n['OperationalPlanning.RideNumber_Ride'])
    if (!rit || negeer.has(rit.guid) || negeer.has(n.guid)) continue
    const delen = ritIdDelen(rit.RideID ?? n.RideID)
    const ritnummer = delen?.ritnummer ?? normaliseerRitnummer(rit.RideName)
    if (!ritnummer) continue
    const chauffeurGuid = rit['OperationalPlanning.OperationalRide_Driver']
    const ctx = {
      ritnummer,
      RideNumber: n,
      Ride: rit,
      // Geen chauffeur gekoppeld = leeg; een gekoppelde die niet in de antwoorden stond = onbekend.
      Driver: chauffeurGuid === null ? { guid: null, LastNameInitials: null } : chauffeurs.get(chauffeurGuid),
      Shift: shifts.get(rit['OperationalPlanning.Ride_Shift'] ?? n['OperationalPlanning.RideNumber_Shift']),
    }
    const velden = veldenUit(ctx)
    uit.set(rit.guid, {
      rit_id: rit.guid,
      ritnummer,
      kanaal: delen?.kanaal ?? kanaalScherm,
      datum: delen?.datum ?? null,
      shift: velden.postnl_shift ?? null,
      shiftPostnl: shiftCode(ctx.Shift?.Name),
      geautoriseerd: velden.postnl_geautoriseerd ?? null,
      velden,
    })
  }
  return [...uit.values()].sort((a, b) => Number(a.ritnummer) - Number(b.ritnummer))
}

// Shifts zoals PostNL ze die dag toont, op naam ("01", "03", …). Niets vast in de code.
export function shiftsUit(antwoorden) {
  return [...new Set([...objectenOver(antwoorden, T.shift).values()].map(s => s.Name).filter(Boolean))].sort()
}

// Hoort deze rit bij de shift ("01", "07", ...)? Volgens PostNL als het antwoord de shift meestuurt;
// anders het eerste cijfer van het ritnummer (114 → 1, 703 → 7). Op 03-11 stuurde PostNL de shift
// bij geen enkele rit mee, waardoor elke shift leeg leek en een autorisatie nooit gezien werd.
export function hoortBijShift(rit, shift) {
  const s = String(parseInt(shift, 10))
  return (rit.shiftPostnl ?? rit.shift) === s
}
