# postnl-rva

Past de **vaste rijvolgorde per rit per weekdag** aan in RVA, de Route Volgorde Applicatie van PostNL (`https://pnl-rva.p15.cldsvc.net/`, één adres voor alle depots; welk depot je ziet hangt af van de login). Issue: floatops/matransport#569.

Afgesproken volgorde:
1. **Nu:** alle handelingen uit de opnames van 03-11 kunnen uitvoeren en controleren (`src/`, `scripts/proef.mjs`).
2. **Daarna:** OOM PD en RVA tegelijk, met dezelfde login en dezelfde sessie, in twee tabbladen in de sessiehouder (`postnl-sessie`).
3. **Later:** een wachtrij vanuit de app (chauffeurs) en een edge function in matransport.

## Hoe RVA werkt (vastgesteld op de opnames van 03-11)

- **Rittenoverzicht:** datagrid met per route **twee rijen**, één voor Ma en één voor Di–Za. Per dag een klikbaar vak. Het **slotje** (een `img` in het tooltip-vak van de dag) betekent dat die rit-dag in bewerking is.
- **Bewerken gaat op een kladversie.** Wijzig zet een slot op de rit-dag (`TripWeekday.IsLocked/LockedBy` = account). Elke handeling past de kladversie meteen aan bij PostNL. **Opslaan** maakt het definitief en een revisie (`Snapshot`). **Annuleer** gooit de kladversie weg. In de bewerkstand krijgen regels nieuwe guids: herken een regel aan zijn inhoud (`plan.regelSleutel`: postcode, straat, van, t/m, even/oneven).
- **Slot na een weggevallen tabblad:** het slot blijft staan, maar **hetzelfde account komt er weer in**, meteen in de bewerkstand, met de halve wijzigingen nog erin. Daarom doet `startWijzig()` dan eerst Annuleer. Het slot van een **ander** account: PostNL laat Wijzig niet toe. Dat is fout `vergrendeld`, niets doen (nog niet gezien met een tweede account).
- **Volgorde:** een nummer typen in het vak links (`.mx-name-textBox1 input`) en het vak verlaten. RVA verplaatst de regel en nummert de rest zelf opnieuw. Te hoog wordt de laatste plek, 0 de eerste. Slepen is niet nodig.
- **Richting:** klik op het label (`.mx-name-badge2`) wisselt Oplopend/Aflopend.
- **Knippen:** rechtsklik → "Knips maken" → venster "Adressen knippen": de t/m van de laatste regel aanpassen. PostNL maakt zelf de rest-regel (volgende nummer met dezelfde even/oneven, tot het oude eind). ↺ haalt een extra regel weg. Opslaan in het venster past alleen de kladversie aan.
- **Samenvoegen:** rechtsklik → "Knips samenvoegen" (of het schaartje, alleen zichtbaar bij een geknipte straat) → venster "Adressen samenvoegen" met alle delen van die straat en even/oneven, op huisnummer. **↓ voegt een deel samen met het deel eronder, ↑ met het deel erboven.** Het eerste deel heeft alleen ↓, het laatste alleen ↑.
- **Plaatsgebonden onderbreking:** rechtsklik → "Nieuwe plaatsgebonden onderbreking" → Minuten (keuzelijst-widget, geen `<select>`) → Opslaan of Verwijder. **Een revisie bevat geen onderbrekingen**: terugzetten haalt er dus geen weg.
- **Kopieer weekdag:** schakelaar per dag → "Kopiëren en opslaan" → venster "Informatie" → OK. **Slaat direct op**, en gaat over beide rijen van de route heen: kopiëren vanaf de Ma-rij overschrijft di–za van de andere rij.
- **Revisies:** lijst (gemaakt op als `dd-mm-jjjj hh:mm`, door, actief). Klokje → "Bevestiging" → Doorgaan zet die versie terug. Dit is de terugdraaiknop.
- **Ritverantwoordelijke** (keuzelijst in het Rittenoverzicht, meerdere namen): **elke klik slaat direct op.**
- **Excel export:** een download.

