// node --test — alleen herstarten bij code die de sessiehouder raakt (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { raaktSessiehouder } from '../src/codeversie.js'

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
