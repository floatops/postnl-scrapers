// Welke taak is nu aan de beurt? Puur (floatops/matransport#562).
// Kiest uit het register de taak die nu mag met de hoogste prioriteit; anders het vroegste
// tijdstip waarop er weer iets is. `sessieNodig` zegt of de browser open moet blijven.
import { TAKEN } from './taken.js'

export function kies(dag, nu, cfg, taken = TAKEN) {
  let beste = null
  let eerst = null
  for (const t of taken) {
    const v = t.volgende(dag, nu, cfg)
    if (!v) continue
    if (v.nu) {
      if (!beste || t.prioriteit > beste.taak.prioriteit) beste = { taak: t, args: v.args ?? {} }
    } else if (v.om && (!eerst || v.om < eerst.om)) {
      eerst = { om: v.om, taak: t }
    }
  }
  if (beste) return { taak: beste.taak, args: beste.args, sessieNodig: true }
  if (!eerst) return { wachtTot: null, sessieNodig: false }
  // De browser open houden als de volgende taak binnen `sluitNaLeegMin` komt (de ritmonitor elke
  // minuut); anders dicht en op tijd weer open, zodat er geen sessie onnodig open staat.
  const wachtMs = eerst.om.getTime() - nu.getTime()
  return { wachtTot: eerst.om, volgendeTaak: eerst.taak.naam, sessieNodig: wachtMs <= cfg.sluitNaLeegMin * 60_000 }
}
