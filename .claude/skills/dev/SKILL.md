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

**The project is a skeleton.** `src/schema.ts` and `registry/sources.yaml` are real; the
Worker and CLI are stubs with the build order written in their headers. Read
[docs/prd.md](../../../docs/prd.md) before writing code — it records what was rejected and why,
which is the part that is expensive to rediscover.

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
make integration  # replay fixtures — must pass with NO network and NO credentials
make sync         # apply registry/sources.yaml
make deploy
make tail         # production logs
```

## Build order
1. `POST /e` — validate with `Batch`, reject unknown `source`, return 204. No sinks.
2. Analytics Engine sink behind `ctx.waitUntil`, fields mapped by `BLOB_SLOTS`.
3. `GET /v1/stats` over the SQL API — proves the round trip end to end.
4. Web snippet (<2 KB, no cookies), then the Swift snippet.
5. v2: Pipelines → R2 Iceberg, then ClickHouse/DuckDB example queries.

Each step is independently verifiable. Do not start the next before the previous one is.

## Three things that will bite
1. **Blob positions are a wire format.** Every query refers to `blob1..blob20` by position.
   Append to `BLOB_SLOTS`, never reorder or repurpose — historical data would silently start
   meaning something else.
2. **Analytics Engine deletes after 3 months.** Anything historical comes from Iceberg. Never
   let a chart fall back between stores; it would change meaning mid-axis.
3. **The registry is the only way in.** Nothing in the API or dashboard may create a source.

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
