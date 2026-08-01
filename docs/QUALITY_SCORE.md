# Quality score

Honest grades per area, so the next session knows where the thin ice is.
Scale: A solid · B works, rough edges · C stub · D absent.

| Area | Grade | Note |
|---|---|---|
| PRD / brief | A | Records what was rejected and why — the expensive part to rediscover |
| Event schema | B | Real and reviewed; a slot without a field is now a compile error. Unproven against actual traffic |
| Source registry | B | 13 sites and 12 apps from live inventory; generated into the Worker, drift caught by `make check`. `sync` not written |
| Architecture doc | B | Boundaries and the two-sink rationale are clear |
| Ingest Worker | B | `POST /e` validates, refuses unknown sources, enriches, writes. No auth |
| CLI | B | `gen`, `check`, `replay` real and offline; `sync` still a stub |
| Analytics Engine sink | B | Positions pinned by hand-written tests; never exercised against the real dataset |
| Pipelines → Iceberg | D | v2, and the approach is an open fork — see PRD §4 |
| Dashboard | D | Not started — step 3 |
| Tests | B | 63 across ingest, the sink, the HTTP contract and the registry |
| Ingest auth | D | **Open to writes on purpose** — see ARCHITECTURE.md. Web needs the origin allow-list, apps need write keys |
| Lint | D | `make lint` and `make format` fail — neither eslint nor prettier is installed |

**Next:** step 3 — `GET /v1/stats` over the SQL API, which is the first thing that proves data
actually landed. What it needs and what will trip it:

1. **Two secrets that do not exist yet:** a Cloudflare account id and an API token with
   Account Analytics read. `wrangler secret put`, never the repo.
2. **Every aggregate must be the weighted form.** `sum(_sample_interval)`, not `count()`. A
   plain `count()` returns a plausible smaller number and no error, which is the worst
   possible failure for a dashboard. Table in ARCHITECTURE.md.
3. **Read queries are metered** — 10k/day free, 1M/month paid. A dashboard that queries per
   page load needs caching before it needs features.
4. **Never fall back to the archive mid-chart.** Analytics Engine holds three months; a chart
   that silently stitches must instead stop.
5. **`writeDataPoint` does not persist in local dev.** `wrangler dev` accepts the call and
   stores nothing queryable, so the round trip can only be proven against a deployed Worker.
   That is why step 2 is tested by spying on the binding rather than by reading data back —
   and why step 3's first real check has to happen after `make deploy`.
