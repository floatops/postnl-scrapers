// Welke depots krijgen een eigen sessie? Puur (floatops/matransport#562).
// De sessiehouder leest elke 15 minuten de inloggegevens uit de database (géén PostNL-login).
// Alleen een depot dat er nog niet bij was, krijgt een eigen lus met één login en één tabblad;
// lopende depots blijven in hun sessie. Een depot dat uit de inloggegevens verdwijnt, loopt door
// tot het proces 's avonds stopt (dan start het de volgende dag niet meer).

export function nieuweDepots(lopend, uitDatabase) {
  const gezien = new Set()
  const uit = []
  for (const d of uitDatabase ?? []) {
    if (!d?.naam || !d.url || lopend.has(d.naam) || gezien.has(d.naam)) continue
    gezien.add(d.naam)
    uit.push(d)
  }
  return uit
}
