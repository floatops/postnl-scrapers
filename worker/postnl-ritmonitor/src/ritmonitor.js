// Ritmonitor openen, uitlezen en naar `ritten` schrijven. Gedeeld door het losse script
// (index.js, het vangnet) en de sessiehouder (postnl-sessie), zodat dit maar één keer bestaat
// (floatops/matransport#562). Uitleg en geschiedenis: ../POSTNL_RITMONITOR.md.
//
// Een rit is uniek op ritnummer + kanaal (leeg = HD), zoals de unieke index van matransport#560:
// rit 307 rijdt 's ochtends als HD en 's avonds als AD. Tot #562 koppelde de ritmonitor alleen op
// het ritnummer, waardoor de avondrit de stops en eindtijd van de ochtendrit overschreef.
import { nlTijdstipNaarIso as tijdstipNaarIso, nieuweEindtijd } from './eindtijd.js'
import { teSchrijven } from './wijzigingen.js'
import { normaliseerRitnummer, TIJDZONE } from '../../credentials-shared/src/postnl/tekst.js'
import { ritSleutel } from '../../credentials-shared/src/postnl/schrijver.js'
import { gooiBijProxyWeigering } from '../../credentials-shared/src/proxyPool.js'

// Getal zoals het Ritmonitor-scherm het toont ("1.234" = duizendtal, "3,5" = decimaal).
export function getalScherm(waarde) {
  if (!waarde) return null
  const n = Number(String(waarde).trim().replace(/\./g, '').replace(',', '.'))
  return Number.isFinite(n) ? n : null
}

// Reserve-ritten: 4-cijferig ritnummer, of het "shift"-cijfer (het eerste cijfer
// van het ritnummer) is '9' — PostNL's eigen conventie voor reservechauffeurs
// zonder vaste dienst. shift_tijden (matransport) kent alleen shift 1-6, dus een
// reserve-rit heeft nooit een geldige shift-begintijd — de begintijd komt in
// plaats daarvan uit de eerst gelezen "laatste actie"-tijd, niet het loutere
// detectiemoment (zie planMonitor hieronder).
export function isReserveRitnummer(ritnummer) {
  const s = String(ritnummer || '')
  return s.length === 4 || s.charAt(0) === '9'
}

// Ad-ritten (avondritten): kanaal-code 'AD' uit de Ritmonitor-kolom "Kanaal".
// Hebben geen shift (geen shift_tijden-data voor avondritten) en een vaste
// begintijd van 17:00.
export function isAdKanaal(kanaal) {
  return kanaal === 'AD'
}

// Zet een "HH:MM"-tijd uit shift_tijden (NL-lokaal) om naar een UTC ISO-string.
// Shift-tijden komen uit de e-mail (altijd NL-lokale wandkloktijd, niet van
// PostNL's Mendix-grid) — dus hier geen heuristiek nodig: gewoon de offset
// van Europe/Amsterdam op die datum aftrekken.
export function shiftTijdNaarIso(datum, tijd) {
  if (!datum || !tijd) return null
  const m = String(tijd).match(/(\d{1,2}):(\d{2})/)
  if (!m) return null
  const asUtc = new Date(`${datum}T${m[1].padStart(2, '0')}:${m[2]}:00Z`)
  if (Number.isNaN(asUtc.getTime())) return null
  const offsetNaam = new Intl.DateTimeFormat('en', { timeZone: 'Europe/Amsterdam', timeZoneName: 'longOffset' })
    .formatToParts(asUtc).find(p => p.type === 'timeZoneName')?.value || ''
  const om = offsetNaam.match(/([+-])(\d{2}):(\d{2})/)
  const offsetMin = om ? (om[1] === '-' ? -1 : 1) * (Number(om[2]) * 60 + Number(om[3])) : 0
  return new Date(asUtc.getTime() - offsetMin * 60000).toISOString()
}

// Een "stilgevallen" rit (uit de grid verdwenen) wordt pas afgerond als hij zo lang niet
// meer gelezen is. Op tijd, niet op aantal lezingen: geldt bij elke 60 s (sessiehouder) en
// bij de 7-min-cron (vangnet).
export const AFWEZIG_DREMPEL_MIN = 20

