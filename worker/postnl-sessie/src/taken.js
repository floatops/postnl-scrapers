// Het takenregister van de sessiehouder (floatops/matransport#562). Een taak is een definitie,
// geen script: wanneer hij mag, hoe dringend hij is, hoe lang hij mag duren. De rij (rij.js), het
// herstel, het slot, de opnames en de run-log werken voor elke taak hetzelfde. Een nieuwe taak is
// één regel hier plus een handler in handlers.js.
//
// `volgende(dag, nu, cfg)` is puur en geeft:
//   { nu: true, args }  → nu uitvoeren
//   { om: Date }        → niet nu, wel om dit tijdstip
//   null                → vandaag niet (meer)
// `dag` is de dagstatus van één depot (zie dagstatus.js).
import { minutenNl, weekdagNl } from '../../credentials-shared/src/postnl/tekst.js'
import { hhmmNaarMin } from './instellingen.js'

const MIN = 60_000

// Datum + "HH:MM" (NL) als Date, op dezelfde dag als `nu`.
function opTijd(nu, hhmm) {
  return new Date(nu.getTime() + (hhmmNaarMin(hhmm) - minutenNl(nu)) * MIN - (nu.getSeconds() * 1000 + nu.getMilliseconds()))
}

const rustdag = (nu, cfg) => cfg.rustdagen.includes(weekdagNl(nu))
const voorTijd = (nu, hhmm) => minutenNl(nu) < hhmmNaarMin(hhmm)

// De shifts die nog een definitieve lezing nodig hebben, op volgorde van deadline.
// Shifts die nog gecontroleerd moeten worden: nog niet definitief, of via het vangnet gelezen en
// nog niet geautoriseerd (hooguit naVangnetKijkenMin na het vangnet).
// De vorige werkdag (zondag en andere rustdagen overslaan), als 'JJJJ-MM-DD'.
export function vorigeWerkdag(datum, rustdagen = [0]) {
  const d = new Date(`${datum}T12:00:00Z`)
  for (let i = 0; i < 7; i++) {
    d.setUTCDate(d.getUTCDate() - 1)
    if (!rustdagen.includes(d.getUTCDay())) return d.toISOString().slice(0, 10)
  }
  return null
}

export function openShifts(dag, nu = null, cfg = null) {
  const kijkMs = (cfg?.naVangnetKijkenMin ?? 0) * MIN
  return Object.entries(dag.shifts ?? {})
    .filter(([, s]) => !s.definitiefOm
      || (s.vangnet && !s.geautoriseerdOm && nu && nu.getTime() - new Date(s.definitiefOm).getTime() < kijkMs))
    .sort(([, a], [, b]) => (a.deadline ?? '').localeCompare(b.deadline ?? ''))
}

export function ritmonitorActief(dag, nu, cfg) {
  if (rustdag(nu, cfg) || !voorTijd(nu, cfg.eindtijd)) return false
  const geautoriseerd = Object.values(dag.shifts ?? {}).some(s => s.geautoriseerdOm || s.vangnet)
  return geautoriseerd || !voorTijd(nu, cfg.ritmonitorUiterlijk)
}