## Code

| Bestand | Wat |
|---|---|
| `src/scherm.js` | Alle selectors (`SCHERM`) en handelingen. Knoppen eerst op `data-button-id` (`p.PlanningData.TripWeekday_View_DnDNew.actionButton6` enz.), anders op tekst. Elke handeling loopt via `volgMendix(page).actie()` uit `postnl-planner/src/mendix.js`. |
| `src/lezen.js` | Puur: Mendix-antwoorden lezen (`regelsUit`, `ritDagUit`, `rittenUit`, `revisiesUit`, `onderbrekingenUit`). Bouwt op `credentials-shared/src/postnl/mendix.js`. |
| `src/plan.js` | Puur: `regelSleutel`, `zetOpPlek` (wat RVA doet bij een getypt nummer), `stappenVoorVolgorde`, `knipDelen`, `verschillen`, `revisieTijdTekst`. |
| `src/index.js` | `voerUit(page, mendix, opdracht, { echt })`: één rit-dag openen, Wijzig, de handelingen één voor één met controle, dan Opslaan (`echt`) of Annuleer. Een fout midden in een handeling: Annuleer, geen herhaling. |
| `scripts/proef.mjs` | De proefronde, zie hieronder. |

**Valkuil:** `locator.filter({ hasText })` ziet de cellen van een datagrid-rij aan elkaar geplakt, zonder spatie ("…1276Even"). Zoek een rij dus op celwaarde onder de kolomkop (`samenvoegRij`, `leesRittenoverzicht`), niet met een regex over de rij.

**Publieke repo:** geen ritnamen, adressen of namen in code, tests of logs. De logs noemen alleen "regel N" en tellingen. De testritten staan in matransport#569.

## Proef

```bash
cd worker/postnl-rva && npm install && npm test
node scripts/proef.mjs --klein "<ritnaam>" --groot "<ritnaam>" --dag Za          # proefstand: alles Annuleer
node scripts/proef.mjs --klein "<ritnaam>" --groot "<ritnaam>" --dag Za --echt   # opslaan + terugzetten
```

- Er opent een zichtbare browser. **Je logt zelf in** (vijf minuten de tijd). Daarna loopt alles vanzelf. Draai buiten werktijd (na 23:00).
- **Proefstand:** volgorde (ook 0 en te hoog), richting, slot (Wijzig → herladen → opnieuw openen → bewerkstand → Annuleer), knippen + samenvoegen, onderbreking, Excel export. Alles eindigt met Annuleer. Kopieer weekdag en verantwoordelijke worden alleen gelezen, want die slaan direct op.
- **`--echt`:** hetzelfde, maar met Opslaan. Daarna zet de proef de **revisie die vóór de proef actief was** terug en vergelijkt hij met het begin. De onderbreking haalt hij apart weg. Verantwoordelijke: één naam weg en weer terug. Kopieer weekdag: alleen als Ma en de testdag nu al gelijk zijn (anders overgeslagen).
- De uitkomst staat in `opnames/<tijd>/uitslag.json`, met video en `trace.zip` (`npx playwright show-trace`). Die map staat in `.gitignore`: hij bevat adressen.

## Stand

- 03-11: gebouwd. De pure tests zijn groen. Selectors en leesfuncties zijn gecontroleerd op de HTML-snapshots van de vier opnames (Rittenoverzicht, slotjes, regels in de lees- en bewerkstand, contextmenu, de vensters knippen/samenvoegen/onderbreking/kopiëren/revisies/bevestiging). **De live proef moet nog.**
- Nog niet gezien en dus nog te bevestigen in de proef: hoe een bestaande onderbreking eruitziet en weer opengaat (Verwijder), welke minuten er te kiezen zijn, en wat PostNL toont bij een slot van een ander account.
