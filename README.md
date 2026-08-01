# superduper-analytics

One ingest endpoint for every site and app I run — on Cloudflare, with the history in Apache
Iceberg so nobody can lock me out of it.

> **Status: live at `https://analytics.superduperai.co`.** `POST /e` validates against the
> contract, refuses any source not in the registry, enriches at the edge and writes to
> Analytics Engine; `GET /v1/stats` reads it back. Next are the web and Swift snippets; the
> archive is v2; there is no authentication yet. Fits the Workers **Free** plan — v1 costs
> nothing. Start at [docs/prd.md](docs/prd.md).

## Why this exists

A dozen landing pages and a dozen iOS apps, no single answer to "how many people, from where,
doing what", and a person who reads a landing and then installs the app counted as two
strangers. The alternatives each failed for a specific reason — Google Analytics is web-only,
PostHog's free plan allows one project, PostHog self-hosted is officially unsupported and
strictly worse than their own free tier, and Counterscale tracks pageviews but not app events.
[The PRD spells this out.](docs/prd.md#1-problem)

What was actually needed is narrow: ingest a lot of sources cheaply, keep the history, and
query it with real SQL.

## How it works

```
  websites  ──┐
              ├──►  Worker  ──┬──►  Analytics Engine        hot — last 3 months, instant SQL
  iOS/Android ┘               │
                              └──►  Pipelines ──► R2 (Iceberg)   cold — forever, ~$0.015/GB
                                                      │
                                                      └──► ClickHouse · DuckDB · Trino
```

Two stores because they do different jobs: Analytics Engine is free and instant but **deletes
after three months**; the Iceberg archive in R2 keeps everything, costs storage only, has zero
egress fees, and is read by engines you already know.

Cloudflare provides no query engine for this data — deliberately. The storage is theirs, the
reader is yours, and Iceberg is portable by construction.

## Adding a site or an app is one commit

[`registry/sources.yaml`](registry/sources.yaml) is the source of truth. Append an entry,
commit, `make sync`. That generates the allowed origins, the write key and the archive
partition. Nothing in the API or the dashboard can create a source — otherwise the file would
stop being the truth.

The repo is public, so the registry holds public identifiers only. Keys are Worker secrets.

## Requirements

- Cloudflare account on **Workers Paid** ($5/mo — Pipelines needs it)
- **wrangler ≥ 4.117** (earlier releases have no `pipelines` or `r2 bucket catalog`)
- Node 20+, pnpm

## Getting started

```sh
pnpm install
make dev            # local Worker on :8787
make test
make integration    # replay fixtures through the pipeline — no network, no credentials
make deploy
```

## Status and expectations

Built for my own portfolio, opened because the shape may be useful to someone with the same
problem. Pipelines and R2 Data Catalog are both in beta, so treat it accordingly. Issues and
PRs welcome; there is no support promise.

## License

MIT — see [LICENSE](LICENSE).
