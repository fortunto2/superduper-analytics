# CLAUDE.md — superduper-analytics

One ingest for every site and app I run, on Cloudflare, with the history in an open format.

**Read [docs/prd.md](docs/prd.md) first — it is the brief, and it explains what was rejected
and why.** Module boundaries: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**State: live at `https://analytics.superduperai.co`.** Ingest, the Analytics Engine sink, the
read API, the web counter (`/sda.js`) and the dashboard (`/`) all work in production. Left:
the Swift snippet, then v2's Iceberg archive.

The counter is on **8 of the 14 sites**; `akbuzat.net` alone takes 5.5k edge hits a week and
records nothing. Closing that is the top of `docs/roadmap.md` and it is one line per site —
any new metric on an uncovered site is multiplied by zero. `docs/install.md` is the one-liner. Ingest has **no
authentication**; the dashboard and `/v1/*` are behind `DASHBOARD_KEY` — see ARCHITECTURE.md.

That host is effectively permanent: it goes into every site, every app and every privacy page.
Changing it later means editing all of them.

**v1 costs $0** — Analytics Engine and the ingest both run on the Workers Free plan. Workers
Paid is needed only for Pipelines (v2), and that decision has an open fork; see PRD §4.

## Stack
TypeScript · Cloudflare Workers · Hono · zod 4 (`import from "zod/v4"`) · pnpm · vitest +
`@cloudflare/vitest-pool-workers`. Storage: Analytics Engine (hot) and R2 Iceberg via
Pipelines (cold). Requires wrangler ≥ 4.117 — earlier versions lack `pipelines` and
`r2 bucket catalog`.

## Commands
`make help` lists them. `make dev` · `make test` · `make deploy` · `make sync` (apply the
registry) · `make integration` (replay fixtures through the pipeline, no network) ·
`make gen` (regenerate from the registry and wrangler.jsonc) · `make check` (registry sound,
generated code not stale). `make lint` and `make format` do not work — neither tool is
installed.

## Structure
```
src/schema.ts        the event contract — everything derives from it
src/ingest.ts        validate → enrich. Pure: no I/O, no clock, no Cloudflare types
src/registry.ts      is this source allowed — reads the generated list, never YAML
src/anon.ts          the per-day edge-derived id. Nothing is stored on the device
src/snippet.ts       the web counter, served at /sda.js. A string, not a build artefact
src/sinks/           where events land. Dumb by design: positions, nothing else
src/stats.ts         reads the hot store over the SQL API. Never writes; сюда же /v1/metric
src/retention.ts     возвраты в приложениях — «есть ли спрос». Веб сюда не попадает никогда
src/conversion.ts    цель ÷ просмотры той же страницы — «что улучшать»
src/stores/          what Apple and Google report: exact daily totals, in D1, not in AE
src/search/          Search Console: impressions, queries, position. The leading indicator
src/ga/              GA4 page views — the other counter on the same pages, never summed
src/zones.ts         Cloudflare's own edge analytics. Where "how many people" comes from
src/overview.ts      assembles both for the dashboard — never sums them
src/dashboard.ts     the page at /. One self-contained string, no framework
src/mcp.ts           the analytics as tools an agent can call, at POST /mcp
src/index.ts         Worker entry: routing, CORS, auth. Thin by design
registry/sources.yaml  every site and app; adding one is ONE COMMIT
cli/                 gen · check · replay; how `make integration` works without a network
docs/prd.md          the brief
docs/tz-funnel-and-mobile.md  how site→install→purchase is attributed without an identifier
db/schema.sql        the store-report tables. `make db` applies it
docs/metrics.md      what the dashboard must show, and where each number comes from
docs/roadmap.md      the order of work, and who blocks what. Read before starting anything
docs/tz-site-feed.md how another site's admin reads its own page numbers from here
```

Generated, never edited by hand: `src/registry.generated.ts` (committed) and
`worker-configuration.d.ts` (gitignored). Both come from `make gen`; `make check` fails if the
first has drifted.

