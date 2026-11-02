// Mendix /xas/-antwoorden lezen. Puur: geen browser, geen database.
//
// Mendix zet objecten per actie onder een andere sleutel (objects, partialObjects, mxobjects),
// nest gekoppelde objecten in de attribuutwaarde (RideNumber → Ride → Driver), en sommige
// waarden staan alleen in `changes` (per guid). Herken data aan `objectType`, nooit aan
// operationId: die code verandert bij elke PostNL-release.

// Alle objecten van één type in één antwoord. Een koppeling wordt de guid van het andere object.
export function objectenUit(antwoord, objectType) {
  if (!antwoord) return []
  const perGuid = new Map()
  const bezoek = (o) => {
    if (!o?.objectType || !o.guid) return
    const waarden = {}
    for (const [k, v] of Object.entries(o.attributes ?? {})) {
      const w = v?.value
      if (w && typeof w === 'object' && w.objectType) {
        bezoek(w)
        waarden[k] = w.guid
      } else {
        waarden[k] = w ?? null
      }
    }
    if (o.objectType !== objectType) return
    for (const [k, v] of Object.entries(antwoord.changes?.[o.guid] ?? {})) waarden[k] = v?.value ?? null
    perGuid.set(o.guid, { guid: o.guid, ...(perGuid.get(o.guid) ?? {}), ...waarden })
  }
  for (const o of [...(antwoord.objects ?? []), ...(antwoord.partialObjects ?? []), ...(antwoord.mxobjects ?? [])]) bezoek(o)
  return [...perGuid.values()]
}

// Objecten van één type over meerdere antwoorden, per guid samengevoegd. Een later antwoord
// vult aan of overschrijft; een attribuut dat ontbreekt blijft wat het was.
export function objectenOver(antwoorden, objectType) {
  const perGuid = new Map()
  for (const a of antwoorden) {
    for (const o of objectenUit(a, objectType)) perGuid.set(o.guid, { ...(perGuid.get(o.guid) ?? {}), ...o })
  }
  return perGuid
}

// Meldingen die PostNL de gebruiker toont (achtergrondtaak en gewone acties).
export function meldingenUit(antwoord) {
  return (antwoord?.instructions ?? [])
    .filter(i => i?.type === 'text_message' && i.args?.MessageContent)
    .map(i => ({ tekst: i.args.MessageContent, soort: i.args.MessageType ?? 'info' }))
}
