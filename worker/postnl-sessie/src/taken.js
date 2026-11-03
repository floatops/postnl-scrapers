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
    naam: 'definitief', prioriteit: 40, worker: 'postnl-dagplanning',
    volgende: (dag, nu, cfg) => {
      if (rustdag(nu, cfg) || !dag.ochtend?.gelezenOm || !voorTijd(nu, cfg.eindtijd)) return null
      let eerst = null
      for (const [shift, s] of openShifts(dag, nu, cfg)) {
        const vanaf = s.deadline ? new Date(s.deadline) : new Date(dag.ochtend.gelezenOm)
        const volgendeControle = s.laatsteControleOm ? new Date(new Date(s.laatsteControleOm).getTime() + cfg.hercontroleMin * MIN) : vanaf
        const om = new Date(Math.max(vanaf.getTime(), volgendeControle.getTime()))
        if (om <= nu) return { nu: true, args: { shift } }
        if (!eerst || om < eerst) eerst = om
      }
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
    // Plannen-tab vanzelf bijwerken (#562): alleen shifts waarvan de deadline nog niet voorbij is
    // (daarna kan er niet meer gepland worden). Ritten elke plannenRittenMin, stops per shift elke
    // plannenStopsMin, of plannenKijkerStopsMin als iemand die shift in Plannen open heeft.
    naam: 'plannen', prioriteit: 20, worker: null,
    volgende: (dag, nu, cfg) => {
      if (!cfg.plannenVerversen || rustdag(nu, cfg) || !voorTijd(nu, cfg.eindtijd) || !dag.ochtend?.gelezenOm) return null
      const open = Object.entries(dag.shifts ?? {}).filter(([, s]) => s.deadline && new Date(s.deadline) > nu).map(([k]) => k).sort()
      if (!open.length) return null
      const p = dag.plannen ?? {}
      const kijkers = dag.plannenKijkers ?? []
      const na = (iso, min) => (iso ? new Date(new Date(iso).getTime() + min * MIN) : nu)
      // Volgorde bij gelijke tijd: eerst de ritten, dan de shift die iemand bekijkt, dan de rest.
      const kandidaten = [
        { om: na(p.rittenOm, cfg.plannenRittenMin), rang: 0, args: { soort: 'ritten', shifts: open } },
        ...open.map(shift => ({
          om: na(p.stopsOm?.[shift], kijkers.includes(shift) ? cfg.plannenKijkerStopsMin : cfg.plannenStopsMin),
          rang: kijkers.includes(shift) ? 1 : 2,
          args: { soort: 'stops', shifts: [shift] },
        })),
      ].sort((a, b) => (a.om - b.om) || (a.rang - b.rang))
      const k = kandidaten[0]
      return k.om <= nu ? { nu: true, args: k.args } : { om: k.om }
    },
  },
]

export const TAAK = Object.fromEntries(TAKEN.map(t => [t.naam, t]))
