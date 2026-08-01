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
| Analytics Engine sink | B | Positions pinned by hand-written tests; deployed and writing |
| Pipelines → Iceberg | D | v2 — Pipelines, decided; see PRD §4 |
| Stats read path | B | `GET /v1/stats` deployed, guarded and **proven end to end** — 256 events written and read back through the Worker |
| Dashboard | D | Not started; `/v1/stats` is the JSON it will render |
| Tests | B | 88 across ingest, the sink, stats SQL, the HTTP contract and the registry |
| Ingest auth | D | **Open to writes on purpose** — see ARCHITECTURE.md. Web needs the origin allow-list, apps need write keys |
| Lint | D | `make lint` and `make format` fail — neither eslint nor prettier is installed |

**The round trip is proven.** 256 events were posted to production and read back through
`/v1/stats`, with the enrichment intact on the stored rows: query strings stripped, referrers
reduced to hosts, `country` stamped by the real edge, `curl` classified as `bot`, props stored
as canonical JSON. None of that could be checked locally — `writeDataPoint` does not persist
under `wrangler dev`, which is also why the sink is tested by spying on the binding.

Both secrets are set. `CF_API_TOKEN` was pasted into a chat transcript during setup and
**should be rotated**; it is read-only analytics, so the exposure is bounded, but it currently
carries more than this Worker needs (see below).

**Next:** step 4 — the web snippet (<2 KB, no cookies) and the Swift snippet, both posting to
`https://analytics.superduperai.co/e`. Things that will trip it:

1. **CORS does not exist yet.** A browser beacon needs either the origin allow-list from
   `sites[].url` or a `sendBeacon` call with a `text/plain` body, which is a simple request
   and needs no preflight. Ingest already accepts `text/plain` for this reason.
2. **The snippet must set `anon` itself, or nothing will.** Deriving it server-side needs a
   salted per-day hash of IP + user agent and a secret that does not exist yet.
3. **Read queries are metered** — 10k/day free. `/v1/stats` caches for 60s at the edge, which
   only works because the Worker is on a custom domain; the Cache API is a no-op on
   `*.workers.dev`.
4. **The rollout has a finish line, and it is measurable.** Cloudflare's zone analytics already
   counts every registered site for free (ARCHITECTURE.md). Edge `pageViews` against our
   `page_viewed` per site is what distinguishes "no visitors" from "no snippet", and it is the
   only honest way to know the 13-site rollout is done. Today the edge sees ~1000 page views a
   day on superduperai.co alone and we record none of them.

**Token hygiene, open:** `CF_API_TOKEN` was created from the "Read analytics and logs"
template, so it carries Workers Observability, Zone Logs and Zone Analytics on **all accounts
and all zones**. The ingest Worker needs only `Account · Account Analytics · Read`. Zone
Analytics is needed too *if* the coverage panel above gets built — but scoped to the ten
zones, not to "all". Rotate and narrow.
