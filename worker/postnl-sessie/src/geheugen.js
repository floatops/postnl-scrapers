// Geheugenwacht van de sessiehouder (floatops/matransport#578). Puur: de beslissing, los van Node.
//
// Op 04-11 liep de sessiehouder vier keer vol (heap out of memory, exit 134), één keer midden in
// een Plannen-opdracht. Zo'n crash laat een opdracht op 'bezig' staan en geeft een nieuwe login.
// Daarom kijkt het proces elke minuut naar zijn eigen heap, en herstart het netjes ná de lopende
// taak (exit 42, zoals bij nieuwe code) ruim voordat V8 de grens haalt. Gemeten na de fix van
// 11:06: rond 650 MB rss na een uur, stabiel. De crashes gebeurden bij ~3,3 GB heap.
//
//   ok           niets doen
//   waarschuwen  één melding (de wachtdog pusht naar super_admin); blijft draaien
//   herstarten   lopende taak afmaken, dan exit 42: de wrapper start meteen opnieuw

export function beoordeelGeheugen({ heapMb, limietMb, cfg, gewaarschuwd = false }) {
  if (!limietMb || !Number.isFinite(heapMb)) return 'ok'
  const deel = heapMb / limietMb
  if (deel >= cfg.geheugenHerstartDeel) return 'herstarten'
  if (deel >= cfg.geheugenWaarschuwDeel && !gewaarschuwd) return 'waarschuwen'
  return 'ok'
}

export function geheugenTekst({ heapMb, limietMb, rssMb }) {
  return `heap ${Math.round(heapMb)} MB van ${Math.round(limietMb)} MB (${Math.round((heapMb / limietMb) * 100)}%), rss ${Math.round(rssMb)} MB`
}
