---
name: superduper-analytics-dev
description: Dev workflow for superduper-analytics — the Cloudflare ingest for every site and app. Use when building the ingest Worker, the event schema, the source registry, the Iceberg archive or the dashboard. Do NOT use for other projects.
license: MIT
metadata:
  author: fortunto2
  version: "1.0.0"
allowed-tools: Read, Grep, Glob, Bash, Write, Edit
---

# superduper-analytics — dev workflow

**Live at `https://analytics.superduperai.co`.** Ingest, the sink, the read API, the web
counter (`/sda.js`) and the dashboard (`/`) all work. **The counter is installed on no site
yet** — the edge sees ~91k people a month and we record none of them; `docs/install.md` is the
one-liner. Left: the Swift snippet, then v2. Read
[docs/prd.md](../../../docs/prd.md) before writing code — it records what was rejected and why,
which is the part that is expensive to rediscover, and
[docs/QUALITY_SCORE.md](../../../docs/QUALITY_SCORE.md) for what is thin right now.

## Stack
TypeScript · Cloudflare Workers · Hono · zod 4 (`import { z } from "zod/v4"`) · pnpm ·
vitest + `@cloudflare/vitest-pool-workers`.

Requires **wrangler ≥ 4.117** — earlier versions have no `pipelines` or `r2 bucket catalog`.
Pipelines needs the account on **Workers Paid**.

## Commands
```sh
make dev          # local Worker, :8787
make test         # vitest
make typecheck    # tsc --noEmit
make gen          # regenerate from registry/sources.yaml and wrangler.jsonc
make check        # registry sound, generated code not stale — cheap, offline
make integration  # replay fixtures — must pass with NO network and NO credentials
make sync         # apply registry/sources.yaml (not implemented)
make deploy
make tail         # production logs
```

`make lint` and `make format` are declared but fail — neither eslint nor prettier is installed.

## Build order
1. ~~`POST /e` — validate with `Batch`, reject unknown `source`, return 204. No sinks.~~ done
2. ~~Analytics Engine sink, fields mapped by `BLOB_SLOTS`.~~ done — **no `ctx.waitUntil`**:
   `writeDataPoint` returns `void` and is already non-blocking. `waitUntil` is for Pipelines.
3. ~~`GET /v1/stats` over the SQL API.~~ done — needs the `CF_ACCOUNT_ID` and `CF_API_TOKEN`
   secrets; every aggregate is weighted by `_sample_interval`, enforced in `buildQuery`.
4. ~~Web snippet.~~ done — served at `/sda.js`. Next: the Swift snippet, posting to
   `https://analytics.superduperai.co/e`.
5. v2: Pipelines → R2 Iceberg, then ClickHouse/DuckDB example queries.

Each step is independently verifiable. Do not start the next before the previous one is.

## Four things that will bite
1. **Slot positions are a wire format.** Every query refers to `blob1..blob20` and
   `double1..double20` by position. Append to `BLOB_SLOTS` / `DOUBLE_SLOTS`, never reorder or
   repurpose — historical data would silently start meaning something else. A slot without an
   `EnrichedEvent` field of the same name fails `tsc`, which is what keeps this honest.
2. **Analytics Engine samples: `count()` undercounts and DISTINCT is unrecoverable.** Use
   `sum(_sample_interval)` and the weighted form of every aggregate — no error is raised, just
   a smaller number. Weighting cannot rescue uniques: a dropped row takes its `anon` with it,
   so "how many people" comes from `src/zones.ts`. Sampling was live at 259 events. Also:
   `uniq()` does not exist, `ORDER BY`/`GROUP BY` must name the alias, and `FORMAT JSONCompact`
   is not a thing. Table in ARCHITECTURE.md.
3. **Analytics Engine deletes after 3 months.** Anything historical comes from the archive.
   Never let a chart fall back between stores; it would change meaning mid-axis.
4. **The registry is the only way in.** Nothing in the API or dashboard may create a source.

## Money
v1 is **$0** — Analytics Engine and the ingest both fit the Workers Free plan (100k data
points and 10k read queries a day; 100k Worker requests a day). Workers Paid ($5) is needed
only for Pipelines, i.e. the v2 archive (PRD §4 — decided: Pipelines, since the $5 is already
being paid).
Free-plan CPU is **10 ms per invocation**; a full 250-event batch measures p99 2.5 ms, so the
hot path has roughly 4× headroom and no more.

## Conventions
- Event names: `object_verb`, past tense, snake_case — `page_viewed`, `purchase_completed`.
- Validate at the edge; trust `request.cf` over anything a client sends.
- Sink writes never block a response.
- The repo is public: no secrets, ever. Keys are Worker secrets, the registry is public ids.

## Do not
- Add cookies or cross-site identifiers — every privacy page on every property says there are
  none, and a consent banner becomes mandatory the day one appears.
- Grow funnels, cohorts or session replay here. If they are genuinely needed, point PostHog at
  the same event stream instead of building a worse copy.
