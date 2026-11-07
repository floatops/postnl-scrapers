// node --test — alleen herstarten bij code die de sessiehouder raakt (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { beslisCode, codeVersie, codeVersieBijStart, codeVersieFout, gitArgs, headVerschovenOp, raaktSessiehouder } from '../src/codeversie.js'

test('een commit die alleen een andere worker wijzigt, geeft geen herstart', () => {
  assert.equal(raaktSessiehouder(['worker/postnl-dagplanning/src/index.js', 'README.md']), false)
  assert.equal(raaktSessiehouder([]), false)
})

test('code die de sessiehouder laadt, geeft wel een herstart', () => {
  for (const p of ['worker/postnl-sessie/src/depot.js', 'worker/credentials-shared/src/postnl/login.js', 'worker/postnl-planner/src/index.js', 'worker/postnl-ritmonitor/package.json']) {
    assert.equal(raaktSessiehouder(['README.md', p]), true, p)
  }
})

test('sinds de RVA-taak (matransport#569) laadt de sessiehouder ook postnl-rva: dan wel herstarten', () => {
  assert.equal(raaktSessiehouder(['worker/postnl-rva/src/scherm.js']), true)
})

// matransport#622: Stack B draait als floatops-b in een checkout van root. Zonder deze vlag
// weigert git ("dubious ownership"), gaf codeVersie() stil null en zag Stack B nieuwe code nooit.
test('elke git-aanroep krijgt safe.directory, zodat hij onder elke gebruiker werkt', () => {
  assert.deepEqual(gitArgs('rev-parse', 'HEAD'), ['-c', 'safe.directory=*', 'rev-parse', 'HEAD'])
  const bron = readFileSync(new URL('../src/codeversie.js', import.meta.url), 'utf8')
  const aanroepen = bron.match(/execFileSync\('git',\s*[^,]+/g) ?? []
  assert.ok(aanroepen.length >= 2)
  for (const a of aanroepen) assert.match(a, /gitArgs\(/, `git zonder gitArgs: ${a}`)
})

test('codeVersie() leest de echte versie van deze checkout', () => {
  assert.match(codeVersie() ?? '', /^[0-9a-f]{40}$/)
  assert.equal(codeVersieFout(), null)
})

test('beslisCode: onbekende versie verstopt geen nieuwe code (matransport#622)', () => {
  const a = 'a'.repeat(40), b = 'b'.repeat(40)
  assert.equal(beslisCode(a, a, null), 'gelijk')
  assert.equal(beslisCode(a, null, null), 'onbekend')
  assert.equal(beslisCode(null, null, null), 'onbekend')
  // startversie onbekend, nu wel bekend: alleen herstarten als HEAD na de start verschoof
  // (of dat niet te zeggen is); anders kostte één git-hapering bij de start een login
  assert.equal(beslisCode(null, b, null, { verschovenNaStart: true }), 'herstart')
  assert.equal(beslisCode(null, b, null, { verschovenNaStart: null }), 'herstart')
  assert.equal(beslisCode(null, b, null), 'herstart')
  assert.equal(beslisCode(null, b, null, { verschovenNaStart: false }), 'aannemen')
  assert.equal(beslisCode(a, b, ['worker/postnl-sessie/src/index.js']), 'herstart')
  assert.equal(beslisCode(a, b, ['worker/postnl-dagplanning/src/index.js']), 'geen_herstart')
  // git weet de gewijzigde paden niet: voor de zekerheid herstarten
  assert.equal(beslisCode(a, b, null), 'herstart')
})

test('codeVersieBijStart en headVerschovenOp werken in deze checkout', async () => {
  assert.match(await codeVersieBijStart({ wachtMs: 1 }) ?? '', /^[0-9a-f]{40}$/)
  const op = headVerschovenOp()
  assert.ok(op === null || (op > Date.UTC(2020, 0, 1) && op <= Date.now() + 60_000), String(op))
})
