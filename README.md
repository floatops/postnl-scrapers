# PostNL scrapers

Losstaande scrapers voor het PostNL OOM PD-portaal (Dagplanning + Ritmonitor),
draaiend op GitHub Actions. Bewust een **aparte publieke repo**: GitHub Actions is
gratis en ongelimiteerd voor publieke repo's, en elke run krijgt een ander IP uit
de GitHub-pool — waardoor de Akamai IP-blokkade die de VPS trof hier geen grip heeft.

Er staan **geen geheimen** in deze repo. Alle inloggegevens en sleutels komen uit
GitHub Secrets (zie hieronder). De PostNL-logins zelf staan versleuteld in de
Supabase-tabel `klant_credentials` en worden per run ontsleuteld met
`CREDENTIALS_ENCRYPTION_KEY`.

## Publieke run-logs zeggen niets over de klant (sinds 2026-09-19)

Omdat de repo publiek is, kan iedereen de Actions-logs lezen. Met meerdere klanten zou
daaruit af te leiden zijn welke bedrijven FloatOps gebruiken (depotnamen, portaal-URL's).
Daarom filtert `worker/credentials-shared/src/publiekLog.js` in GitHub Actions de console
zelf, zodra de depots geladen zijn: depotnamen worden een stabiele code (`D-3f2a`, per
klant anders), logins `<login>`, elke URL `<url>`, en van fouten blijft alleen de eerste
regel over. Lokaal blijft alles leesbaar. Test: `cd worker/credentials-shared && node --test test/`.

Welk depot bij welke code hoort staat privé in `worker_run_log` (matransport-database:
`depots_ok`/`depots_mislukt` met echte namen) — of reken `depotCode(klantId, naam)` na.
**Nooit** een echte depotnaam, login of URL rechtstreeks naar `process.stdout` schrijven
of in een workflow-`run-name`/stapnaam zetten; alleen `console.*` wordt gefilterd.
Zet daarnaast in **Settings → Actions → General → Artifact and log retention** de
bewaartermijn op 1 dag: dan staat zelfs het neutrale niet lang.

## Benodigde GitHub Secrets

Instellen via **Settings → Secrets and variables → Actions → New repository secret**:

| Secret | Waar te vinden |
|--------|----------------|
| `SUPABASE_URL` | Supabase dashboard → Project Settings → API |
| `SUPABASE_SERVICE_ROLE_KEY` | idem (service_role, niet de anon key) |
| `CREDENTIALS_ENCRYPTION_KEY` | zelfde waarde als in de VPS-`.env` |
| `KLANT_ID` | de klant-UUID (M&A Transport) |

## Triggeren

De workflows draaien op `workflow_dispatch` — getriggerd door Supabase `pg_cron`
(in het `fixertnl/matransport`-project) via de GitHub API, met Vault-secret
`postnl_scrapers_token` (rechtstreeks vanuit `public.trigger_postnl_sync()` /
`public.trigger_ritmonitor()` — geen tussenstap via een VPS meer).
**Nooit `on: schedule`** gebruiken: dat vuurt minuten tot uren te laat.

⚠️ Deze functies zijn ooit rechtstreeks in de Supabase-database aangepast, niet
via een migratiebestand in `matransport` — check bij twijfel de live definitie
(`select pg_get_functiondef(oid) from pg_proc where proname = 'trigger_ritmonitor'`)
i.p.v. op matransport's migratiebestanden te vertrouwen.

Handmatig testen kan via **Actions → (workflow kiezen) → Run workflow**, of
`gh workflow run postnl-ritmonitor.yml` / `postnl-sync.yml`.

## Structuur

```
worker/postnl-dagplanning/       Dagplanning-scraper (ritten + stops) — map heet
                                  postnl-dagplanning, workflow-bestand blijft
                                  postnl-sync.yml (zie die file voor waarom)
worker/postnl-ritmonitor/        Live voortgang per rit
  POSTNL_RITMONITOR.md           Volledige technische documentatie (lees dit eerst)
worker/credentials-shared/       Ontsleutelt klant_credentials (crypto), proxyPool.js,
                                  publiekLog.js
.github/workflows/                De twee Actions-workflows
```

## Twee plekken waar de scrapers draaien (sinds 2026-09-21, floatops/matransport#173)

Dezelfde code draait op twee manieren; welke pg_cron kiest, staat per omgeving in de
matransport-database (`platform_instellingen.postnl_scrape_route` = `github` of `vps`):

- **GitHub Actions** (de workflows hieronder) — elke run een ander IP uit de GitHub-pool.
- **De VPS** — `vps-server` start `node src/index.js --once` vanuit een checkout van deze
  repo (`/opt/postnl-scrapers`, elke minuut bijgewerkt door matransport's
  `scripts/auto-deploy-scrapers.sh`) met `PROXY_POOL=true`: elke browsersessie krijgt
  dan het volgende IP uit de eigen proxy-pool (dedicated ISP-IP's, rouleren 1..n over
  alle depots). Die proxies accepteren alleen verkeer vanaf het VPS-IP, dus op GitHub
  werken ze niet.

De proxy-logica staat één keer, in `worker/credentials-shared/src/proxyPool.js`:
`kiesProxy()` (volgende IP via `volgende_proxy()`), `sluitProxyAf()` (uitkomst `ok` /
`fout` / `blokkade` naar `proxy_gebruik_log`), en `detecteerBlok()`/`ProxyBlokkadeError`.
Een blokkade zet het IP in de database automatisch in quarantaine (en stuurt een
pushmelding); de scraper probeert direct opnieuw met het volgende IP
(`PROXY_MAX_BLOKKADES`, standaard 3). Geen bruikbaar IP = harde fout, nooit stil via
het VPS-IP. Zonder `PROXY_POOL` is het gedrag als vóór #173: optioneel één vaste
`PROXY_SERVER` uit de omgeving. Uitleg en overzichten: matransport
`worker/proxy-pool/PROXY_POOL.md`. Tests: `cd worker/credentials-shared && node --test test/proxyPool.test.mjs`.

## Relatie met `fixertnl/matransport`

Deze repo is de **enige** bron voor de PostNL-scrape-logica sinds 2026-08-25 —
de hoofd-app-repo (`fixertnl/matransport`) had eerder eigen kopieën van beide
workers (via een always-on VPS), maar die zijn verwijderd toen bleek dat de
automatische triggers hier via GitHub Actions liepen, niet via die VPS. Een fix
aan scrape-/parse-/tijdzone-/chauffeur-koppel-logica hoort dus **hier**, nooit
in `matransport`. Zie `matransport`'s `CLAUDE.md` § PostNL integration voor het
bredere app-datamodel (welke kolommen in `ritten` deze workers vullen, hoe de
Ritten-pagina de live voortgang toont, enz.).
