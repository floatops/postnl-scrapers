// Pure logica van de planner: Mendix-antwoorden lezen en omzetten. Geen browser, geen database.

const TIJDZONE = 'Europe/Amsterdam'

// Alle objecten in een /xas/-antwoord, op type. Mendix zet ze per actie onder een andere
// sleutel, nest gekoppelde objecten in de attribuutwaarde (RideNumber -> Ride -> Driver), en
// sommige waarden staan alleen in `changes` (per guid). Een koppeling wordt hier de guid.
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

const regexVeilig = (t) => String(t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Een toevoeging is kort: een letter of nummer, of een letter met nummer ("A", "22", "K101", "BU3",
// "1E"). Het adresregister kent niets anders. Daarom een witte lijst: wat niet zo oogt gaat weg, want
// een vrij veld bevat ook namen van mensen ("T.A.V. ..."), bedrijven en plaatsen.
// Letters alleen tot twee ("A", "BG"); met cijfers in de vorm van het register ("BU3", "K101",
// "DC3A", "1E"). "BV", "NV" zijn bedrijfsvormen, geen toevoeging. "PBA" (PostNL-punt) is ook geen
// toevoeging: die wordt een vlag, zie isPostnlPunt (matransport#603).
const isToevoeging = (t) => !['BV', 'NV'].includes(t) && /^([A-Z]{1,2}|[A-Z]{1,3}\d{1,4}[A-Z]?|\d{1,4}[A-Z]{0,2})$/.test(t)

// PostNL geeft een PostNL-punt (winkel die pakketten aanneemt) aan met toevoeging "PBA". Dat adres
// heeft die toevoeging niet in het register (14 van 14 nagekeken, 10-11): het is een label.
export const isPostnlPunt = (waarde) => /^PBA\b/i.test(String(waarde ?? '').trim())
const zonderNullen = (t) => (/^\d+$/.test(t) ? t.replace(/^0+(?=\d)/, '') : t)

// De toevoeging zoals een adres hem nodig heeft. In PostNL is dit een vrij veld (matransport#600): op
// 06-11 stonden er losse tekens, hele postcodes, COA-nummers van bewoners, namen, bedrijven en
// plaatsen in. "APP 8" wordt "8", "BU 3" wordt "BU3", "55 PLAATSNAAM" wordt "55". Een dubbele letter
// ("AA", "B B") bestaat niet in het register: bij elk nagekeken adres stond daar "A" of "B". "PBA"
// gaat eruit: dat is de vlag postnl_punt (matransport#603). Alleen voor het opslaan: het terugvinden op het scherm
// gebruikt de ruwe waarde van PostNL (stopSleutel, adresSleutel).
export function schoonToevoeging(waarde, huisnummer = null) {
  let t = String(waarde ?? '').trim().replace(/\s+/g, ' ')
  t = t.replace(/\(?\s*\bCOA(?![A-Za-z])[\s:-]*(nummer|nr\.?)?[\s:-]*[\d\s-]*\)?/gi, '')   // een persoonsnummer: nooit bewaren
  if (/\d{7,}/.test(t)) return null   // zo'n lang nummer is nooit een toevoeging
  if (huisnummer && new RegExp(`(^|\\s)${regexVeilig(huisnummer)}$`).test(t)) return null   // "PLAATS 182" bij nummer 182
  if (/\b[1-9]\d{3}\s?[A-Za-z]{2}\b/.test(t) || /\d{4}[A-Z]{2}[A-Z]/.test(t)) return null   // een postcode (soms met plaats eraan): die hebben we al
  t = t.replace(/[()]/g, '').replace(/^[\s\-–_/,.`'"]+|[\s\-–_/,.`'"]+$/g, '').toUpperCase()
  t = t.replace(/^(APPARTEMENT|APP|AP|KAMER|UNIT)[\s.:-]*(?=[A-Z0-9])/, '')
  // Samenvoegen alleen tussen letter en cijfer ("BU 3"): "1-2" wordt anders "12", een ander adres.
  const samen = /\d[\s\-–/.]+\d/.test(t) ? t : t.replace(/[\s\-–/.]/g, '')
  // Het huisnummer nog eens, maar met leestekens of voorloopnullen ("-29", "29.", "029" bij nr 29).
  if (huisnummer && zonderNullen(samen) === zonderNullen(String(huisnummer).trim().toUpperCase())) return null
  if (/^([A-Z])\1$/.test(samen)) return samen[0]
  if (isToevoeging(samen)) return zonderNullen(samen)
  // Eerst de echte toevoeging, daarna een plaats of straat ("C PLAATSNAAM", "1E ETAGE").
  const eerste = t.split(/[\s,]+/)[0]
  return /^([A-Z]|\d{1,3}[A-Z]?)$/.test(eerste) ? zonderNullen(eerste) : null
}

const KLEIN = new Set(['van', 'de', 'der', 'den', 'het', 'ter', 'ten', 'te', 'op', 'aan', 'in', 'bij', 'en'])
const woordTitel = (w) => w.split('-').map(d => (/^ij/i.test(d) ? `IJ${d.slice(2).toLowerCase()}` : d.charAt(0).toUpperCase() + d.slice(1).toLowerCase())).join('-')
const MAAND = /^(januari|februari|maart|april|mei|juni|juli|augustus|september|oktober|november|december)/i
const KORT = [[/str$/i, 'straat'], [/sngl$/i, 'singel'], [/pln$/i, 'plein'], [/ln$/i, 'laan'], [/wg$/i, 'weg'], [/gr$/i, 'gracht']]
function voluit(straat) {
  const woorden = straat.split(' ')
  const laatste = woorden.at(-1)
  const k = laatste.length > 4 && KORT.find(([r]) => r.test(laatste))   // niet "Köln" -> "Kölaan\"
  if (k) woorden[woorden.length - 1] = laatste.replace(k[0], k[1])
  return woorden.join(' ')
}

// De straat zonder wat er niet bij hoort. Ook dit is een vrij veld: op 06-11 stond er soms het
// huisnummer in ("Teststraat 54"), een postcode, plaats of provincie achter een komma, losse tekens,
// alles in hoofdletters of kleine letters, een afkorting ("Teststr") of "Onbekend". "Plein 1957"
// blijft staan: 1957 is daar geen huisnummer. Geeft { straat, letter }, met `letter` als de
// toevoeging in de straat stond ("Teststraat 112 B"). De officiële naam gaat hier nog boven, zie
// straatUitRegister: dit is wat overblijft voor een adres dat daar (nog) niet in staat.
export function schoonStraat(waarde, huisnummer = null) {
  const ruw = String(waarde ?? '').trim().replace(/\s+/g, ' ').replace(/\\'/g, "'").replace(/[’`´]/g, "'")
  let s = ruw.replace(/\s*\d{4}\s?[A-Z]{2}\b.*$/, '').split(/\s*[,;]/).find(d => d.trim()) ?? ''
  const rand = (t) => t.replace(/^[\s_.:/-]+|[\s_.:/-]+$/g, '')
  s = rand(s)
  let letter = null
  if (huisnummer) {
    const nr = regexVeilig(huisnummer)
    const m = new RegExp(`^(.+?)\\s+${nr}(?:\\s+(\\S.*)|\\s?([A-Za-z])?[\\s/\\d,-]*)$`).exec(s)
    if (m) { s = m[1]; letter = m[3]?.toUpperCase() ?? (m[2] ? schoonToevoeging(m[2], huisnummer) : null) }
    const v = new RegExp(`^${nr}\\s+(\\D.*)$`).exec(s)   // "54 Teststraat", maar niet "18 Septemberplein"
    if (v && !MAAND.test(v[1])) s = v[1]
  }
  const l = /^(.{3,}?(?:weg|straat|laan|plein|singel|gracht|kade|dijk|pad|hof|dreef|steeg|erf|park))\s-?([A-Za-z])$/i.exec(s)   // "Teststraat B", maar niet "Wijk A"
  if (l) { s = l[1]; letter ??= l[2].toUpperCase() }
  s = rand(s)
  if (/^\(?onbekend\)?$/i.test(s)) return { straat: null, letter }
  if (s && (s === s.toUpperCase() || s === s.toLowerCase()) && /[A-Za-z]{2}/.test(s)) {
    s = s.split(' ').map((w, i) => (i > 0 && KLEIN.has(w.toLowerCase()) ? w.toLowerCase() : woordTitel(w))).join(' ')
  }
  return { straat: voluit(s) || null, letter }
}

// Straat, huisnummer en toevoeging zoals we ze bewaren. Het terugvinden op het scherm gebruikt de
// ruwe waarden van PostNL (stopSleutel, adresSleutel).
export function schoonAdres(stop) {
  const huisnummer = tekst(stop.BuildingNumber)
  const { straat, letter } = schoonStraat(stop.Street, huisnummer)
  return { straat: straat ?? '(onbekend)', huisnummer, toevoeging: schoonToevoeging(stop.BuildingNumberExtension, huisnummer) ?? letter }
}

// Alleen een echte Nederlandse postcode. Niet alles wat in het veld staat is dat ("0000FF").
export function schoonPostcode(waarde) {
  const p = String(waarde ?? '').replace(/\s+/g, '').toUpperCase()
  return /^[1-9]\d{3}[A-Z]{2}$/.test(p) && !/(SA|SD|SS)$/.test(p) ? p : null
}

// Postcode + huisnummer wijzen één adres aan; de straat is wat de afzender typte. De officiële naam
// staat in geocode_cache (PDOK, het adresregister). Gemeten op 06-11: bij 8998 van de 8999 adressen
// één straat, en 300 van de 300 adressen zonder cache-rij bestonden wel in het register.
export const adresPaar = (postcode, huisnummer) => (postcode && huisnummer ? `${postcode}|${huisnummer}` : null)

// "Teststraat 12A, 1234AB Testplaats" -> "Teststraat". Staat er een andere postcode of een ander
// nummer, dan is het niet dit adres.
export function straatUitWeergave(weergave, postcode, huisnummer) {
  const m = /^(.+?),\s*(\d{4}[A-Z]{2})\b/.exec(String(weergave ?? ''))
  if (!m || m[2] !== postcode) return null
  const straat = new RegExp(`^(.+)\\s${regexVeilig(huisnummer)}(?:[A-Za-z]|[\\s-]\\S+)?(?:-\\S+)?$`).exec(m[1])?.[1]
  return straat ? voluit(straat) : null   // het register kort lange namen zelf ook af
}

// Per adres de officiële straat, uit de rijen van geocode_cache. Twee namen: niet kiezen.
export function straatUitRegister(rijen) {
  const namen = new Map()
  for (const r of rijen) {
    const paar = adresPaar(r.postcode, r.huisnummer)
    const straat = paar && straatUitWeergave(r.weergavenaam, r.postcode, r.huisnummer)
    if (!straat) continue
    if (!namen.has(paar)) namen.set(paar, new Set())
    namen.get(paar).add(straat)
  }
  return new Map([...namen].filter(([, s]) => s.size === 1).map(([p, s]) => [p, [...s][0]]))
}

// Het rondje Postcodes staat op Nee, en toch kwamen er geen stops binnen en staat de stoptabel er
// niet: dan toont PostNL de postcodeblokken met een oud rondje (10-11, matransport#666), en moet
// Postcodes even naar Ja en terug. Een rit met alleen postcodeblokken krijgt dat ook; dat kan geen
// kwaad (alleen de weergave), hij blijft daarna gewoon leeg.
export function postcodesOpnieuwZetten({ stops, rijen }) {
  return stops === 0 && rijen === 0
}

// De bronrit had volgens de kop stops, maar er kwam er geen binnen: dan is de lezing mislukt, niet
// "alles al weg". Niets verplaatsen (matransport#666: 10-11 Den Hoorn, 60 stops ten onrechte
// "staan niet meer in 0218").
export function bronNietGelezen(bron, stops) {
  if (stops.length || !(Number(bron?.stops) > 0)) return null
  return `De stops van ${bron.ritnaam} konden niet gelezen worden. Er is niets verplaatst. Probeer het opnieuw.`
}

// Uitkomst van de controle na de dubbelklik. Kwam er van de doelrit niets binnen, dan is de controle
// mislukt, niet per se de verplaatsing: zeg dat (matransport#666: 10-11 Waddinxveen, 56 stops
// "staan niet in 0712" terwijl ze erin stonden). null = gelukt.
// Staat er geen enkele stop in de doelrit en zei PostNL niets, dan heeft PostNL de verplaatsing
// stil niet uitgevoerd (matransport#696: 11-11 00:30-01:04 vijf van de vijf, op A en B).
export function controleUitkomst({ gewenst, inDoel, gelezen, doel, dialoog = null, nu = new Date() }) {
  const extra = dialoog ? ` (PostNL: ${dialoog})` : ''
  if (!gelezen) {
    return { status: 'mislukt', melding: `De verplaatsing naar ${doel.ritnaam} is gegeven, maar die rit kon daarna niet gelezen worden${extra}. Controleer in PostNL of de ${gewenst.length} stop(s) erin staan.` }
  }
  const missen = gewenst.filter(s => !inDoel.has(adresSleutel(s)))
  if (missen.length === gewenst.length && !dialoog) {
    const uur = Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Amsterdam', hour: '2-digit', hourCycle: 'h23' }).format(nu))
    const nacht = uur < 6 ? " 's Nachts gebeurt dit vaker: probeer het in de ochtend opnieuw." : ' Probeer het opnieuw of controleer dit in PostNL.'
    return { status: 'mislukt', melding: `PostNL heeft deze verplaatsing niet uitgevoerd: ${missen.length === 1 ? 'de stop staat' : `de ${missen.length} stops staan`} niet in ${doel.ritnaam}.${nacht}` }
  }
  if (missen.length) {
    return { status: 'mislukt', melding: `${missen.length} stop(s) staan na de actie niet in ${doel.ritnaam}${extra}. Controleer dit in PostNL.` }
  }
  return null
}

// Een gebouwnummer in de straat (matransport#667): "Teststraat 22-A" met huisnummer 8 is gebouw 22A,
// woning 8 (register "22A-8"). Geeft { straat, gebouw, letter } of null. Of het echt zo is, beslist
// gebouwAdres met het register. Alleen met een letter: "Teststraat 12" met nummer 30 kan net zo goed
// een tikfout zijn, en ongeveer 16% van de adressen staat niet in de cache, dus "30 onbekend" bewijst
// dan niets. "Plein 1957" en "Teststraat 54" (nr 54) komen hier niet doorheen.
export function gebouwUitStraat(waarde, huisnummer) {
  if (!huisnummer) return null
  const ruw = String(waarde ?? '').trim().replace(/\s+/g, ' ')
  const m = /^(.+?)\s+([1-9]\d{0,4})\s*[-–]?\s*([A-Za-z])[\s\-–_/.,]*$/.exec(ruw)
  if (!m || m[2] === huisnummer || !/[A-Za-z]{2}/.test(m[1])) return null
  return { straat: m[1], gebouw: m[2], letter: m[3].toUpperCase() }
}

// Per adres (postcode|huisnummer) wat het register ervan weet: `letters` van gebouwen met losse
// woningen ("Teststraat 22A-16, 1234AB" geeft bij 1234AB|22 de letter 'A'). Elk paar met een rij staat
// erin, ook een hoekpand met twee straatnamen of een rij die niet te ontleden is: dat adres bestaat.
export function woningenUitRegister(rijen) {
  const uit = new Map()
  for (const r of rijen) {
    const paar = adresPaar(r.postcode, r.huisnummer)
    if (!paar) continue
    if (!uit.has(paar)) uit.set(paar, { letters: new Set() })
    const m = /^(.+?),\s*(\d{4}[A-Z]{2})\b/.exec(String(r.weergavenaam ?? ''))
    if (!m || m[2] !== r.postcode) continue
    const w = new RegExp(`\\s${regexVeilig(r.huisnummer)}([A-Za-z])-\\d+$`).exec(m[1])
    if (w) uit.get(paar).letters.add(w[1].toUpperCase())
  }
  return uit
}

// De paren die het register moet kennen om dit adres goed op te slaan: het adres zelf, en een
// gebouwnummer in de straat als dat er staat.
export function adresParen(stop) {
  const postcode = schoonPostcode(stop.PostalCode)
  const { huisnummer } = schoonAdres(stop)
  const g = gebouwUitStraat(stop.Street, huisnummer)
  return [adresPaar(postcode, huisnummer), g && adresPaar(postcode, g.gebouw)].filter(Boolean)
}

// Huisnummer = gebouw, toevoeging = letter + woning, alleen als het register zegt dat het zo zit: het
// gebouw heeft woningen met die letter, en het huisnummer zelf heeft in het register geen enkele rij.
// Niet als er al een toevoeging is. Anders null en blijft het adres zoals de afzender het gaf.
// `straten`/`woningen` zoals vulStraten ze vult: elk opgezocht paar staat erin (zonder rij: null); een
// paar dat niet is opgezocht telt als onbekend (dan ook null).
export function gebouwAdres(stop, { straten, woningen }) {
  const postcode = schoonPostcode(stop.PostalCode)
  const { huisnummer, toevoeging } = schoonAdres(stop)
  const g = gebouwUitStraat(stop.Street, huisnummer)
  if (!g || !postcode || toevoeging || !straten || !woningen) return null
  const eigen = adresPaar(postcode, huisnummer)
  const gebouw = adresPaar(postcode, g.gebouw)
  if (!woningen.has(eigen) || woningen.get(eigen) || !woningen.get(gebouw)?.letters.has(g.letter)) return null
  return { straat: straten.get(gebouw) ?? schoonStraat(g.straat).straat ?? '(onbekend)', huisnummer: g.gebouw, toevoeging: `${g.letter}${huisnummer}` }
}

// Welke van de gevraagde stops staan er nog? `nietMeer`: hoeveel niet, de rest kan gewoon door.
export function kiesGewenst(stops, stopIds) {
  const gewenst = stops.filter(s => stopIds.includes(s.guid))
  return { gewenst, nietMeer: stopIds.length - gewenst.length }
}

// Voor de app: alleen wat daar nodig is. Verder niets, het zijn adressen. De postcode
// (matransport#587) is voor de stops op de kaart van een rit: met huisnummer + toevoeging het adres.
// De stoplijst bevat geen StopID en RideID: de guid is het vaste kenmerk, en de rit is die we open hebben.
// volgorde: de plek van de stop in de stoplijst zoals OOM PD hem geeft (1 = eerste), het nummer op
// de pin in de kaart van een rit (matransport#603). Niet uit de tijd: die is op hele minuten afgerond.
export function stopNaarRij(stop, { klantId, depot, datum, shift, ritId, opgehaaldAt, straten = null, woningen = null, volgorde = null }) {
  const postcode = schoonPostcode(stop.PostalCode)
  const gebouw = gebouwAdres(stop, { straten, woningen })
  const adres = gebouw ?? schoonAdres(stop)
  return {
    klant_id: klantId, depot, datum, shift,
    rit_id: ritId,
    stop_id: stop.guid,
    ...adres,
    straat: gebouw?.straat ?? straten?.get(adresPaar(postcode, adres.huisnummer)) ?? adres.straat,
    postcode,
    stuks: Math.round(getal(stop.Pieces)),
    volume: getal(stop.Volume),
    postnl_punt: isPostnlPunt(stop.BuildingNumberExtension),
    // Zonder het attribuut (een gedeeltelijk stopobject) het veld weglaten: dan slaat verschil() het
    // over en blijft de bekende tijd staan, in plaats van elke ronde null en weer terug te schrijven.
    ...('PlannedStopTime' in stop ? { tvi_tijd: tviTijd(stop.PlannedStopTime) } : {}),
    ...(Number.isInteger(volgorde) && volgorde > 0 ? { tvi_volgorde: volgorde } : {}),
    opgehaald_at: opgehaaldAt,
  }
}

// De geplande stoptijd van PostNL (PlannedStopTime, ms sinds 1970) als ISO-tijd voor
// planning_stops.tvi_tijd (matransport#603): de tijd bij het adres op de kaart van een rit, en
// gesorteerd per rit de TVI-volgorde. Leeg of onzin wordt null, nooit 1970.
export function tviTijd(planned) {
  if (planned === null || planned === undefined || planned === '') return null
  const ms = Number(planned)
  if (!Number.isFinite(ms) || ms <= 0) return null
  return new Date(ms).toISOString()
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
    if (!rit?.RideName) continue
    uit.push({
      // De guid, niet RideID: die laatste staat niet in elk antwoord.
      rit_id: rit.guid,
      ritnaam: tekst(rit.RideName),
      chauffeur: tekst(chauffeurs.get(rit['OperationalPlanning.OperationalRide_Driver'])?.LastNameInitials),
      geautoriseerd: rit.Authorized === true || rit.Enum_Authorized === '_True',
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
      perStop.set(s.guid, { ...(perStop.get(s.guid) ?? {}), ...s })
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

// Hoeveel plekken van de stoplijst (volgorde van het antwoord) anders zijn dan de tabel op het
// scherm (matransport#603). 0 = tvi_volgorde is precies wat de planner in OOM PD ziet. Alleen om te
// loggen: een verschil houdt de lezing niet tegen.
export function volgordeAfwijkingen(stops, tabel) {
  if (!tabel?.length) return null
  let anders = Math.abs(stops.length - tabel.length)
  const n = Math.min(stops.length, tabel.length)
  for (let i = 0; i < n; i++) if (stopSleutel(stops[i]) !== rijSleutel(tabel[i])) anders++
  return anders
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
    // Gaat als melding naar de database: de schone waarden, nooit het vrije veld van PostNL.
    const a = schoonAdres(s)
    const naam = `${a.straat} ${a.huisnummer ?? ''}${a.toevoeging ? ` ${a.toevoeging}` : ''}`.trim()
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

// PostNL verplaatst alleen binnen dezelfde shift (regel eigenaar 03-11). Null als het mag.
export function shiftReden(bron, doel) {
  if (!bron || !doel || bron.shift === doel.shift) return null
  return `Alleen verplaatsen binnen dezelfde shift: ${bron.ritnaam} zit in shift ${bron.shift}, ${doel.ritnaam} in shift ${doel.shift}.`
}

// Welke shifts een doorvoer moet lezen (matransport#578): die van de bron- en de doelritten. Null
// (= alle shifts) als een wijziging geen shift heeft: dan liever te veel lezen dan een rit missen.
export function shiftsVan(verplaatsingen) {
  if (verplaatsingen.some(v => !v.shift)) return null
  return [...new Set(verplaatsingen.flatMap(v => [v.shift, v.naar_shift]).filter(Boolean))].sort()
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

// Wat de planner te zien krijgt. De technische tekst blijft in worker_run_log.
export function foutVoorPlanner(bericht) {
  const t = String(bericht ?? '')
  if (/staat niet in de PostNL-planning|geen ritten in PostNL|PostNL is bezet|Geen PostNL-inlog|Inloggen bij PostNL is mislukt/.test(t)) return t
  if (/Timeout|exceeded|reageerde niet|Target closed|net::|ERR_/i.test(t)) return 'PostNL reageerde niet op tijd. Probeer het over een minuut opnieuw.'
  if (/geblokkeerd|403/i.test(t)) return 'PostNL weigerde de verbinding. Probeer het over een paar minuten opnieuw.'
  return 'Er ging iets mis bij PostNL. Probeer het opnieuw; blijft het misgaan, meld het dan.'
}

// Playwright-trace naast de video (keuze eigenaar 02-11, zonder einddatum): per stap een
// schermafdruk, de HTML van de pagina en het netwerkverkeer, om een nieuw scherm van PostNL
// meteen te begrijpen. Uitzetten: PLANNER_TRACE=uit in de omgeving van de worker.
export const TRACE_BEWAAR_DAGEN = 14

export function traceAan(env = process.env) {
  return env.PLANNER_TRACE !== 'uit'
}

// Traces ouder dan de bewaartermijn, op de tijdstempel in de naam ("...-2026-11-02_06-48-04.zip").
export function teOudeTraces(namen, nu = new Date(), dagen = TRACE_BEWAAR_DAGEN) {
  const grens = new Date(nu.getTime() - dagen * 86_400_000).toISOString().slice(0, 10)
  return namen.filter(n => {
    const m = n.match(/-(\d{4}-\d{2}-\d{2})_\d{2}-\d{2}-\d{2}\.zip$/)
    return m && m[1] < grens
  })
}

// Alleen verschillen schrijven (floatops/matransport#562): de app ziet live wat er in PostNL
// veranderde, en een ronde zonder wijziging schrijft niets. Vergelijkt de inhoud, niet opgehaald_at.
export const RIT_VELDEN = ['shift', 'ritnaam', 'chauffeur', 'chauffeur_wijzigbaar', 'chauffeur_opties', 'geautoriseerd',
  'bewerkbaar', 'geblokkeerd', 'stops', 'stuks', 'volume', 'deadline', 'stops_gelezen']
export const STOP_VELDEN = ['rit_id', 'shift', 'straat', 'huisnummer', 'toevoeging', 'postcode', 'stuks', 'volume', 'tvi_tijd', 'tvi_volgorde', 'postnl_punt']
// Kolommen die op een stack nog kunnen ontbreken tot de migratie daar is gepromoot (één checkout
// draait voor A en B): postcode (matransport#587), tvi_tijd (matransport#603). Zonder zo'n kolom
// bewaart de worker de stops zonder dat veld, in plaats van elke upsert te laten mislukken.
export const OPTIONELE_STOP_VELDEN = ['postcode', 'tvi_tijd', 'tvi_volgorde', 'postnl_punt']
export function zonderVelden(rij, weg) {
  if (!weg.size) return rij
  return Object.fromEntries(Object.entries(rij).filter(([k]) => !weg.has(k)))
}

const ISO = /^\d{4}-\d{2}-\d{2}T/
function zelfde(a, b) {
  if (a == null || b == null) return (a ?? null) === (b ?? null)
  if (Array.isArray(a) || Array.isArray(b)) return JSON.stringify(a) === JSON.stringify(b)
  if (typeof a === 'number' || typeof b === 'number') return Number(a) === Number(b)
  if (typeof a === 'string' && typeof b === 'string' && ISO.test(a) && ISO.test(b)) return Date.parse(a) === Date.parse(b)
  return a === b
}

// bestaand: rijen uit de database (alleen die in de reikwijdte van deze ronde), gelezen: wat PostNL
// nu toont. Geeft { nieuw, gewijzigd, weg (sleutels) }. Een veld dat de lezing niet heeft, telt niet.
export function verschil(bestaand, gelezen, sleutel, velden) {
  const oud = new Map(bestaand.map(r => [r[sleutel], r]))
  const nieuw = []
  const gewijzigd = []
  const gezien = new Set()
  for (const r of gelezen) {
    gezien.add(r[sleutel])
    const o = oud.get(r[sleutel])
    if (!o) nieuw.push(r)
    else if (velden.some(v => v in r && !zelfde(o[v], r[v]))) gewijzigd.push(r)
  }
  return { nieuw, gewijzigd, weg: bestaand.filter(o => !gezien.has(o[sleutel])).map(o => o[sleutel]) }
}

// Stops die in deze lezing in een andere rit staan dan in de database (matransport#603). Die worden
// weggehaald en opnieuw ingevoegd in plaats van bijgewerkt: de kaart van een rit luistert live op
// rit_id, en een update die de stop uit die rit haalt komt daar nooit binnen; een delete wel.
// De aanroeper verwijdert ze in stukken van 200, zoals de oude stops.
export function verhuisdeStops(bestaand, gewijzigd) {
  const oud = new Map(bestaand.map(s => [s.stop_id, s.rit_id]))
  return gewijzigd.filter(r => oud.has(r.stop_id) && r.rit_id && oud.get(r.stop_id) !== r.rit_id).map(r => r.stop_id)
}
