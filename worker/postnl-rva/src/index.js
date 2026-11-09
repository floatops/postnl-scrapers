// postnl-rva — rijvolgorde per rit-dag aanpassen in PostNL RVA (floatops/matransport#569).
//
// Stap 1: alle handelingen uit de opnames van 03-11 uitvoeren en controleren. Later neemt de
// sessiehouder (postnl-sessie) dit over in een tweede tabblad van dezelfde sessie, en komt er een
// wachtrij vanuit de app. Uitleg: ../POSTNL_RVA.md.
//
// Een opdracht is een lijst handelingen op één rit-dag:
//   { rit: '<ritnaam>', dag: 'Ma'..'Za', handelingen: [
//       { soort: 'volgorde', regel: <sleutel>, nummer },
//       { soort: 'richting', regel, richting: 'Oplopend'|'Aflopend' },
//       { soort: 'knip', regel, tm },
//       { soort: 'samenvoegen', regel, naar: 'onder'|'boven' },
//       { soort: 'onderbreking', regel, minuten },
//       { soort: 'onderbreking_weg', regel } ] }
// <sleutel> = plan.regelSleutel(regel). Standaard echt (matransport#657); alleen de testscripts in scripts/ geven echt: false mee, dan eindigt alles met Annuleer.
import { regelSleutel, zetOpPlek, knipDelen, verschillen, revisieTijdTekst, ritRijen } from './plan.js'
import { meldingenOver, regelsUit, rittenUit, onderbrekingenUit, regelGuidsUit } from './lezen.js'
import * as rva from './scherm.js'

// Wat we na een handeling verwachten te zien, of null als dat niet vooraf vast te leggen is.
function verwacht(regels, h) {
  if (h.soort === 'volgorde') return zetOpPlek(regels, h.regel, h.nummer)
  if (h.soort === 'richting') return regels.map(r => (regelSleutel(r) === h.regel ? { ...r, richting: h.richting } : r))
  if (h.soort === 'knip') {
    const i = regels.findIndex(r => regelSleutel(r) === h.regel)
    return [...regels.slice(0, i), ...knipDelen(regels[i], h.tm), ...regels.slice(i + 1)]
  }
  return null
}

const UITVOEREN = {
  volgorde: (page, m, h) => rva.zetVolgorde(page, m, h.regel, h.nummer),
  richting: (page, m, h) => rva.zetRichting(page, m, h.regel, h.richting),
  knip: (page, m, h) => rva.knip(page, m, h.regel, h.tm),
  samenvoegen: (page, m, h) => rva.voegSamen(page, m, h.regel, h.naar),
  onderbreking: (page, m, h) => rva.onderbreking(page, m, h.regel, h.minuten),
  onderbreking_weg: (page, m, h) => rva.verwijderOnderbreking(page, m, h.regel),
}

// Annuleer zet de LAATST OPGESLAGEN REVISIE terug, niet de stand van vlak voor Wijzig (proef
// 03-11: PostNL had na 15-09 een straat uit de lijst gehaald zonder revisie; Annuleer zette hem
// terug). Wijkt de stand van nu af van de actieve revisie, dan eerst Wijzig + Opslaan zonder
// wijziging: een revisie van precies deze stand. Wijzig begint wél vanaf de stand van nu.
// Geeft { basis: true } als er zo'n basisrevisie gemaakt is. Op de rit-dag-pagina aanroepen.
export async function zorgVoorBasisRevisie(page, mendix, { echt = true, log = console } = {}) {
  const nu = await rva.leesRegels(page)
  const { revisies } = await rva.leesRevisies(page, mendix)
  const actief = revisies.find(r => r.actief)
  const afwijking = actief?.regels ? verschillen(actief.regels, nu) : ['geen actieve revisie met inhoud gevonden']
  if (!afwijking.length) return { basis: false }
  if (!echt) throw new rva.RvaFout('revisie_wijkt_af', `Annuleer is hier niet veilig: de laatst opgeslagen revisie wijkt af van wat er nu staat (${afwijking.join('; ')})`)
  await rva.startWijzig(page, mendix)
  await rva.opslaan(page, mendix)
  const na = verschillen(nu, await rva.leesRegels(page))
  if (na.length) throw new rva.RvaFout('controle', `Basisrevisie wijkt af van de stand ervoor: ${na.join('; ')}`)
  log.log(`  basisrevisie gemaakt (de laatst opgeslagen revisie week af: ${afwijking.join('; ')})`)
  return { basis: true }
}

