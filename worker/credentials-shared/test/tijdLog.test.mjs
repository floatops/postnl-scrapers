// node --test — tijd voor elke logregel (floatops/matransport#599).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { tijdStempel, zetTijdInLog } from '../src/tijdLog.js'

test('tijdStempel: datum en tijd in NL-tijd, zomer en winter', () => {
  assert.equal(tijdStempel(new Date('2026-11-05T12:51:41Z')), '05-11 13:51:41')
  assert.equal(tijdStempel(new Date('2026-07-05T12:51:41Z')), '05-07 14:51:41')
})

test('zetTijdInLog: elke regel één stempel, ook als hij twee keer wordt aangeroepen', () => {
  const uit = []
  const c = { log: (...a) => uit.push(a), info: (...a) => uit.push(a), warn: (...a) => uit.push(a), error: (...a) => uit.push(a) }
  zetTijdInLog(c)
  zetTijdInLog(c)
  c.warn('[Depot] iets', 42)
  assert.equal(uit[0].length, 3, 'precies één stempel ervoor')
  assert.match(uit[0][0], /^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
  assert.deepEqual(uit[0].slice(1), ['[Depot] iets', 42])
})
