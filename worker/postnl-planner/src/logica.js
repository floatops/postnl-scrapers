// Pure logica van de planner: Mendix-antwoorden lezen en omzetten. Geen browser, geen database.

const TIJDZONE = 'Europe/Amsterdam'

// Alle objecten in een /xas/-antwoord, op type. Mendix zet ze per actie onder een andere
// sleutel, en sommige attribuutwaarden staan alleen in `changes` (per guid).
export function objectenUit(antwoord, objectType) {
  if (!antwoord) return []
  const lijst = [...(antwoord.objects ?? []), ...(antwoord.partialObjects ?? []), ...(antwoord.mxobjects ?? [])]
  const perGuid = new Map()
  for (const o of lijst) {
    if (o?.objectType !== objectType) continue
    const waarden = {}
    for (const [k, v] of Object.entries(o.attributes ?? {})) waarden[k] = v?.value ?? null
    for (const [k, v] of Object.entries(antwoord.changes?.[o.guid] ?? {})) waarden[k] = v?.value ?? null
    perGuid.set(o.guid, { guid: o.guid, ...(perGuid.get(o.guid) ?? {}), ...waarden })
  }
  return [...perGuid.values()]
}

// Meldingen die PostNL de gebruiker toont (achtergrondtaak en gewone acties).
export function meldingenUit(antwoord) {
  return (antwoord?.instructions ?? [])
    .filter(i => i?.type === 'text_message' && i.args?.MessageContent)
    .map(i => ({ tekst: i.args.MessageContent, soort: i.args.MessageType ?? 'info' }))
}

// Eén melding, ook als hij dubbel binnenkomt (actie + poll_background_job).
export function uniekeMeldingen(antwoorden) {
  const gezien = new Map()
  for (const a of antwoorden) for (const m of meldingenUit(a)) gezien.set(m.tekst, m)
  return [...gezien.values()]
}

// Telt dit als weigering? PostNL gebruikt warning en error; info is geen fout.
export function isWeigering(melding) {
  return melding.soort === 'warning' || melding.soort === 'error'
}

function offsetVoor(datum, uur, minuut) {
  const benadering = new Date(Date.UTC(+datum.slice(0, 4), +datum.slice(5, 7) - 1, +datum.slice(8, 10), uur, minuut))
  const deel = new Intl.DateTimeFormat('en-US', { timeZone: TIJDZONE, timeZoneName: 'longOffset' })
    .formatToParts(benadering).find(p => p.type === 'timeZoneName').value
  const m = deel.match(/GMT([+-])(\d{2}):(\d{2})/)
  return m ? `${m[1]}${m[2]}:${m[3]}` : '+00:00'
}

// "Ritten kunnen tot 07:15 uur worden aangepast." + datum → ISO-tijdstip, of null.
// De tekst op de pagina is de officiële bron: de deadline wordt nooit zelf berekend.
export function deadlineUitTekst(tekst, datum) {
  const m = String(tekst ?? '').match(/kunnen tot\s+(\d{1,2}):(\d{2})\s+uur/i)
  if (!m || !/^\d{4}-\d{2}-\d{2}$/.test(datum)) return null
  const uur = +m[1]
  const minuut = +m[2]
  if (uur > 23 || minuut > 59) return null
  const hhmm = `${String(uur).padStart(2, '0')}:${m[2]}`
  return new Date(`${datum}T${hhmm}:00${offsetVoor(datum, uur, minuut)}`).toISOString()
}

export function getal(waarde) {
  if (waarde === null || waarde === undefined || waarde === '') return 0
  const n = Number(String(waarde).replace(',', '.'))
  return Number.isFinite(n) ? n : 0
}

function tekst(waarde) {
  const t = String(waarde ?? '').trim()
  return t || null
}

// Voor de app: alleen wat daar getoond wordt. Verder niets, het zijn adressen.
export function stopNaarRij(stop, { klantId, depot, datum, shift, opgehaaldAt }) {
  return {
    klant_id: klantId, depot, datum, shift,
    rit_id: stop.RideID,
    stop_id: stop.StopID,
    straat: tekst(stop.Street) ?? '(onbekend)',
    huisnummer: tekst(stop.BuildingNumber),
    toevoeging: tekst(stop.BuildingNumberExtension),
    stuks: Math.round(getal(stop.Pieces)),
    volume: getal(stop.Volume),
    opgehaald_at: opgehaaldAt,
  }
}

// Ritten van een shift: Ride (status) + RideNumber (totalen, verwijst naar de Ride).
export function rittenUit(antwoorden) {
  const ritten = new Map()
  const nummers = new Map()
  const chauffeurs = new Map()
  for (const a of antwoorden) {
    for (const d of objectenUit(a, 'Planning.Driver')) chauffeurs.set(d.guid, d)
    for (const r of objectenUit(a, 'OperationalPlanning.Ride')) ritten.set(r.guid, { ...(ritten.get(r.guid) ?? {}), ...r })
    for (const n of objectenUit(a, 'OperationalPlanning.RideNumber')) nummers.set(n.guid, { ...(nummers.get(n.guid) ?? {}), ...n })
  }
  const uit = []
  for (const n of nummers.values()) {
    const rit = ritten.get(n['OperationalPlanning.RideNumber_Ride'])
    if (!rit?.RideID) continue
    uit.push({
      rit_id: rit.RideID,
      ritnaam: tekst(rit.RideName) ?? rit.RideID,
      chauffeur: tekst(chauffeurs.get(rit['OperationalPlanning.OperationalRide_Driver'])?.LastNameInitials),
      geautoriseerd: rit.Authorized === true,
      bewerkbaar: rit.Editable !== false,
      geblokkeerd: rit.IsBlocked === true,
      stops: Math.round(getal(n.Stops)),
      stuks: Math.round(getal(n.Pieces)),
      volume: getal(n.Volume),
    })
  }
  return uit.sort((a, b) => a.ritnaam.localeCompare(b.ritnaam, 'nl'))
}

