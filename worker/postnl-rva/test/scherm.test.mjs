// De knop-checks van de rit-dag, met een nagemaakte pagina: welke knoppen staan in beeld.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { inBewerkstand, magWijzigen } from '../src/scherm.js'

// Een pagina waarop alleen de knoppen met deze teksten zichtbaar zijn. knop() zoekt op
// data-button-id óf op de knoptekst; de nep-locator kijkt alleen naar de tekst.
function pagina(...zichtbaar) {
  const loc = (naam) => ({ or: () => loc(naam), first: () => loc(naam), isVisible: async () => zichtbaar.includes(naam) })
  return {
    locator: (selector) => loc(/actionButton2"/.test(selector) ? 'Opslaan' : /actionButton6"/.test(selector) ? 'Wijzig' : /actionButton5"/.test(selector) ? 'Annuleer' : selector),
    getByRole: (_rol, { name }) => loc(name),
  }
}

test('inBewerkstand: geen knoppen (geen ritverantwoordelijke) is géén bewerkstand (matransport#589)', async () => {
  assert.equal(await inBewerkstand(pagina()), false)
})

test('inBewerkstand: alleen Wijzig = gewone stand, Opslaan zonder Wijzig = bewerkstand', async () => {
  assert.equal(await inBewerkstand(pagina('Wijzig')), false)
  assert.equal(await inBewerkstand(pagina('Opslaan', 'Annuleer')), true)
})

test('magWijzigen: zonder knoppen nee, dan voegt zorgVoorRechten het account toe (matransport#589)', async () => {
  assert.equal(await magWijzigen(pagina()), false)
  assert.equal(await magWijzigen(pagina('Wijzig')), true)
  assert.equal(await magWijzigen(pagina('Opslaan', 'Annuleer')), true)
})
