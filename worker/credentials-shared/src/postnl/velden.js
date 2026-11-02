// Welke PostNL-waarde in welke kolom van `ritten` komt: één lijst, gebruikt door de lezer en de
// schrijver (floatops/matransport#562). Een nieuw veld is één regel hier, geen nieuwe code.
//
// `object` is het Mendix-object waar de waarde staat (zie POSTNL_SESSIE.md § Mendix-objecten):
//   RideNumber  totalen van een rit (Stops, Pieces, Volume, Weight, MailboxOnlyStops, TotalRideTime)
//   Ride        de rit zelf (RideName, RideID, Authorized, …)
//   Driver      de chauffeur van de rit (LastNameInitials)
//   Shift       de shift van de rit (Name)
// `lees` krijgt { ritnummer, RideNumber, Ride, Driver, Shift } en geeft de waarde, of `undefined` als
// PostNL hem in deze antwoorden niet meestuurde: dan blijft de kolom zoals hij was.
// `nieuw: true` = kolom die pas na matransport-migratie bestaat; de schrijver laat hem weg tot
// die kolom er is (zie schrijver.js, `kolommen`).
import { decimaalTekst, geheel, normaliseerDuur, tekst } from './tekst.js'

const attr = (object, naam, zet) => (ctx) => {
  const o = ctx[object]
  if (!o || !(naam in o)) return undefined
  return zet(o[naam])
}

const geautoriseerd = (ctx) => {
  const r = ctx.Ride
  if (!r) return undefined
  if (r.Authorized === true || r.Enum_Authorized === '_True') return true
  if (r.Authorized === false || r.Enum_Authorized === '_False') return false
  return undefined
}

export const RIT_VELDEN = [
  { kolom: 'postnl_stops',         lees: attr('RideNumber', 'Stops', geheel) },
  { kolom: 'postnl_stuks',         lees: attr('RideNumber', 'Pieces', geheel) },
  { kolom: 'postnl_volume',        lees: attr('RideNumber', 'Volume', decimaalTekst) },
  { kolom: 'postnl_gewicht',       lees: attr('RideNumber', 'Weight', decimaalTekst) },
  { kolom: 'postnl_briefbusstops', lees: attr('RideNumber', 'MailboxOnlyStops', geheel) },
  { kolom: 'postnl_geplande_duur', lees: attr('RideNumber', 'TotalRideTime', normaliseerDuur) },
  { kolom: 'postnl_ritnaam',       lees: attr('Ride', 'RideName', tekst) },
  { kolom: 'postnl_chauffeur',     lees: attr('Driver', 'LastNameInitials', tekst) },
  // Zoals de dagplanning het altijd deed: het eerste cijfer van het ritnummer (114 → "1",
  // 9xx → "9" voor reserve). Daar rekenen shift_tijden en de reserve-regel van de ritmonitor op.
  // De shift volgens PostNL zelf geeft dagplanningRitten() apart terug (`shiftPostnl`).
  { kolom: 'postnl_shift',         lees: (ctx) => (ctx.ritnummer ? ctx.ritnummer.charAt(0) : undefined) },
  { kolom: 'postnl_rit_id',        lees: attr('Ride', 'guid', tekst), nieuw: true },
  { kolom: 'postnl_geautoriseerd', lees: geautoriseerd, nieuw: true },
]

export function veldenUit(ctx, velden = RIT_VELDEN) {
  const uit = {}
  for (const v of velden) {
    const waarde = v.lees(ctx)
    if (waarde !== undefined) uit[v.kolom] = waarde
  }
  return uit
}

export const NIEUWE_KOLOMMEN = RIT_VELDEN.filter(v => v.nieuw).map(v => v.kolom)
