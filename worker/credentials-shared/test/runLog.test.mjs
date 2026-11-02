// node --test — gedeeld run-logboek (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { startRunLog, eindeRunLog } from '../src/runLog.js'

function nep({ insertFout = null, updateFouten = [] } = {}) {
  const updates = []
  return {
    updates,
    from: () => ({
      insert: () => ({ select: () => ({ single: async () => insertFout ? { data: null, error: insertFout } : { data: { id: 7 }, error: null } }) }),
      update: (v) => ({ eq: async () => { updates.push(v); return { error: updateFouten.shift() ?? null } } }),
    }),
  }
}
const stil = fn => async () => { const e = console.error; console.error = () => {}; try { await fn() } finally { console.error = e } }

test('start geeft het id; een databasefout geeft null en laat de run doorgaan', stil(async () => {
  assert.equal(await startRunLog(nep(), { worker: 'w', klantId: 'k' }), 7)
  assert.equal(await startRunLog(nep({ insertFout: { message: 'kapot' } }), { worker: 'w', klantId: 'k' }), null)
}))

test('einde zonder kolom leeg_onbevestigd (oudere stack): opnieuw zonder die kolom', stil(async () => {
  const sb = nep({ updateFouten: [{ message: 'column "leeg_onbevestigd" does not exist' }] })
  await eindeRunLog(sb, 7, { status: 'ok', leeg_onbevestigd: [] })
  assert.equal(sb.updates.length, 2)
  assert.equal('leeg_onbevestigd' in sb.updates[1], false)
  assert.equal(sb.updates[1].status, 'ok')
}))