// Elk veld dat planMonitor kan zetten moet hier staan: teSchrijven() vergelijkt ermee, en een
// ontbrekend veld telt als "gewijzigd".
export const BESTAANDE_KOLOMMEN = 'id, ritnummer, status, shift, postnl_stops_totaal, postnl_stops_te_doen, postnl_start_werktijd, postnl_eind_werktijd, postnl_monitor_opgehaald, postnl_laatste_actie, postnl_kanaal, postnl_chauffeur, postnl_briefbusstops, postnl_rit_id'

// Puur: wat moet er na deze lezing bijgewerkt, aangemaakt en gelogd worden?
export function planMonitor({ bestaande, rijen, datum, depot, klantId, nu, leegBevestigd = false, tijdzone = TIJDZONE }) {
  const nuMs = new Date(nu).getTime()
  const naarIso = (tekst) => tijdstipNaarIso(datum, tekst, nuMs, tijdzone)

  // Eerste rij per sleutel (ritnummer + kanaal).
  const bestaandeMap = new Map()
  for (const r of bestaande ?? []) {
    const key = ritSleutel(r.ritnummer, r.postnl_kanaal)
    if (!bestaandeMap.has(key)) bestaandeMap.set(key, r)
  }

  const updates = []
  const inserts = []
  const logRijen = []
  const runContext = {
    klant_id: klantId,
    depot,
    datum,
    rijen_gelezen: rijen.length,
    lege_lijst_bevestigd: leegBevestigd,
    bestaande_ritten: bestaande?.length ?? 0,
  }

  for (const rit of rijen) {
    const existing = bestaandeMap.get(ritSleutel(rit.ritnummer, rit.kanaal))

    // Een 0-meting pas vertrouwen als "klaar" zodra de vóórgaande poll dat ook al liet zien.
    // Bij een net aangemaakte rij toont de Mendix-grid de "stops te doen"-cel soms eenmalig
    // foutief 0 voordat de echte waarde laadt — zonder deze bevestiging wordt de rit dan
    // veel te vroeg als afgerond gemarkeerd (eind_werktijd vlak na start_werktijd).
    const stopsTeDoenBevestigdNul = rit.stopsTeDoen === 0 && existing?.postnl_stops_te_doen === 0

    // Eén bron per gegeven (matransport#713): kent de Dagplanning deze rit (postnl_rit_id), dan komen
    // de chauffeur (met zijn vaste PostNL-id) en de brievenbusstops alleen uit de Dagplanning. De
    // Ritmonitor vult ze alleen voor een rit die de Dagplanning niet leest (avond-, bulk- en
    // reserveritten, #653). Een lege cel overschrijft geen bekende chauffeur.
    const dagplanningKent = Boolean(existing?.postnl_rit_id)
    const velden = {
      postnl_stops_totaal:      rit.stopsTotaal,
      postnl_stops_te_doen:     rit.stopsTeDoen,
      postnl_laatste_actie:     rit.laatsteActie,
      postnl_kanaal:            rit.kanaal,
      postnl_monitor_opgehaald: nu,
      ...(!dagplanningKent && rit.chauffeur && { postnl_chauffeur: rit.chauffeur }),
      ...(!dagplanningKent && rit.brievenbusstops !== null && { postnl_briefbusstops: rit.brievenbusstops }),
      // Status op basis van ritmonitor: ritmonitor is leidend zodra stops_te_doen bekend is.
      ...(rit.stopsTeDoen !== null && {
        status: stopsTeDoenBevestigdNul ? 'gereden' : 'bezig',
      }),
      // Zelfherstellend: `shift` wordt alleen bij het aanmaken van een rij gezet, nooit meer bij
      // latere updates — een bestaande ad-rit-rij die vóór deze fix is aangemaakt houdt anders
      // voor altijd zijn oude/foute shiftcijfer. Op elke poll opnieuw op null zetten voor
      // ad-ritten corrigeert dat vanzelf voor elke nog actief gepollde rit.
      ...(isAdKanaal(rit.kanaal) && { shift: null }),
    }

    // Starttijd: eerste sync waarbij chauffeur een stop heeft afgeleverd.
    // Reserve-ritten hebben geen shift_tijden-begintijd (die tabel kent alleen shift 1-6) —
    // voor hen dus de eerst gelezen "laatste actie"-tijd zelf. Ad-ritten (avond) hebben een
    // vaste begintijd van 17:00 — er is geen shift_tijden-data voor avondritten.
    if (
      rit.stopsTeDoen !== null &&
      rit.stopsTotaal !== null &&
      rit.stopsTeDoen < rit.stopsTotaal &&
      !existing?.postnl_start_werktijd
    ) {
      if (isReserveRitnummer(rit.ritnummer)) {
        velden.postnl_start_werktijd = naarIso(rit.laatsteActie) || nu
      } else if (isAdKanaal(rit.kanaal)) {
        velden.postnl_start_werktijd = shiftTijdNaarIso(datum, '17:00') || nu
      } else {
        velden.postnl_start_werktijd = nu
      }
    }

    // Eindtijd = het laatste "Tijdstip laatste actie" dat PostNL die dag voor deze rit
    // registreerde (zie nieuweEindtijd). Op elke poll, ongeacht status of "stops te doen" —
    // ook ná 'gereden' loopt hij door zolang de rit in de grid staat. Vanaf de poll waarop
    // de rit start (ook als de starttijd deze poll pas gezet wordt). Zolang status niet
    // 'gereden' is, is dit een voorlopige waarde — zie RITTEN_ARCHITECTUUR.md.
    const eindIso = nieuweEindtijd({
      gestart: Boolean(existing?.postnl_start_werktijd || velden.postnl_start_werktijd),
      huidigeEindIso: existing?.postnl_eind_werktijd ?? null,
      laatsteActieIso: naarIso(rit.laatsteActie),
    })
    if (eindIso) velden.postnl_eind_werktijd = eindIso

    // Diagnostisch loggen: wat las de worker + welke beslissing nam hij voor deze rit.
    // Alleen als er iets veranderde t.o.v. de vorige lezing.
    const actie = !existing ? 'nieuw'
      : stopsTeDoenBevestigdNul ? 'eind-nul'
      : velden.postnl_start_werktijd ? 'start-gezet'
      : velden.postnl_eind_werktijd ? 'eind-bijgewerkt'
      : 'gelezen'
    const veranderd = !existing
      || existing.postnl_stops_totaal !== rit.stopsTotaal
      || existing.postnl_stops_te_doen !== rit.stopsTeDoen
      || (existing.postnl_laatste_actie ?? null) !== (rit.laatsteActie ?? null)
      || (velden.status != null && existing.status !== velden.status)
      || Boolean(velden.postnl_start_werktijd || velden.postnl_eind_werktijd)
    if (veranderd) logRijen.push({
      ...runContext,
      ritnummer:     rit.ritnummer,
      kanaal:        rit.kanaal || 'HD',
      stops_totaal:  rit.stopsTotaal,
      stops_te_doen: rit.stopsTeDoen,
      laatste_actie: rit.laatsteActie,
      actie,
    })

    if (existing) {
      // Alleen wat echt anders is, plus hoogstens elke 5 min de hartslag
      // postnl_monitor_opgehaald (zie wijzigingen.js, floatops/matransport#462).
      const diff = teSchrijven(existing, velden, nuMs)
      if (diff) updates.push({ id: existing.id, velden: diff })
    } else {
      // Rit nog niet via Dagplanning aangemaakt → minimale rij zodat het live toch toont.
      inserts.push({
        datum,
        status:    'gepland',
        shift:     rit.shift,
        ritnummer: rit.ritnummer,
        depot,
        klant_id:  klantId,
        postnl_ritnaam: rit.ritnaam,
        ...velden,
      })
    }
  }

  // ── Verdwenen-uit-grid → afronden (veilig, met dubbele-miss-bevestiging) ──
  // PostNL haalt een rit uit de Ritmonitor-grid zodra de chauffeur klaar is. Zo'n rit bereikt
  // "te doen = 0" vaak nooit (onbezorgbare stops blijven staan), dus de nul-detectie hierboven
  // pakt 'm niet — zonder deze pass blijft hij eeuwig op "bezig · N te gaan" hangen (rit 640).
  // Een half-geladen grid liet vroeger bezige ritten eenmalig verdwijnen → vals afgerond.
  // Daarom eisen we dat de rit AFWEZIG_DREMPEL_MIN niet meer gezien is (ouderdom van
  // postnl_monitor_opgehaald). Alleen als deze lezing rijen opleverde of PostNL's teller een
  // lege lijst bevestigde: een onbevestigde lege lijst kan een mislukte grid zijn.
  const gelezen = new Set(rijen.map(r => ritSleutel(r.ritnummer, r.kanaal)))
  if (rijen.length > 0 || leegBevestigd) {
    for (const [key, r] of bestaandeMap) {
      if (gelezen.has(key)) continue                           // nog in de grid
      if (r.status === 'gereden') continue                     // al afgerond
      if (!r.postnl_start_werktijd) continue                   // nooit begonnen
      if (r.postnl_stops_totaal == null) continue
      // Was hij echt onderweg? (voortgang gemaakt, niet nog volledig "te doen")
      if (!(r.postnl_stops_te_doen != null && r.postnl_stops_te_doen < r.postnl_stops_totaal)) continue
      const opgehaald = r.postnl_monitor_opgehaald ? new Date(r.postnl_monitor_opgehaald).getTime() : 0
      if ((nuMs - opgehaald) / 60000 < AFWEZIG_DREMPEL_MIN) continue

      // Eindtijd: alleen nog aanvullen als de continue update het om wat voor reden niet deed.
      // Nooit een zelf afgeleide tijd — de eindtijd bepaalt de uitbetaling en is uitsluitend
      // wat PostNL registreerde. Geen registratie = leeg, en dat valt op in Financiën.
      const eindIso = nieuweEindtijd({
        gestart: true,
        huidigeEindIso: r.postnl_eind_werktijd,
        laatsteActieIso: naarIso(r.postnl_laatste_actie),
      })
      updates.push({ id: r.id, velden: {
        status: 'gereden',
        ...(eindIso && { postnl_eind_werktijd: eindIso }),
        postnl_monitor_opgehaald: nu,
      } })
      logRijen.push({
        ...runContext,
        ritnummer:     normaliseerRitnummer(r.ritnummer),
        kanaal:        r.postnl_kanaal || 'HD',
        stops_totaal:  r.postnl_stops_totaal,
        stops_te_doen: r.postnl_stops_te_doen,
        laatste_actie: r.postnl_laatste_actie ?? null,
        actie:         'verdwenen-afgerond',
      })
    }
  }
  return { updates, inserts, logRijen }
}

