// node --test — alleen herstarten bij code die de sessiehouder raakt (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { raaktSessiehouder } from '../src/codeversie.js'

test('een commit die alleen een andere worker wijzigt, geeft geen herstart (03-11: postnl-rva)', () => {
  assert.equal(raaktSessiehouder(['worker/postnl-rva/src/index.js', 'worker/postnl-rva/RVA.md']), false)
  assert.equal(raaktSessiehouder([]), false)
})

test('code die de sessiehouder laadt, geeft wel een herstart', () => {
  for (const p of ['worker/postnl-sessie/src/depot.js', 'worker/credentials-shared/src/postnl/login.js', 'worker/postnl-planner/src/index.js', 'worker/postnl-ritmonitor/package.json']) {
    assert.equal(raaktSessiehouder(['worker/postnl-rva/x.js', p]), true, p)
  }
})