// Voert de opdracht uit in de open RVA-pagina. Geeft per handeling wat er gebeurde. Een fout
// midden in een handeling: geen herhaling, wel Annuleer (terug naar de basisrevisie), en dan gooien.
// opStap({ stap, voortgang }) meldt elke stap (voor de voortgangsbalk in de app); mag niet gooien.
export async function voerUit(page, mendix, opdracht, { echt = true, log = console, opStap = async () => {}, gestopt = () => false } = {}) {
  const totaal = opdracht.handelingen.length
  const meld = (stap, voortgang) => Promise.resolve().then(() => opStap({ stap, voortgang })).catch(() => {})
  await meld('Rit-dag openen', 10)
  await rva.openRitDag(page, mendix, opdracht.rit, opdracht.dag)
  // Een achtergebleven bewerkstand van dit account (vorige poging) eerst weg: Revisies werkt
  // alleen buiten de bewerkstand. Die Annuleer zet de basisrevisie van die poging terug.
  if (await rva.inBewerkstand(page)) await rva.annuleer(page, mendix)
  const { toegevoegd: rechtenToegevoegd } = await zorgVoorRechten(page, mendix, opdracht.rit, opdracht.dag, { echt, log, meld })
  await meld('Controleren wat er nu in RVA staat', 15)
  await zorgVoorBasisRevisie(page, mendix, { echt, log })
  const voor = await rva.leesRegels(page)
  await meld('Bewerken starten', 20)
  await rva.startWijzig(page, mendix)
  const stappen = []
  try {
    for (const [i, h] of opdracht.handelingen.entries()) {
      // De sessiehouder gaf de opdracht op (over de taaklimiet, matransport#600): de catch hieronder doet Annuleer.
      if (gestopt()) throw new rva.RvaFout('controle', 'De opdracht duurde te lang en is gestopt; de wijzigingen zijn niet opgeslagen')
      await meld(`Wijziging ${i + 1} van ${totaal}`, 20 + Math.round((i / totaal) * 65))
      const fn = UITVOEREN[h.soort]
      if (!fn) throw new rva.RvaFout('opdracht', `Onbekende handeling: ${h.soort}`)
      const nu = await rva.leesRegels(page)
      const doel = verwacht(nu, h)
      const antwoorden = await fn(page, mendix, h)
      const na = await rva.leesRegels(page)
      const afwijking = doel ? verschillen(doel, na) : []
      const meldingen = meldingenOver(antwoorden).map(x => x.tekst)
      stappen.push({ nr: i + 1, soort: h.soort, ok: afwijking.length === 0, afwijking, meldingen })
      log.log(`  ${i + 1}. ${h.soort}: ${afwijking.length ? `AFWIJKING (${afwijking.join('; ')})` : 'ok'}${meldingen.length ? ` — PostNL: ${meldingen.join(' / ')}` : ''}`)
      if (afwijking.length) throw new rva.RvaFout('controle', `${h.soort}: ${afwijking.join('; ')}`)
    }
    // Ook hier: een opgegeven opdracht niet alsnog opslaan terwijl de lus al verder is.
    if (gestopt()) throw new rva.RvaFout('controle', 'De opdracht duurde te lang en is gestopt; de wijzigingen zijn niet opgeslagen')
  } catch (err) {
    await rva.annuleer(page, mendix).catch(() => {})
    err.stappen = stappen
    throw err
  }
  const kladversie = await rva.leesRegels(page)
  await meld(echt ? 'Opslaan in RVA' : 'Terugdraaien (alleen testscript)', 90)
  if (echt) await rva.opslaan(page, mendix)
  else await rva.annuleer(page, mendix)
  const na = await rva.leesRegels(page)
  // Opgeslagen: wat nu in beeld staat moet de kladversie zijn. Proef: weer gelijk aan het begin.
  const controle = echt ? verschillen(kladversie, na) : verschillen(voor, na)
  if (controle.length) throw Object.assign(new rva.RvaFout('controle', `${echt ? 'Na Opslaan' : 'Na Annuleer'}: ${controle.join('; ')}`), { stappen })
  return { voor, kladversie, na, stappen, opgeslagen: echt, rechtenToegevoegd }
}