// Een databasefout krijgt `database: true`: dan ligt het niet aan de browsersessie, en hoeft
// die niet vervangen te worden.
export function databaseFout(wat, error) {
  return Object.assign(new Error(`${wat}: ${error.code ?? ''} ${error.message}`.trim()), { database: true })
}

async function vereis(belofte, wat) {
  const { error } = await belofte
  if (error) throw databaseFout(wat, error)
}

// Alles wat Supabase of een browser nodig heeft. `login(page, depot)` is de inlogfunctie van de
// aanroeper (vangnet-script of sessiehouder).
export function maakRitmonitor({ supabase, klantId, login, tijdzone = TIJDZONE, log = console }) {
  // Chauffeur koppelen (chauffeur_id bij postnl_chauffeur) doet sinds #562 de database:
  // trigger trg_rit_chauffeur_koppeling op ritten en trg_users_postnl_naam_koppelen op users.

  // Navigeert naar Planning → Ritmonitor. De Riteigenaar-grid (M&A Transport) is daar al
  // geselecteerd — daar NIET op klikken, anders deselecteer je 'm.
  async function openRitmonitor(page, depot) {
    const planningLoc = () => page.locator('a.mx-name-menuBar1-2, a[title="Planning"]').first()
    const isOAuth = () => page.url().includes('loginpostnl') || page.url().includes('/authorize')

    // Mendix start de OAuth-redirect soms pas ná de goto (tijdens het laden van de app). Poll
    // elke seconde tot het Planning-menu zichtbaar is of OAuth gedetecteerd wordt.
    async function waitForPlanning(maxMs = 90000) {
      const deadline = Date.now() + maxMs
      let herlogins = 0
      while (Date.now() < deadline) {
        if (isOAuth()) {
          if (herlogins >= 3) throw new Error(`Planning-menu niet bereikbaar na ${herlogins} herlogins`)
          herlogins++
          log.log(`[${depot.naam}] OAuth-redirect gedetecteerd (herlogin ${herlogins})...`)
          await login(page, depot)
          await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
          await page.waitForTimeout(2000)
          continue
        }
        if (await planningLoc().isVisible()) return
        await page.waitForTimeout(1000)
      }
      throw new Error(`Planning-menu niet zichtbaar na ${maxMs / 1000}s (url: ${page.url()})`)
    }

    // Een 407 geeft geen fout uit goto, alleen een leeg document (matransport#613).
    gooiBijProxyWeigering(await page.goto(depot.url, { waitUntil: 'networkidle', timeout: 60000 }).catch(() => null))
    await page.waitForTimeout(2000)
    await waitForPlanning()

    await planningLoc().click()
    await page.waitForTimeout(600)
    await page.locator('a[title="Ritmonitor"]').first().click()
    await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
    await page.waitForTimeout(1500)
  }

  // Geeft { rijen, leegBevestigd }. leegBevestigd = PostNL zegt zelf dat de lijst leeg is:
  // overview-grid gevonden, eigen riteigenaar links geselecteerd en de teller "0 tot 0 van 0" —
  // twee keer, 2 s na elkaar (#357). 0 rijen zonder die bevestiging = niet uitgelezen.
  async function leesRitmonitor(page) {
    const eerste = await leesRitmonitorEenmaal(page)
    if (eerste.rijen.length > 0 || !eerste.leegVolgensTeller) return { rijen: eerste.rijen, leegBevestigd: false }
    await page.waitForTimeout(2000)
    const tweede = await leesRitmonitorEenmaal(page)
    return { rijen: tweede.rijen, leegBevestigd: tweede.rijen.length === 0 && tweede.leegVolgensTeller }
  }

  async function leesRitmonitorEenmaal(page) {
    const result = await page.evaluate(() => {
      function cel(row, cls) {
        return row.querySelector(`td.${cls}`)?.getAttribute('title')?.trim() || ''
      }
      // De overview-grid is de tabel met kolomkop "Stops te doen" (column16).
      const tables = Array.from(document.querySelectorAll('.mx-grid-content table'))
      const target = tables.find(t => t.querySelector('th[title="Stops te doen"]'))
      if (!target) return { rows: [], leegVolgensTeller: false, debug: 'Ritmonitor overview-grid niet gevonden' }

      // Teller van de overview-grid zelf ("0 tot 0 van 0"), niet die van de Riteigenaar-grid.
      const gridWidget = target.closest('.mx-grid')
      const teller = gridWidget?.textContent.replace(/\s+/g, ' ').match(/(\d+)\s*tot\s*(\d+)\s*van\s*(\d+)/)
      const totaalVolgensTeller = teller ? Number(teller[3]) : null
      const eigenaarTabel = tables.find(t => t !== target && /riteigenaar/i.test(t.closest('.mx-grid')?.textContent || ''))
      const eigenaarGeselecteerd = !!eigenaarTabel?.querySelector('tbody tr.selected')

      // Brievenbus-kolom via de kop opzoeken: het kolomnummer kan per Mendix-instantie verschillen.
      const brievenbussCol = (() => {
        const th = Array.from(target.querySelectorAll('thead th')).find(
          h => /brievenbuss/i.test(h.getAttribute('title') || h.textContent || '')
        )
        return th ? Array.from(th.classList).find(c => c.startsWith('mx-name-column')) : null
      })()

      const trs = Array.from(target.querySelectorAll('tbody tr[data-id]'))
      const mapped = trs.map(row => ({
        kanaal:          cel(row, 'mx-name-column1'),
        ritnaam:         cel(row, 'mx-name-column2'),
        chauffeur:       cel(row, 'mx-name-column3'),
        laatsteActie:    cel(row, 'mx-name-column15'),
        stopsTotaal:     cel(row, 'mx-name-column6'),
        stopsTeDoen:     cel(row, 'mx-name-column16'),
        brievenbusstops: brievenbussCol ? cel(row, brievenbussCol) : '',
      }))
      const f = mapped[0]
      const leegVolgensTeller = totaalVolgensTeller === 0 && eigenaarGeselecteerd
      return { rows: mapped, leegVolgensTeller, debug: `${mapped.length} rijen, teller=${totaalVolgensTeller}, eigenaar=${eigenaarGeselecteerd}, eerste={ritnaam:"${f?.ritnaam}",totaal:"${f?.stopsTotaal}",teDoen:"${f?.stopsTeDoen}",brievenbuss:"${f?.brievenbusstops}",col:"${brievenbussCol}"}` }
    })
    log.log(`[DEBUG ritmonitor] ${result.debug}`)
    return { rijen: rijenUitScherm(result.rows), leegVolgensTeller: result.leegVolgensTeller }
  }

  // Leest wat er staat, plant en schrijft. Een databasefout gooit (nooit stil).
  async function opslaanMonitor(rijen, datum, depotNaam, leegBevestigd = false) {
    const nu = new Date().toISOString()
    const { data: bestaande, error } = await supabase
      .from('ritten').select(BESTAANDE_KOLOMMEN)
      // klant_id erbij (#462): twee klanten op dezelfde stack kunnen hetzelfde depot hebben.
      .eq('klant_id', klantId).eq('datum', datum).eq('depot', depotNaam)
    if (error) throw databaseFout('ritten lezen', error)
    const plan = planMonitor({ bestaande, rijen, datum, depot: depotNaam, klantId, nu, leegBevestigd, tijdzone })
    log.log(`[${depotNaam}] Ritmonitor-run: ${rijen.length} gelezen, ${bestaande?.length ?? 0} bestaand`)
    await Promise.all([
      ...plan.updates.map(({ id, velden }) => vereis(supabase.from('ritten').update(velden).eq('id', id).eq('klant_id', klantId), 'rit bijwerken')),
      plan.inserts.length ? vereis(supabase.from('ritten').insert(plan.inserts), 'ritten aanmaken') : null,
      plan.logRijen.length ? vereis(supabase.from('ritmonitor_log').insert(plan.logRijen), 'ritmonitor_log') : null,
    ])
    log.log(`[${depotNaam}] Ritmonitor ${datum}: bijgewerkt ${plan.updates.length}, nieuw ${plan.inserts.length}`)
    return plan
  }

  return { openRitmonitor, leesRitmonitor, opslaanMonitor }
}

// Puur: rijen zoals het scherm ze geeft → rijen voor planMonitor.
export function rijenUitScherm(rows) {
  return rows
    .filter(r => r.ritnaam && /^\d{3,4}/.test(r.ritnaam) && getalScherm(r.stopsTotaal) !== null)
    .map(r => {
      const ritnummer = normaliseerRitnummer(r.ritnaam.match(/^\d+/)?.[0] || '')
      return {
        ritnummer,
        ritnaam:         r.ritnaam,
        chauffeur:       r.chauffeur || null,
        kanaal:          r.kanaal || null,
        laatsteActie:    r.laatsteActie || null,
        stopsTotaal:     getalScherm(r.stopsTotaal),
        stopsTeDoen:     getalScherm(r.stopsTeDoen),
        brievenbusstops: getalScherm(r.brievenbusstops),
        // Ad-ritten (avond, kanaal AD) krijgen geen shiftlabel — er is geen shift_tijden-data
        // voor avondritten, en het eerste ritnummer-cijfer zou anders een shift suggereren.
        shift:           isAdKanaal(r.kanaal) ? null : (ritnummer.charAt(0) || null),
      }
    })
}