export function stopsUit(antwoorden) {
  const perStop = new Map()
  for (const a of antwoorden) {
    for (const s of objectenUit(a, 'OperationalPlanning.Stop')) {
      if (s.StopID) perStop.set(s.StopID, { ...(perStop.get(s.StopID) ?? {}), ...s })
    }
  }
  return [...perStop.values()]
}

// Sleutel om een stop terug te vinden in de tabel op het scherm. Die rijen hebben geen id.
export function rijSleutel({ tijd, straat, nummer, toevoeging }) {
  const schoon = (w) => String(w ?? '').trim().replace(/\s+/g, ' ').toLowerCase()
  return [schoon(tijd), schoon(straat), schoon(nummer), schoon(toevoeging)].join('|')
}

export function tvi(planned) {
  if (planned === null || planned === undefined || planned === '') return ''
  return new Intl.DateTimeFormat('nl-NL', { timeZone: TIJDZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(Number(planned)))
}

export function stopSleutel(stop) {
  return rijSleutel({ tijd: tvi(stop.PlannedStopTime), straat: stop.Street, nummer: stop.BuildingNumber, toevoeging: stop.BuildingNumberExtension })
}

// Adres zonder tijd: na een verplaatsing berekent PostNL de tijd opnieuw, en mogelijk ook de StopID.
export function adresSleutel(stop) {
  return rijSleutel({ tijd: stop.PostalCode, straat: stop.Street, nummer: stop.BuildingNumber, toevoeging: stop.BuildingNumberExtension })
}

// Welke tabelrijen horen bij de gewenste stops? Twee rijen met dezelfde sleutel zijn niet uit
// elkaar te houden: dan liever niets dan de verkeerde stop.
export function rijenVoorStops(stops, rijen) {
  const perSleutel = new Map()
  for (const r of rijen) {
    const k = rijSleutel(r)
    perSleutel.set(k, [...(perSleutel.get(k) ?? []), r])
  }
  const gevonden = []
  const problemen = []
  for (const s of stops) {
    const naam = `${s.Street ?? ''} ${s.BuildingNumber ?? ''}${s.BuildingNumberExtension ? ` ${s.BuildingNumberExtension}` : ''}`.trim()
    const treffers = perSleutel.get(stopSleutel(s)) ?? []
    if (treffers.length === 0) problemen.push(`${naam} staat niet in de tabel`)
    else if (treffers.length > 1) problemen.push(`${naam} staat dubbel in de tabel`)
    else gevonden.push(treffers[0])
  }
  return { gevonden, problemen }
}

// Controle vóór de dubbelklik: precies de bedoelde rijen geselecteerd, en geen andere.
// Op sleutel, niet op rijnummer: PostNL kan tot de deadline adressen toevoegen, en dan schuiven
// de rijen op.
export function selectieKlopt(rijen, stops) {
  const gewenst = new Set(stops.map(stopSleutel))
  const geselecteerd = rijen.filter(r => r.geselecteerd).map(rijSleutel)
  return geselecteerd.length === gewenst.size && geselecteerd.every(k => gewenst.has(k))
}

// Mag deze verplaatsing nog? Reden in gewone taal, of null.
export function redenNietUitvoeren({ doelRit, deadline, nu = new Date() }) {
  if (!doelRit) return 'De doelrit staat niet meer in de planning.'
  if (doelRit.geautoriseerd) return `${doelRit.ritnaam} is al geautoriseerd.`
  if (doelRit.geblokkeerd) return `${doelRit.ritnaam} is geblokkeerd.`
  if (deadline && new Date(deadline) <= nu) {
    const tijd = new Intl.DateTimeFormat('nl-NL', { timeZone: TIJDZONE, hour: '2-digit', minute: '2-digit' }).format(new Date(deadline))
    return `De deadline van ${tijd} uur is voorbij.`
  }
  return null
}

// Ritnummer zoals in de tabel ritten: zonder voorloopnullen ("0217 maasdijk" wordt "217").
export function ritnummerVan(ritnaam) {
  const m = String(ritnaam ?? '').match(/^\s*(\d+)/)
  return m ? String(parseInt(m[1], 10)) : null
}

// Wie moet er in FloatOps aan deze PostNL-naam gekoppeld worden? Zelfde vergelijking als de
// trigger rit_chauffeur_handmatig. Geen of meerdere treffers: niets kiezen.
export function gebruikerBijNaam(gebruikers, naam) {
  const schoon = (w) => String(w ?? '').trim().toLowerCase()
  const treffers = gebruikers.filter(u => schoon(u.postnl_naam) === schoon(naam))
  return treffers.length === 1 ? treffers[0].id : null
}