export const TAKEN = [
  {
    // Uitgevoerd in de open sessie (handlers.planner). schrijft: vóór de opdracht een verse sessie
    // als de oude dicht bij haar gemeten einde zit.
    naam: 'planner', prioriteit: 100, opAanvraag: true, schrijft: true, worker: 'postnl-planner',
    volgende: (dag) => (dag.aanvragen ?? []).some(a => a.soort === 'planner') ? { nu: true, args: dag.aanvragen.find(a => a.soort === 'planner') } : null,
  },
  {
    // RVA-opdracht uit de app (matransport#569): alle wijzigingen van één Opslaan, op één rit-dag,
    // in het RVA-tabblad van deze sessie. De oudste eerst; de lus doet één taak tegelijk, dus een
    // lopende opdracht wordt nooit onderbroken. Ook 's nachts en op zondag (alleen cfg.rva telt).
    naam: 'rva', prioriteit: 95, opAanvraag: true, schrijft: true, tab: 'rva', worker: 'postnl-rva',
    volgende: (dag, nu, cfg) => (cfg.rva && (dag.aanvragen ?? []).some(a => a.soort === 'rva')) ? { nu: true, args: dag.aanvragen.find(a => a.soort === 'rva') } : null,
  },
  {
    naam: 'depotUrl', prioriteit: 90, opAanvraag: true, worker: 'postnl-depot-url',
    volgende: (dag) => (dag.aanvragen ?? []).some(a => a.soort === 'depotUrl') ? { nu: true, args: dag.aanvragen.find(a => a.soort === 'depotUrl') } : null,
  },
  {
    // Eén volle lezing zodra de dag in PostNL staat: ritten aanmaken, deadlines vastleggen.
    naam: 'ochtend', prioriteit: 50, worker: 'postnl-dagplanning',
    volgende: (dag, nu, cfg) => {
      if (rustdag(nu, cfg) || dag.ochtend?.gelezenOm || !voorTijd(nu, cfg.eindtijd)) return null
      if (voorTijd(nu, cfg.ochtendVanaf)) return { om: opTijd(nu, cfg.ochtendVanaf) }
      const wacht = dag.ochtend?.nietBeschikbaarTot ? new Date(dag.ochtend.nietBeschikbaarTot) : null
      if (wacht && wacht > nu) return { om: wacht }
      return { nu: true, args: {} }
    },
  },
  {
    // Na de deadline van een shift: kijken of hij geautoriseerd is en dan één definitieve lezing.
    // Een shift zonder bekende deadline wordt vanaf de ochtendlezing elke hercontrole bekeken:
    // de autorisatie is het echte omslagpunt, de deadline alleen wanneer we gaan kijken.
    // Na de deadline van een shift: zo snel als het kan kijken of hij geautoriseerd is (eigenaar
    // 03-11), om de beurt met de taak plannen (zelfde prioriteit, wat het langst geleden is), onder
    // de ritmonitor. Pas bij de autorisatie staan de cijfers vast: PostNL schoof op 03-11 na de
    // deadline nog tientallen stops tussen ritten (Den Hoorn 218: 183 → 45).
    naam: 'definitief', prioriteit: 20, worker: 'postnl-dagplanning',
    volgende: (dag, nu, cfg) => {
      if (rustdag(nu, cfg) || !dag.ochtend?.gelezenOm || !voorTijd(nu, cfg.eindtijd)) return null
      let beste = null
      let eerst = null
      for (const [shift, s] of openShifts(dag, nu, cfg)) {
        const vanaf = s.deadline ? new Date(s.deadline) : new Date(dag.ochtend.gelezenOm)
        const volgendeControle = s.laatsteControleOm ? new Date(new Date(s.laatsteControleOm).getTime() + cfg.hercontroleMin * MIN) : vanaf
        const om = new Date(Math.max(vanaf.getTime(), volgendeControle.getTime()))
        const laatst = s.laatsteControleOm ? new Date(s.laatsteControleOm).getTime() : 0
        if (om <= nu) { if (!beste || laatst < beste.laatst) beste = { shift, laatst } }
        else if (!eerst || om < eerst) eerst = om
      }
      if (beste) return { nu: true, args: { shift: beste.shift }, laatst: beste.laatst }
      return eerst ? { om: eerst } : null
    },
  },
  {
    naam: 'ritmonitor', prioriteit: 30, worker: 'postnl-ritmonitor',
    volgende: (dag, nu, cfg) => {
      if (rustdag(nu, cfg) || !voorTijd(nu, cfg.eindtijd)) return null
      if (!ritmonitorActief(dag, nu, cfg)) {
        // Wakker worden bij het vangnet-tijdstip; een autorisatie eerder komt via de taak 'definitief'.
        return voorTijd(nu, cfg.ritmonitorUiterlijk) ? { om: opTijd(nu, cfg.ritmonitorUiterlijk) } : null
      }
      const laatst = dag.ritmonitor?.laatsteOm ? new Date(dag.ritmonitor.laatsteOm) : null
      const om = laatst ? new Date(laatst.getTime() + cfg.ritmonitorIntervalSec * 1000) : nu
      return om <= nu ? { nu: true, args: {} } : { om }
    },
  },
  {
    // Het RVA-tabblad levend houden (matransport#569): elke rvaWakkerMin het Rittenoverzicht
    // verversen. Verlopen? Dan logt de handler in datzelfde tabblad opnieuw in, vóór een opdracht
    // erop moet wachten. Met rvaAltijd ook 's nachts en op zondag: dan stopt de lus nooit vanzelf.
    // Prioriteit 25: boven 'plannen' (20), dat 's ochtends continu aan de beurt is, onder de
    // ritmonitor. Goedkoop en hooguit eens per rvaWakkerMin, dus hij loopt altijd tussendoor.
    naam: 'rvaWakker', prioriteit: 25, tab: 'rva', worker: null,
    volgende: (dag, nu, cfg) => {
      if (!cfg.rva || !cfg.rvaWakkerMin) return null
      if (!cfg.rvaAltijd && (rustdag(nu, cfg) || !voorTijd(nu, cfg.eindtijd))) return null
      const om = dag.rva?.wakkerOm ? new Date(new Date(dag.rva.wakkerOm).getTime() + cfg.rvaWakkerMin * MIN) : nu
      return om <= nu ? { nu: true, args: {} } : { om }
    },
  },
  {
    // Rijvolgorde compleet en vers houden (matransport#573): één rit-dag uit RVA lezen die nog
    // ontbreekt of ouder is dan rvaBijlezenUur, naar rva_regels. Zo hoeft niemand een lijst op te
    // vragen, en komt een mislukte rit-dag vanzelf terug. Laagste prioriteit: alleen als er niets
    // anders te doen is; met rvaAltijd ook 's nachts.
    naam: 'rvaBijlezen', prioriteit: 3, tab: 'rva', worker: null,
    volgende: (dag, nu, cfg) => {
      if (!cfg.rva || !cfg.rvaBijlezenSec) return null
      if (!cfg.rvaAltijd && (rustdag(nu, cfg) || !voorTijd(nu, cfg.eindtijd))) return null
      const wacht = dag.rva?.bijlezenRust ? cfg.rvaBijlezenRustMin * MIN : cfg.rvaBijlezenSec * 1000
      const om = dag.rva?.bijlezenOm ? new Date(new Date(dag.rva.bijlezenOm).getTime() + wacht) : nu
      return om <= nu ? { nu: true, args: {} } : { om }
    },
  },
  {
    // Stille tijd (bv. tussen de ochtendlezing en de eerste deadline): na wakkerHoudenMin zonder
    // andere taak de Dagplanning opnieuw openen. Alleen met sessieOpenHouden en na de ochtendlezing.
    naam: 'wakker', prioriteit: 5, worker: null,
    volgende: (dag, nu, cfg) => {
      if (!cfg.sessieOpenHouden || !cfg.wakkerHoudenMin || rustdag(nu, cfg) || !voorTijd(nu, cfg.eindtijd) || !dag.ochtend?.gelezenOm) return null
      const om = new Date(new Date(dag.laatsteTaakOm ?? dag.ochtend.gelezenOm).getTime() + cfg.wakkerHoudenMin * MIN)
      return om <= nu ? { nu: true, args: {} } : { om }
    },
  },
  {
    // Plannen-tab vanzelf bijwerken (#562): shifts waarvan de deadline nog niet voorbij is, plus één
    // laatste lezing van de stops na de autorisatie (hieronder). Zo snel als het kan: is al het
    // andere gedaan (lagere prioriteit dan de ritmonitor), dan de ritten of de stops van een shift,
    // om de beurt wat het langst geleden is. Een shift die iemand in Plannen open heeft, gaat voor.
    naam: 'plannen', prioriteit: 20, worker: null,
    volgende: (dag, nu, cfg) => {
      if (!cfg.plannenVerversen || rustdag(nu, cfg) || !voorTijd(nu, cfg.eindtijd) || !dag.ochtend?.gelezenOm) return null
      // Na de autorisatie één laatste keer de stops van die shift: PostNL schuift na de deadline nog
      // stops tussen ritten (03-11: Den Hoorn 218 van 183 naar 45), en pas dan liggen de adressen per
      // rit vast (matransport#600). Een gewone kandidaat, met de beurtrol via stopsOm en minstens een
      // minuut ertussen: lukt de lezing niet, dan mag hij de rij niet blokkeren.
      const p = dag.plannen ?? {}
      const definitief = Object.entries(dag.shifts ?? {}).filter(([k, s]) => s.geautoriseerdOm && !p.stopsDefinitiefOm?.[k]).map(([k]) => k).sort()
      const open = Object.entries(dag.shifts ?? {}).filter(([k, s]) => s.deadline && new Date(s.deadline) > nu && !definitief.includes(k)).map(([k]) => k).sort()
      if (!open.length && !definitief.length) return null
      const kijkers = dag.plannenKijkers ?? []
      const tijd = (iso) => (iso ? new Date(iso).getTime() : 0)
      const kandidaten = [
        ...definitief.map(shift => ({ laatst: tijd(p.stopsOm?.[shift]), min: 1, rang: 1, args: { soort: 'stops', shifts: [shift], naAutorisatie: true } })),
        ...(open.length ? [{ laatst: tijd(p.rittenOm), min: cfg.plannenRittenMin, rang: 0, args: { soort: 'ritten', shifts: open } }] : []),
        ...open.map((shift) => {
          const kijkt = kijkers.includes(shift)
          return {
            // Voorsprong: een bekeken shift telt alsof hij langer geleden ververst is.
            laatst: tijd(p.stopsOm?.[shift]) - (kijkt ? cfg.plannenKijkerVoorsprongSec * 1000 : 0),
            min: kijkt ? cfg.plannenKijkerStopsMin : cfg.plannenStopsMin,
            rang: kijkt ? 1 : 2,
            args: { soort: 'stops', shifts: [shift] },
          }
        }),
      ].map(k => ({ ...k, om: Math.max(k.laatst + k.min * MIN, 0) }))
      const klaar = kandidaten.filter(k => k.om <= nu.getTime()).sort((a, b) => (a.laatst - b.laatst) || (a.rang - b.rang))
      if (klaar.length) return { nu: true, args: klaar[0].args, laatst: klaar[0].laatst }
      return { om: new Date(Math.min(...kandidaten.map(k => k.om))) }
    },
  },
  {
    // Na middernacht de vorige werkdag nog één keer helemaal lezen (#562): alles is dan geautoriseerd,
    // dus de cijfers liggen vast. Alleen verschillen gaan naar ritten. Eén keer per dag.
    naam: 'gisteren', prioriteit: 45, worker: 'postnl-dagplanning',
    volgende: (dag, nu, cfg) => {
      if (!cfg.gisterenNalezen || dag.gisteren?.gelezenOm || !voorTijd(nu, cfg.eindtijd)) return null
      if (voorTijd(nu, cfg.gisterenVanaf)) return { om: opTijd(nu, cfg.gisterenVanaf) }
      if (dag.gisteren?.nietBeschikbaar) return null
      return { nu: true, args: { datum: vorigeWerkdag(dag.datum, cfg.rustdagen) } }
    },
  },
]

export const TAAK = Object.fromEntries(TAKEN.map(t => [t.naam, t]))
