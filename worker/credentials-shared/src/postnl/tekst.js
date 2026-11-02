// Omzettingen van PostNL-waarden naar wat FloatOps opslaat. Puur, zonder browser of database,
// en gedeeld door alle PostNL-workers (floatops/matransport#562): voorheen stond elke functie
// hier in twee of drie workers apart.

export const TIJDZONE = 'Europe/Amsterdam'

// Datum (JJJJ-MM-DD) in NL-tijd.
export function vandaagNl(nu = new Date(), tijdzone = TIJDZONE) {
  const delen = Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
    timeZone: tijdzone, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(nu).map(p => [p.type, p.value]))
  return `${delen.year}-${delen.month}-${delen.day}`
}

// Klokminuten sinds middernacht in NL-tijd.
export function minutenNl(nu = new Date(), tijdzone = TIJDZONE) {
  const delen = Object.fromEntries(new Intl.DateTimeFormat('en-GB', {
    timeZone: tijdzone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(nu).map(p => [p.type, p.value]))
  return Number(delen.hour) * 60 + Number(delen.minute)
}

// 0 = zondag … 6 = zaterdag, in NL-tijd.
export function weekdagNl(nu = new Date(), tijdzone = TIJDZONE) {
  const naam = new Intl.DateTimeFormat('en-US', { timeZone: tijdzone, weekday: 'short' }).format(nu)
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(naam)
}

// "0703" en "703" zijn dezelfde rit: opslaan zonder voorloopnullen.
export function normaliseerRitnummer(waarde) {
  const cijfers = String(waarde ?? '').match(/\d+/)?.[0] ?? ''
  return cijfers ? String(parseInt(cijfers, 10)) : ''
}

export function tekst(waarde) {
  const t = String(waarde ?? '').trim()
  return t || null
}

// Getal uit PostNL: Mendix stuurt "3.94" (punt), het scherm toont "3,94" of "1.234,50".
export function getalUit(waarde) {
  if (waarde === null || waarde === undefined) return null
  if (typeof waarde === 'number') return Number.isFinite(waarde) ? waarde : null
  const s = String(waarde).trim()
  if (!s) return null
  const n = Number(s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s)
  return Number.isFinite(n) ? n : null
}

export function geheel(waarde) {
  const n = getalUit(waarde)
  return n === null ? null : Math.round(n)
}

// Volume en gewicht staan als tekst met komma en twee decimalen in `ritten` ("3,94", "387,00"),
// zoals het scherm ze altijd toonde. Zelfde vorm houden: anders telt elke rit als gewijzigd.
export function decimaalTekst(waarde) {
  const n = getalUit(waarde)
  return n === null ? null : n.toFixed(2).replace('.', ',')
}

// Shift "03" wordt "3", zoals `ritten.postnl_shift` hem altijd had.
export function shiftCode(naam) {
  const cijfers = String(naam ?? '').match(/\d+/)?.[0]
  return cijfers ? String(parseInt(cijfers, 10)) : null
}

// RideID van PostNL: "20261102_HD_161099_0703" → datum, kanaal en ritnummer.
export function ritIdDelen(rideId) {
  const m = String(rideId ?? '').match(/^(\d{4})(\d{2})(\d{2})_([A-Z]{2,3})_\w+?_(\d+)$/)
  if (!m) return null
  return { datum: `${m[1]}-${m[2]}-${m[3]}`, kanaal: m[4], ritnummer: normaliseerRitnummer(m[5]) }
}

// Geplande ritduur naar "H:MM". Het portaal is niet consistent: "5u 27m" (Mendix en scherm),
// "5:33", "5.33", "5,33", "5:33:00", "5 uur 33", "45m" en "333" (minuten). Geen plausibele duur
// = null: liever geen waarde dan een verkeerde, want hier hangt een eindtijd-berekening aan.
export function normaliseerDuur(waarde) {
  const raw = String(waarde ?? '').trim()
  if (!raw) return null
  const hm = (uren, min) => (min > 59 || uren > 23) ? null : `${uren}:${String(min).padStart(2, '0')}`

  const uurMin = raw.match(/^(\d{1,2})\s*u(?:ur)?\s*(?:(\d{1,2})\s*m(?:in)?\.?)?$/i)
  if (uurMin) return hm(parseInt(uurMin[1], 10), uurMin[2] ? parseInt(uurMin[2], 10) : 0)

  const alleenMin = raw.match(/^(\d{1,3})\s*m(?:in)?\.?$/i)
  if (alleenMin) {
    const m = parseInt(alleenMin[1], 10)
    return m > 24 * 60 ? null : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
  }

  const hhmm = raw.match(/^(\d{1,2})\s*(?::|\.|,)\s*(\d{1,2})(?::\d{1,2})?$/)
  if (hhmm) return hm(parseInt(hhmm[1], 10), parseInt(hhmm[2], 10))

  // Kaal getal = minuten. Onder de 15 of boven de 24 uur is het vrijwel zeker een andere kolom.
  const minuten = raw.match(/^(\d{1,4})$/)
  if (minuten) {
    const m = parseInt(minuten[1], 10)
    return (m < 15 || m > 24 * 60) ? null : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`
  }
  return null
}

function offsetVoor(datum, uur, minuut, tijdzone) {
  const benadering = new Date(Date.UTC(+datum.slice(0, 4), +datum.slice(5, 7) - 1, +datum.slice(8, 10), uur, minuut))
  const deel = new Intl.DateTimeFormat('en-US', { timeZone: tijdzone, timeZoneName: 'longOffset' })
    .formatToParts(benadering).find(p => p.type === 'timeZoneName').value
  const m = deel.match(/GMT([+-])(\d{2}):(\d{2})/)
  return m ? `${m[1]}${m[2]}:${m[3]}` : '+00:00'
}

// NL-wandkloktijd op een datum → ISO-tijdstip.
export function nlTijdNaarIso(datum, uur, minuut, tijdzone = TIJDZONE) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(datum) || uur > 23 || minuut > 59) return null
  const hhmm = `${String(uur).padStart(2, '0')}:${String(minuut).padStart(2, '0')}`
  return new Date(`${datum}T${hhmm}:00${offsetVoor(datum, uur, minuut, tijdzone)}`).toISOString()
}

// "Ritten kunnen tot 07:15 uur worden aangepast." + datum → ISO-tijdstip, of null.
// De tekst op de pagina is de officiële bron: de deadline wordt nooit zelf berekend.
export function deadlineUitTekst(tekstOpPagina, datum) {
  const m = String(tekstOpPagina ?? '').match(/kunnen tot\s+(\d{1,2}):(\d{2})\s+uur/i)
  return m ? nlTijdNaarIso(datum, +m[1], +m[2]) : null
}

// Mendix DisplayDate (epoch-ms, middernacht NL) → JJJJ-MM-DD.
export function datumUitEpoch(ms) {
  return Number.isFinite(Number(ms)) ? vandaagNl(new Date(Number(ms))) : null
}
