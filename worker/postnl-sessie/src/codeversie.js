// Nieuwe code in de checkout: alleen herstarten als het de sessiehouder raakt (floatops/matransport#562).
// Elke herstart is een nieuwe login per depot. Op 03-11 gaf een commit die alleen postnl-rva
// wijzigde toch een herstart van de sessiehouder.
import { execFileSync } from 'node:child_process'

// De mappen waar de sessiehouder code uit laadt (direct of via import).
// postnl-rva sinds de RVA-taak (matransport#569): een RVA-commit geeft dus weer een herstart.
export const MAPPEN = ['worker/postnl-sessie/', 'worker/credentials-shared/', 'worker/postnl-planner/', 'worker/postnl-ritmonitor/', 'worker/postnl-rva/']

export function raaktSessiehouder(paden) {
  return paden.some(p => MAPPEN.some(m => p.startsWith(m)))
}

export function codeVersie() {
  try { return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', timeout: 5000 }).trim() } catch { return null }
}

// Gewijzigde paden tussen twee versies; null als git het niet weet (dan voor de zekerheid herstarten).
export function gewijzigdePaden(van, naar) {
  try {
    return execFileSync('git', ['diff', '--name-only', van, naar], { encoding: 'utf8', timeout: 10000 }).split('\n').map(s => s.trim()).filter(Boolean)
  } catch { return null }
}
