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
  src/stats.ts         reads via the SQL API — never writes
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

### What Analytics Engine costs, and what the $5 actually buys

Analytics Engine runs on the **Workers Free** plan: 100,000 data points written and 10,000 read
queries per day, against 13 sites and 12 apps. Paid raises that to 10M writes and 1M reads a
month, then $0.25 per million writes and $1.00 per million reads. Cloudflare has not switched
billing on yet at all.

So v1 — ingest, hot store, dashboard — costs **nothing**. The only thing that needs Workers
Paid is **Pipelines**, which is v2. The $5 does not buy capacity, it buys permanence: without
the archive, everything older than three months is gone.

The account is on Workers Paid already, for reasons that predate this project, so v2 uses
Pipelines and a real Iceberg catalog rather than the cheap route. Recorded for the day that
stops being true: a Cron Trigger (free) can read the SQL API and write NDJSON or Parquet into
R2 (its own free tier, no Workers Paid). Not Iceberg, no catalog, but DuckDB and ClickHouse
read it, so "deleting this project loses nothing" still holds. More code, less money. Not
being built while Pipelines is the plan.

The Free plan's real constraint is **10 ms of CPU per invocation**. A full 250-event batch —
JSON.parse of 77 KB, zod validation, enrichment and the blob mapping — measures p99 2.5 ms, so
there is about 4× headroom. Anything added to the hot path spends that budget.

### Two decisions inside the hot sink

**`props` and `metrics` are one JSON blob each, not one blob per key.** Free-form keys cannot
have positions: two events of the same name may carry different keys, so "props fill blob12
onwards in key order" makes blob12 mean one thing in one row and another in the next. The
price is that the SQL API has string functions but **no JSON functions**, so those two columns
cannot be aggregated in the hot store. That is the correct trade — the hot store answers "how
many, from where, doing what", which lives entirely in the fixed slots. Numeric analysis of
free-form measures is an archive question, and the archive is read by engines that parse JSON.

**No `ctx.waitUntil` around the Analytics Engine write.** `writeDataPoint` returns `void` and
is documented as non-blocking; the runtime flushes it after the response. There is no promise
to wait on. `waitUntil` becomes necessary at the Pipelines sink, which really is async.

### Analytics Engine samples, so `count()` is wrong

Rows are sampled per index value, and each row carries `_sample_interval` — how many real
events it stands for. Every aggregate has a weighted form and the plain one silently
undercounts:

| wrong | right |
|---|---|
| `count()` | `sum(_sample_interval)` |
| `sum(x)` | `sum(x * _sample_interval)` |
| `avg(x)` | `sum(x * _sample_interval) / sum(_sample_interval)` |
| `quantile(0.5)(x)` | `quantileExactWeighted(0.5)(x, _sample_interval)` |

This is why `INDEX_FIELD` is `source`: sampling happens per index value, so a busy site cannot
thin out a quiet one's data.

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