// ── Voor het scherm Rijvolgorde in de app (matransport#573) ─────────────────

// Alleen een ritverantwoordelijke ziet Wijzig. Staat het eigen account er niet bij, dan zet de
// worker het er echt zelf bij (keuze eigenaar 03-11): de andere namen blijven, en daarna gaat
// de rit-dag opnieuw open. Alleen een testscript met echt: false krijgt dan fout geen_rechten. Op de rit-dag-pagina.
export async function zorgVoorRechten(page, mendix, rit, dag, { echt = true, log = console, meld = async () => {} } = {}) {
  if (await rva.magWijzigen(page)) return { toegevoegd: false }
  if (!echt) throw new rva.RvaFout('geen_rechten', 'Het account staat niet als ritverantwoordelijke bij deze rit (testscript zonder --echt: niet zelf toegevoegd)')
  const eigen = await rva.eigenAccount(page)
  if (!eigen) throw new rva.RvaFout('geen_rechten', 'Geen Wijzig-knop, en de naam van het eigen account is niet te lezen')
  await meld('Account toevoegen als ritverantwoordelijke', 12)
  const { gekozen, alle } = await rva.leesVerantwoordelijken(page, mendix, rit, dag)
  if (gekozen.includes(eigen)) throw new rva.RvaFout('geen_rechten', 'Geen Wijzig-knop, terwijl het account al ritverantwoordelijke is')
  if (!alle.includes(eigen)) throw new rva.RvaFout('geen_rechten', 'Het eigen account staat niet in de keuzelijst Ritverantwoordelijke')
  await rva.zetVerantwoordelijken(page, mendix, rit, dag, [...gekozen, eigen])
  log.log('  ritverantwoordelijke: eigen account toegevoegd')
  await rva.openRitDag(page, mendix, rit, dag)
  if (!(await rva.magWijzigen(page))) throw new rva.RvaFout('geen_rechten', 'Account toegevoegd als ritverantwoordelijke, maar nog geen Wijzig-knop')
  return { toegevoegd: true }
}

// Een revisie in de vorm voor de app: zonder guid, regels alleen met wat het scherm toont.
const kortRegel = (r) => ({ postcode: r.postcode, straat: r.straat, van: r.van, tm: r.tm, evenOneven: r.evenOneven, richting: r.richting })
export const REVISIES_MAX = 6

// De huidige stand van één rit-dag lezen, zonder iets te wijzigen: regels, onderbrekingen (naRegel
// als regelsleutel), de laatste revisies met inhoud, en of hij op slot staat. Een achtergebleven
// bewerkstand blijft staan (het kan iemand zijn die met dezelfde login in RVA werkt).
export async function leesRitDag(page, mendix, rit, dag, { revisies = true } = {}) {
  const { antwoorden, opSlot } = await rva.openRitDag(page, mendix, rit, dag)
  const regels = await rva.leesRegels(page)
  const geknipt = new Map(regelsUit(antwoorden).map(r => [regelSleutel(r), r.geknipt]))
  const guids = regelGuidsUit(antwoorden, regelSleutel)
  const onderbrekingen = onderbrekingenUit(antwoorden)
    .map(o => ({ soort: o.soort, minuten: o.minuten, naRegel: guids.get(o.naRegel) ?? null }))
    .filter(o => o.naRegel)
  const bewerkstand = await rva.inBewerkstand(page)
  // Revisies zijn bijzaak: lukt het lezen niet (geen revisies, venster traag), dan het venster dicht en
  // zonder revisies verder (null = niet gelezen; de oude blijven dan in matransport staan).
  let rev = []
  if (revisies && !bewerkstand) {
    rev = await rva.leesRevisies(page, mendix).then(x => x.revisies).catch(async () => {
      await rva.sluitVenster(page, mendix).catch(() => {}) // bewust: er stond misschien geen venster open
      return null
    })
  }
  return {
    regels: regels.map(({ oudeVolgorde, ...r }) => ({ ...r, geknipt: geknipt.get(regelSleutel(r)) ?? false })),
    onderbrekingen,
    revisies: rev == null ? null : rev.slice(0, REVISIES_MAX).map(x => ({ gemaaktOp: x.gemaaktOp, door: x.door, actief: x.actief, regels: x.regels?.map(kortRegel) ?? null })),
    vergrendeld: opSlot || bewerkstand,
  }
}

