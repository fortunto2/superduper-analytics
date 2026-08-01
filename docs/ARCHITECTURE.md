# Architecture

Dependencies point inward. `schema.ts` knows nothing about Cloudflare; the Worker knows about
the schema; the dashboard knows about queries. Nothing reaches back.

```
  src/schema.ts        the contract — zod, no I/O, no runtime deps
        ▲
        │
  src/ingest.ts        validate → enrich → fan out          (Worker)
        ├──► sinks/analytics-engine.ts    hot store, 3 months
        └──► sinks/pipeline.ts            → R2 Iceberg, forever
        ▲
  src/index.ts         routing, CORS, auth
        ▲
  src/dashboard.ts     reads via the SQL API — never writes
```

## Two sinks, on purpose

| | Analytics Engine | Pipelines → R2 Iceberg |
|---|---|---|
| Retention | **3 months, then gone** | as long as you pay R2 |
| Cost | free | ~$0.015/GB/mo, zero egress |
| Read with | Cloudflare SQL API | ClickHouse, DuckDB, Trino, Spark |
| Latency | seconds | minutes (batched) |
| Role | "what is happening now" | the archive, and anything historical |

Writes go to both. Neither is authoritative for the other's job, and the dashboard must never
silently fall back from one to the other — a chart that changes meaning at the 3-month
boundary is worse than a chart that stops.

## Ingest path

1. **Reject unknown sources.** `source` must be in `registry/sources.yaml`. This is the whole
   access-control model for the web: an origin allow-list generated from the registry.
2. **Trust the edge, not the client.** Country, bot score and timestamp come from
   `request.cf` and the server clock. Client-supplied values are advisory.
3. **Strip before storing.** Query strings off paths, referrer down to its host. Less to leak,
   less to regret.
4. **Never block the response.** Sink writes go through `ctx.waitUntil` — a beacon must not
   make a page wait.

### The ingest is currently open to writes

Say it plainly: source ids are public (the registry is in a public repo) and there is no
authentication yet, so anyone who reads this repo can post events as any registered source.
The blast radius is dirty counters, not a leak — no secrets are readable and nothing is
destroyed — which is why it is acceptable while the pipeline is being built and not after.

Two things close it, and neither exists yet:

- **Web** — the origin allow-list generated from `sites[].url`, landing with the web snippet.
- **Apps** — a per-app write key in `Authorization: Bearer`, derived and installed as a Worker
  secret by `make sync`. Apps have no origin, so this is the only lever they have.

Until both land, treat the numbers as indicative rather than evidential.

## The blob positions are a wire format

`BLOB_SLOTS` in `schema.ts` maps fields onto Analytics Engine's `blob1..blob20`. Every query
ever written refers to those positions. **Append only.** Reordering or repurposing a slot
silently corrupts every historical query — the data will still be there, and it will quietly
mean something else.

## Registration flows one way

`registry/sources.yaml` → `make sync` → allowed origins, write keys, Iceberg partitions.

Never the reverse. Nothing in the dashboard or the API may create a source, or the git file
stops being the truth and starts being a suggestion.

## Beta dependencies

Pipelines and R2 Data Catalog are both beta. Keep everything that touches them behind
`sinks/pipeline.ts` so that if the API shifts, one file changes. The hot path through
Analytics Engine must keep working regardless.

## What must not happen here

- No cookies, no cross-site ids. The moment one appears, every privacy page on every property
  becomes a lie and a consent banner becomes mandatory.
- No funnels, cohorts or replay. If those become necessary, point PostHog at the same event
  stream — do not grow a worse copy of it inside this repo.