## The things that will bite
1. **Blob and double positions are a wire format.** `BLOB_SLOTS` and `DOUBLE_SLOTS` map fields
   to `blob1..blob20` / `double1..double20`, and every query refers to them by position.
   Append only — reordering silently changes what historical data means. A slot without a
   matching `EnrichedEvent` field is a compile error, which is what keeps this enforceable.

   Числовые размерности сверх `ts` живут не здесь, а в `registry/sources.yaml` → `metrics:`,
   и попадают в `double2..double20` в порядке списка. Смысл разделения: новое число, которое
   надо УМЕТЬ СЧИТАТЬ, — это одна строка YAML и `make gen`, без правки схемы и без деплоя
   ради имени. Дисциплина не ослабла, а переехала: список тоже append-only, и `make check`
   сверяет его с зафиксированным `registry.generated.ts`, отказываясь принять перестановку
   или удаление. Слотов девятнадцать НА ВСЁ И НАВСЕГДА, словарь общий для всех источников
   (иначе `double2` значил бы у разных продуктов разное), поэтому имена берутся
   переиспользуемые — `days_since_first`, `items_total`, а не `photos_total`.

   Слот получают не все числа, а те, по которым нужен агрегат в горячем хранилище. Остальное
   уезжает в `metrics_json` — записано, читаемо построчно, ждёт архива. Ноль в слоте
   неоднозначен («прислали ноль» и «не прислали» неразличимы), поэтому чтение (`/v1/metric`)
   отсекает строки без ключа по `blob11 LIKE`, а не доверяет нулю.
2. **Analytics Engine samples: `count()` is wrong, and unique counts are impossible.** Use
   `sum(_sample_interval)` and the weighted form of every aggregate — the plain ones return a
   smaller number, not an error. Weighting cannot rescue DISTINCT: a dropped row takes its
   `anon` with it, so "how many people" comes from `src/zones.ts`, never from our events.
   Sampling was already active at 259 events. Table in ARCHITECTURE.md.
3. **Analytics Engine deletes after 3 months.** Anything historical must come from the archive.
   Never let a chart quietly fall back between the two.
4. **Store numbers are not events, and D1 is not Analytics Engine.** Apple hands over exact
   daily totals that were never sampled — weighting them with `sum(_sample_interval)` would
   inflate them, and not weighting them inside AE would make one table need two query dialects.
   They also outlive AE's 3 months by years. So they live in D1, and the dashboard shows them
   beside our numbers and **never adds the two**: "people on a landing page" and "installs" are
   different things counted by different parties.
5. **The registry is the only way in.** Unknown `source` is rejected. Nothing in the API or
   dashboard may create a source — otherwise the git file stops being the truth.
6. **«Люди» за окно длиннее суток — не люди.** `people_seen` это distinct `anon`, а `anon` на
   вебе живёт до полуночи UTC: вернувшийся человек считается снова, и он же на другом нашем
   сайте считается ещё раз. Поэтому суммарное поле называется `people_days`, а не
   `total_people`, и в панели колонка подписана People-days. Число одновременно завышено
   возвратами и занижено сэмплированием, обе ошибки неизвестного размера. Настоящий вопрос
   «вернулись ли» отвечает `src/retention.ts` — и только для приложений, где идентификатор
   переживает сутки. Складывать `people_days` с установками из `store_daily` нельзя вдвойне.
7. **Two counters, one table, никогда не в сумме.** `page_daily.provider` — часть первичного
   ключа: за один день у одной страницы лежат `own` и `ga4`, и оба числа верные. GA режут
   блокировщики, у нас сэмплирование и свой фильтр ботов; расхождение в единицы означает, что
   нашему счётчику можно верить, расхождение вдвое — что один из них чего-то не видит. Джоб
   GA4 (`src/ga/`) идёт **отдельным кроном в 05:20**, и это не про расписание, а про бюджет:
   пятьдесят подзапросов на вызов, а утренний джоб уже упирается в потолок из-за Search
   Console. Свойство GA4 берётся из реестра (`ga_property_id`), а строки фильтруются по хосту
   сайта — одно свойство обслуживает несколько сайтов и вдобавок видит `localhost` и превью:
   у miralinka это была треть «трафика».

## Do / Don't
- **Do** validate at the edge with zod and trust `request.cf` over anything the client says.
- **Do** write to sinks via `ctx.waitUntil` — a beacon must never make a page wait.
- **Don't** add cookies or cross-site identifiers. Every privacy page on every property says
  there are none, and a banner becomes mandatory the day one appears.
- **Don't** grow this into a worse PostHog. No funnels, cohorts or session replay — if those
  are truly needed, point PostHog at the same stream.
- **Don't** commit secrets. The repo is public; the registry holds public identifiers only.

## Quality gate
Before calling anything done: is this solving the real problem, would a senior accept this
code, and what is the insight everyone else is missing?

## Harness notes
This file is a map, not a manual. Depth belongs in `docs/`. Verification is
`make test` + `make integration` — both must run without network or credentials.