// Kopieer weekdag (slaat bij PostNL direct op). Controleert de melding van PostNL.
export async function kopieerNaar(page, mendix, rit, dag, naar, { echt = true, log = console, meld = async () => {} } = {}) {
  await meld('Rit-dag openen', 20)
  await rva.openRitDag(page, mendix, rit, dag)
  if (await rva.inBewerkstand(page)) await rva.annuleer(page, mendix)
  await zorgVoorRechten(page, mendix, rit, dag, { echt, log, meld })
  await meld(`Kopiëren naar ${naar.join(', ')}`, 60)
  const { melding } = await rva.kopieerWeekdag(page, mendix, naar)
  if (!/succesvol/i.test(melding)) throw new rva.RvaFout('controle', `Kopiëren: PostNL meldde "${melding.slice(0, 160)}"`)
  return { melding }
}

// Een revisie terugzetten (slaat bij PostNL direct op). `gemaaktOp` in ms, zoals in de app.
export async function revisieTerug(page, mendix, rit, dag, gemaaktOp, { echt = true, log = console, meld = async () => {} } = {}) {
  await meld('Rit-dag openen', 20)
  await rva.openRitDag(page, mendix, rit, dag)
  if (await rva.inBewerkstand(page)) await rva.annuleer(page, mendix)
  await zorgVoorRechten(page, mendix, rit, dag, { echt, log, meld })
  await meld('Revisie terugzetten', 60)
  await rva.zetRevisieTerug(page, mendix, revisieTijdTekst(gemaaktOp))
}

// Ritverantwoordelijken zetten (elke klik slaat direct op). Het eigen account moet erbij blijven:
// zonder kan dit account de rit niet meer bewerken, en de app dus ook niet.
export async function zetVerantwoordelijkenVeilig(page, mendix, rit, dag, namen, { echt = true } = {}) {
  const eigen = await rva.eigenAccount(page)
  if (!eigen) throw new rva.RvaFout('controle', 'De naam van het eigen account is niet te lezen; uit voorzorg niets gewijzigd')
  if (!namen.includes(eigen)) throw new rva.RvaFout('controle', 'Het eigen account moet ritverantwoordelijke blijven, anders kan FloatOps deze rit niet meer bewerken')
  await rva.zetVerantwoordelijken(page, mendix, rit, dag, namen)
  return (await rva.leesVerantwoordelijken(page, mendix, rit, dag)).gekozen
}

// Het Rittenoverzicht als rijen voor rva_ritten (plan.ritRijen).
// Alle pagina's (20 rijen per pagina, matransport#573).
export async function leesRitten(page, mendix) {
  const { antwoorden, rijen, compleet } = await rva.leesAlleRitten(page, mendix)
  return Object.assign(ritRijen(rittenUit(antwoorden), rijen), { compleet })
}

export * from './scherm.js'
export { regelSleutel, stappenVoorVolgorde, knipDelen, verschillen, revisieTijdTekst, ritRijen, rittenTeSchrijven, rittenTeVerwijderen, volgendeBijlezen } from './plan.js'
export { regelsUit, ritDagUit, rittenUit, revisiesUit, onderbrekingenUit, regelGuidsUit } from './lezen.js'
