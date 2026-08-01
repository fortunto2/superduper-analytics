# CLAUDE.md — superduper-analytics

One ingest for every site and app I run, on Cloudflare, with the history in an open format.

**Read [docs/prd.md](docs/prd.md) first — it is the brief, and it explains what was rejected
and why.** Module boundaries: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

**State: steps 1–2 of the build order are done.** `POST /e` validates, refuses unregistered
sources, enriches at the edge and writes to Analytics Engine. Next is `GET /v1/stats` over the
SQL API, which closes the round trip. Ingest has **no authentication** — see ARCHITECTURE.md.

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
src/sinks/           where events land. Dumb by design: positions, nothing else
src/index.ts         Worker entry: routing, CORS, auth. Thin by design
registry/sources.yaml  every site and app; adding one is ONE COMMIT
cli/                 gen · check · replay; how `make integration` works without a network
docs/prd.md          the brief
```

Generated, never edited by hand: `src/registry.generated.ts` (committed) and
`worker-configuration.d.ts` (gitignored). Both come from `make gen`; `make check` fails if the
first has drifted.

## The four things that will bite
1. **Blob and double positions are a wire format.** `BLOB_SLOTS` and `DOUBLE_SLOTS` map fields
   to `blob1..blob20` / `double1..double20`, and every query refers to them by position.
   Append only — reordering silently changes what historical data means. A slot without a
   matching `EnrichedEvent` field is a compile error, which is what keeps this enforceable.
2. **Analytics Engine samples: `count()` is wrong.** Use `sum(_sample_interval)`, and the
   weighted form of every other aggregate. The plain ones return a smaller number, not an
   error. Table in ARCHITECTURE.md.
3. **Analytics Engine deletes after 3 months.** Anything historical must come from the archive.
   Never let a chart quietly fall back between the two.
4. **The registry is the only way in.** Unknown `source` is rejected. Nothing in the API or
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
