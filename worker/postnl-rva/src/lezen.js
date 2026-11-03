// Mendix-antwoorden van RVA (Route Volgorde Applicatie) lezen. Puur: geen browser, geen database.
// Uitleg van het datamodel: ../POSTNL_RVA.md. Herken data aan objectType, nooit aan operationId.
import { objectenUit, objectenOver, meldingenUit } from '../../credentials-shared/src/postnl/mendix.js'

const T = {
  trip: 'PlanningData.Trip',
  ritDag: 'PlanningData.TripWeekday',
  regel: 'PlanningData.SequenceAddress',
  revisie: 'PlanningData.Snapshot',
  onderbreking: 'PlanningData.TripBreak',
  account: 'UMConnectorImplementation.Account',
}

export const WEEKDAGEN = ['Ma', 'Di', 'Wo', 'Do', 'Vr', 'Za']
const ENGELS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
// TripWeekday.WeekDay: E01_MONDAY … E06_SATURDAY
export const weekdagVanEnum = (w) => WEEKDAGEN[Number(String(w ?? '').match(/^E0(\d)/)?.[1]) - 1] ?? null

const getal = (v) => (v == null || v === '' ? null : Number(v))
const evenOneven = (v) => (v === 'Odd' ? 'Oneven' : v === 'Even' ? 'Even' : v ?? null)

// Eén regel in de vorm die ook het scherm oplevert (scherm.js → leesRegels), zodat beide te vergelijken zijn.
export function regelVan(o) {
  return {
    volgorde: getal(o.SequenceNumber),
    postcode: o.PostalCode ?? null,
    plaats: o.City ?? null,
    straat: o.Street ?? null,
    van: getal(o.HouseNumberFrom),
    tm: getal(o.HouseNumberTo),
    evenOneven: evenOneven(o.EvenOdd),
    richting: o.HouseNumberSequence ?? null,
    geknipt: o.IsSplit === true,
  }
}

const opVolgorde = (a, b) => (a.volgorde ?? 0) - (b.volgorde ?? 0)

// De regels van één rit-dag uit één antwoord (het antwoord op het openen of opslaan).
export function regelsUit(antwoord, ritDagGuid = null) {
  return objectenUit(antwoord, T.regel)
    .filter(o => !ritDagGuid || o['PlanningData.SequenceAddress_TripWeekday'] === ritDagGuid)
    .filter(o => o.ToDelete !== true)
    .map(regelVan)
    .sort(opVolgorde)
}

// De laatste stand van een rit-dag: slot, weekdag, laatst gewijzigd.
export function ritDagUit(antwoorden, guid = null) {
  const alle = [...objectenOver(antwoorden, T.ritDag).values()]
  const o = guid ? alle.find(x => x.guid === guid) : alle.at(-1)
  if (!o) return null
  return {
    guid: o.guid,
    route: o.RouteName ?? null,
    weekdag: weekdagVanEnum(o.WeekDay),
    trip: o['PlanningData.TripWeekday_Trip'] ?? null,
    vergrendeld: o.IsLocked === true,
    vergrendeldDoor: o.LockedBy ?? null,
    laatstGewijzigd: getal(o.LastModified),
  }
}

// Ritten uit het Rittenoverzicht: nummer, naam, dagen en verantwoordelijken (namen via de accounts).
export function rittenUit(antwoorden) {
  const accounts = objectenOver(antwoorden, T.account)
  const naam = (g) => accounts.get(g)?.FullName ?? null
  return [...objectenOver(antwoorden, T.trip).values()].map(o => ({
    guid: o.guid,
    nummer: o.TripNumber ?? null,
    naam: o.Name ?? null,
    dagen: WEEKDAGEN.filter((_, i) => o[ENGELS[i]] === true),
    verantwoordelijken: (Array.isArray(o['PlanningData.Trip_Responsible']) ? o['PlanningData.Trip_Responsible'] : []).map(g => naam(g) ?? g),
  }))
}

// Revisies van een rit-dag, nieuwste eerst. De inhoud (Payload) is JSON met SequenceAddresses.
// Onderbrekingen zitten er niet in: een revisie terugzetten haalt een onderbreking dus niet weg.
export function revisiesUit(antwoorden, ritDagGuid = null) {
  return [...objectenOver(antwoorden, T.revisie).values()]
    .filter(o => !ritDagGuid || o['PlanningData.Snapshot_TripWeekday'] === ritDagGuid)
    .map(o => {
      let regels = null
      try {
        const p = JSON.parse(o.Payload)
        regels = (p?.SequenceAddresses ?? []).map(r => regelVan(Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v == null ? v : String(v)])))).sort(opVolgorde)
      } catch { regels = null }
      return { guid: o.guid, gemaaktOp: getal(o.CreatedAt), door: o.CreatedBy ?? null, actief: o.IsActive === true, regels }
    })
    .sort((a, b) => (b.gemaaktOp ?? 0) - (a.gemaaktOp ?? 0))
}

export function onderbrekingenUit(antwoorden) {
  return [...objectenOver(antwoorden, T.onderbreking).values()]
    .filter(o => o.FE_IsDeleted !== true && o.BreakType)
    .map(o => ({ guid: o.guid, soort: o.BreakType, minuten: getal(o.Minutes), naRegel: o['PlanningData.TripBreak_Placebound_SequenceAddress'] ?? null }))
}

// Meldingen van PostNL uit een reeks antwoorden, zonder dubbele.
export function meldingenOver(antwoorden) {
  const gezien = new Set()
  return antwoorden.flatMap(meldingenUit).filter(m => !gezien.has(m.tekst) && gezien.add(m.tekst))
}
