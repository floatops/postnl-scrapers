// Nieuwe code in de checkout: alleen herstarten als het de sessiehouder raakt (floatops/matransport#562).
// Elke herstart is een nieuwe login per depot. Op 03-11 gaf een commit die alleen postnl-rva
// wijzigde toch een herstart van de sessiehouder.
import { execFileSync } from 'node:child_process'

// De mappen waar de sessiehouder code uit laadt (direct of via import).
// postnl-rva sinds de RVA-taak (matransport#569): een RVA-commit geeft dus weer een herstart.
export const MAPPEN = ['worker/postnl-sessie/', 'worker/credentials-shared/', 'worker/postnl-planner/', 'worker/postnl-ritmonitor/', 'worker/postnl-rva/']

// Bestanden in die mappen die de sessiehouder nooit laadt: documentatie en tests. Op 08-11
// herstartte een commit die alleen POSTNL_SESSIE.md wijzigde de sessiehouder op A en B (een login
// per depot, minuten niet lezen; matransport#638). package.json en package-lock.json tellen wel.
export function nietGeladen(pad) {
  return /\.md$/i.test(pad) || /\/test\//.test(pad)
}

export function raaktSessiehouder(paden) {
  return paden.some(p => MAPPEN.some(m => p.startsWith(m)) && !nietGeladen(p))
}

// Stack A en B delen één checkout (/opt/postnl-scrapers, van root); Stack B draait als
// floatops-b. Zonder deze vlag weigert git daar met "detected dubious ownership" en zag de
// sessiehouder van Stack B nieuwe code nooit (floatops/matransport#622: op 07-11 draaide hij zo
// half op oude, half op nieuwe code en faalde Plannen steeds). Alleen-lezen aanroepen, dus veilig.
export const GIT_VOORVOEGSEL = ['-c', 'safe.directory=*']

export function gitArgs(...args) {
  return [...GIT_VOORVOEGSEL, ...args]
}

let laatsteFout = null
// Waarom de laatste codeVersie() null gaf (voor de melding); null als het lukte.
export function codeVersieFout() { return laatsteFout }

export function codeVersie() {
  try {
    const v = execFileSync('git', gitArgs('rev-parse', 'HEAD'), { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
    laatsteFout = null
    return v || null
  } catch (err) {
    laatsteFout = String(err?.stderr || err?.message || err).split('\n').map(s => s.trim()).filter(Boolean)[0] ?? 'onbekend'
    return null
  }
}

// Gewijzigde paden tussen twee versies; null als git het niet weet (dan voor de zekerheid herstarten).
export function gewijzigdePaden(van, naar) {
  try {
    return execFileSync('git', gitArgs('diff', '--name-only', van, naar), { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'pipe'] }).split('\n').map(s => s.trim()).filter(Boolean)
  } catch { return null }
}

// Bij de start een paar keer proberen: één losse hapering van git (time-out, fork) mag niet
// meteen "onbekend" worden, want dat kost later een herstart.
export async function codeVersieBijStart({ pogingen = 3, wachtMs = 1500 } = {}) {
  for (let i = 1; ; i++) {
    const v = codeVersie()
    if (v || i >= pogingen) return v
    await new Promise(r => setTimeout(r, wachtMs))
  }
}

// Wanneer HEAD voor het laatst verschoof (de deploy doet `git checkout -B`, dat schrijft de
// reflog), in ms; null als git het niet weet.
export function headVerschovenOp() {
  try {
    const uit = execFileSync('git', gitArgs('log', '-g', '-1', '--format=%gd', '--date=unix', 'HEAD'), { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
    const m = /@\{(\d+)\}/.exec(uit)
    return m ? Number(m[1]) * 1000 : null
  } catch { return null }
}

// Wat de codecontrole moet doen. `versie` = de versie waarmee dit proces startte (null = toen
// onbekend), `nu` = de versie in de checkout nu, `paden` = gewijzigdePaden(versie, nu),
// `verschovenNaStart` = of HEAD verschoof na de start van dit proces (true/false, null = onbekend).
//   'gelijk'        niets veranderd
//   'onbekend'      git geeft nu geen versie: melden, niet herstarten
//   'aannemen'      startversie was onbekend, nu bekend, en HEAD verschoof niet sinds de start:
//                   dit proces draait die versie al, geen herstart (geen onnodige login)
//   'herstart'      nieuwe code die de sessiehouder raakt, of de startversie was onbekend en
//                   HEAD verschoof na de start (of dat is niet te zeggen): voor de zekerheid
//   'geen_herstart' nieuwe code die alleen andere workers raakt
export function beslisCode(versie, nu, paden, { verschovenNaStart = null } = {}) {
  if (!nu) return 'onbekend'
  if (!versie) return verschovenNaStart === false ? 'aannemen' : 'herstart'
  if (nu === versie) return 'gelijk'
  if (paden && !raaktSessiehouder(paden)) return 'geen_herstart'
  return 'herstart'
}
