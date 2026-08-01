# PRD — superduper-analytics

> One place to collect events from every site and app I run, on infrastructure I already
> pay for, in a format nobody can lock me out of.

**Status:** spec + skeleton. No working code yet — this document is the brief.

---

## 1. Problem

A dozen sites and a dozen iOS apps, and no single answer to "how many people, from where,
doing what". Each product either has nothing, or a different counter, and none of them join
up: a person who reads a landing page and then installs the app is two unrelated strangers.

Existing options were each rejected for a concrete reason:

| Option | Why not |
|---|---|
| Google Analytics | Web only. Mobile means Firebase — a second stack, and the join is still manual. Cookies drag in consent-banner obligations. |
| PostHog Cloud (free) | **1 project on the free plan.** The house rule is one project per product; at two products it stops working. Paid is 6. |
| PostHog self-hosted | Officially *unsupported* by PostHog. Needs a 4 vCPU / 16 GB VM, and self-hosted gets **only free-tier features** — strictly worse than their Cloud free tier, plus ops. |
| Counterscale | Right infrastructure (Workers + Analytics Engine), MIT, near-zero cost — but **pageviews only**, no custom events. Doesn't cover apps. |

What is actually needed is narrow: **ingest** many sources cheaply, **keep** the history, and
**query** it with real SQL. Not funnels-and-replays — those can be bought later if the need
ever becomes sharp.

## 2. Who it is for

One operator (me), running a portfolio. Not a product for sale — though it is public and MIT,
so it can become one if it turns out to be good.

Success = I open one dashboard and see all twelve sites and twelve apps, and adding the
thirteenth takes one commit.

## 3. Solution

```
  websites  ──┐
              ├──►  Worker (ingest)  ──┬──►  Analytics Engine     hot: last 3 months, instant SQL
  iOS/Android ┘                        │
                                       └──►  Pipelines ──► R2 (Apache Iceberg)   cold: forever
                                                                  │
                                                                  └──► ClickHouse / DuckDB
```

Two sinks on purpose, because they solve different problems:

- **Analytics Engine** — free, unlimited cardinality, SQL API, answers instantly. But it
  **hard-deletes after 3 months**. Good for "what is happening now".
- **Pipelines → R2 Iceberg** — the archive. Open format, zero egress, queryable by ClickHouse,
  DuckDB, Trino, Spark. Costs only R2 storage (~$0.015/GB/month).

Cloudflare deliberately does **not** ship a query engine for this data. That is fine: the
storage is theirs, the reader is ours, and the data is in Iceberg — portable by construction.

### Why this and not "just use a SaaS"

The expensive part of an analytics product is the *analysis* layer. The cheap part is
ingestion. This project buys only the cheap part, on infrastructure already paid for, and
leaves the door open to point ClickHouse at the archive when a real question shows up.

**The trap to avoid:** do not grow this into a bad PostHog. If funnels, retention and cohorts
become genuinely necessary, connect PostHog to the same event stream rather than reimplement
it. That decision is deferred, not forbidden.

## 4. Scope

### v1 — the walking skeleton
- One event schema, shared by web and mobile (see `src/schema.ts`).
- Ingest Worker: validate, stamp, fan out to Analytics Engine.
- Site/app registry in git (see §5).
- Web snippet (<2 KB, no cookies) and a Swift snippet.
- Minimal dashboard: totals by source, over time, via the Analytics Engine SQL API.
- `make integration` — CLI replays a fixture file through the pipeline, no network needed.

### v2 — the archive
- Pipelines stream + sink into R2 Iceberg via R2 Data Catalog.
- Example ClickHouse and DuckDB queries against the Iceberg table.
- Nightly rollups so common questions do not scan the whole archive.

### Explicitly out of scope
- Session replay, heatmaps, A/B testing, cohort builders.
- Per-user identity resolution beyond a coarse anonymous id.
- Anything requiring a cookie banner.

## 5. Registration is a git commit

The operator-facing requirement: **adding a site or app must be one commit, not a console
click-path.**

`registry/sources.yaml` is the source of truth. Every site and app is an entry. Adding one:

1. append an entry
2. commit
3. `make sync` (or CI on push) applies it — allowed origins, write key, Iceberg partition

The registry is checked into a public repo, so it holds **no secrets** — only public
identifiers. Write keys are derived, stored as Worker secrets, and never committed.

Why git rather than a dashboard: the inventory is small, changes rarely, benefits from review
and history, and an agent can edit a YAML file far more reliably than it can click a console.

## 6. Constraints

- **Analytics Engine:** 3-month retention, 20 blobs + 20 doubles per data point, 16 KB per
  point, 250 points per Worker invocation.
- **Pipelines and R2 Data Catalog are both in open/public beta.** Acceptable for analytics —
  no money moves through this — but do not build anything load-bearing on their stability yet.
- **Workers Paid ($5/mo) is required** for Pipelines. Already on the account (verified: the
  `wrangler pipelines` commands answer instead of refusing).
- No cookies, no cross-site identifiers — this keeps the consent-banner question closed, and
  keeps the privacy claims on the properties honest.

## 7. Success criteria

1. A new site is live in the dashboard within one commit and one deploy.
2. An iOS app reports its first event with under 20 lines of Swift.
3. "How many people visited every landing last week" answers in one query.
4. Monthly cost stays under $10 all-in.
5. Deleting this project loses nothing: the archive is Iceberg in R2 and readable elsewhere.

## 8. Open questions

- Dashboard: a Worker-rendered page, or point Grafana at the SQL API? Start with the former.
- Do mobile events go straight to the Worker, or buffer offline first? Probably buffer — a
  phone on stage has no signal.
- Bot filtering: Analytics Engine has no built-in notion of it. **The premise this question was
  written on is wrong** — `request.cf.botManagement` is a Bot Management field and Bot
  Management is Enterprise-only, so the score is not available on this account. Ingest
  therefore stamps `ua_kind` (`browser` / `app` / `bot`) from a user-agent heuristic, which
  catches declared crawlers and link-preview fetchers and nothing more. If bot traffic ever
  distorts a number that matters, the honest options are a WAF rule in front of the Worker or
  Turnstile — not a better regex.
