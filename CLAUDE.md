# CLAUDE.md — superduper-analytics

One ingest for every site and app I run, on Cloudflare, with the history in an open format.

**Read [docs/prd.md](docs/prd.md) first — it is the brief, and it explains what was rejected
and why.** Module boundaries: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**State: spec + skeleton. There is no working code yet.** `src/schema.ts` and
`registry/sources.yaml` are real; everything else is a stub waiting to be built.

## Stack
TypeScript · Cloudflare Workers · Hono · zod 4 (`import from "zod/v4"`) · pnpm · vitest +
`@cloudflare/vitest-pool-workers`. Storage: Analytics Engine (hot) and R2 Iceberg via
Pipelines (cold). Requires wrangler ≥ 4.117 — earlier versions lack `pipelines` and
`r2 bucket catalog`.

## Commands
`make help` lists them. `make dev` · `make test` · `make deploy` · `make sync` (apply the
registry) · `make integration` (replay fixtures through the pipeline, no network).

## Structure
```
src/schema.ts        the event contract — everything derives from it
src/index.ts         Worker entry: routing, CORS, auth
registry/sources.yaml  every site and app; adding one is ONE COMMIT
cli/                 replays fixtures; how `make integration` works without a network
docs/prd.md          the brief
```

## The three things that will bite
1. **Blob positions are a wire format.** `BLOB_SLOTS` maps fields to Analytics Engine's
   `blob1..blob20`, and every query refers to them by position. Append only — reordering
   silently changes what historical data means.
2. **Analytics Engine deletes after 3 months.** Anything historical must come from the Iceberg
   archive. Never let a chart quietly fall back between the two.
3. **The registry is the only way in.** Unknown `source` is rejected. Nothing in the API or
   dashboard may create a source — otherwise the git file stops being the truth.

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
