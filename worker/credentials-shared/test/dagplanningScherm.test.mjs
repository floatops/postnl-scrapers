// node --test — wachten op de data zelf in plaats van op een stille pagina (floatops/matransport#562).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { heeftObject, wachtOpObject } from '../src/postnl/dagplanningScherm.js'

const antw = (objectType) => ({ objects: [{ guid: '1', objectType, attributes: {} }] })

test('heeftObject kijkt alleen naar antwoorden vanaf het moment van de klik', () => {
  const lijst = [antw('OperationalPlanning.RideNumber'), antw('OperationalPlanning.Shift')]
  assert.equal(heeftObject(lijst, 0, 'OperationalPlanning.RideNumber'), true)
  assert.equal(heeftObject(lijst, 1, 'OperationalPlanning.RideNumber'), false, 'oud antwoord telt niet')
  assert.equal(heeftObject([{ partialObjects: [{ guid: '2', objectType: 'OperationalPlanning.RideNumber' }] }], 0, 'OperationalPlanning.RideNumber'), true)
  assert.equal(heeftObject([{ objects: [{ guid: '3', objectType: 'OperationalPlanning.RideNumberX' }] }], 0, 'OperationalPlanning.RideNumber'), false, 'geen halve naam')
})

test('wachtOpObject: wacht tot het antwoord binnenkomt, of geeft na de tijd false (lege shift)', async () => {
  const lijst = []
  setTimeout(() => lijst.push(antw('OperationalPlanning.RideNumber')), 300)
  assert.equal(await wachtOpObject(lijst, 0, 'OperationalPlanning.RideNumber', 3000), true)
  assert.equal(await wachtOpObject(lijst, 1, 'OperationalPlanning.RideNumber', 400), false)
})

// matransport#598 (05-11 08:30): bij een al gekozen shift ging het lezen meteen door terwijl de
// Dagplanning nog opbouwde. Nu wacht kiesShift ook dan tot de ritten binnen zijn.
test('kiesShift: al gekozen shift wacht tot de ritten (RideNumber) binnen zijn en het stil is', async () => {
  const { kiesShift } = await import('../src/postnl/dagplanningScherm.js')
  let geklikt = false
  const rij = { waitFor: async () => {}, evaluate: async () => true, click: async () => { geklikt = true } }
  const page = { locator: () => ({ filter: () => ({ first: () => rij }) }) }
  const antwoorden = []
  setTimeout(() => antwoorden.push({ objects: [{ objectType: 'OperationalPlanning.RideNumber' }] }), 400)
  const begin = Date.now()
  assert.equal(await kiesShift(page, '04', antwoorden, { ms: 5_000 }), 'al_gekozen')
  assert.ok(Date.now() - begin >= 1_300, `te vroeg klaar (${Date.now() - begin} ms): de ritten waren er nog niet of het was niet stil`)
  assert.equal(geklikt, false, 'een gekozen shift niet opnieuw aanklikken (dat zet hem uit)')
})
