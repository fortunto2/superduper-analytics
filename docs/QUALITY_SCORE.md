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
| Stats read path | B | `/v1/stats` and `/v1/overview` deployed, guarded and **proven end to end** |
| Unique visitors | C | Not answerable from our events — sampling destroys DISTINCT. Comes from Cloudflare zone analytics instead |
| MCP server | B | `POST /mcp`, four tools, bearer-auth on DASHBOARD_KEY. Stateless Streamable HTTP; verified against production |
| Dashboard | B | Live at `/`, behind `DASHBOARD_KEY`. Coverage panel, trend, both tables; validated palette, both themes |
| Web counter | B | `/sda.js`, 1519 B, proven in a real browser. **Installed on zero sites** |
| Swift snippet | D | Not started |
| Tests | B | 118 across ingest, the sink, stats SQL, anon, the snippet, the HTTP contract and the registry |
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

**Next: install the counter.** Everything is built and nothing is measured — the edge sees
roughly 91,000 people a month across the zones and we record none of them. `docs/install.md`
is one line per site; `life2film.com` alone is 20k page views a month at 0% coverage. The
dashboard's "Counters live 1 / 13" is the number to move.

After that: the Swift snippet, then v2's archive.

Sharp edges for whoever picks this up:

1. **`uniq()` does not exist** in the Analytics Engine dialect, and `count(DISTINCT …)` is a
   lower bound under sampling. Do not build a "unique visitors" chart on our events.
2. **`ORDER BY`/`GROUP BY` must name the alias**, and `FORMAT JSONCompact` does not exist.
3. **Read queries are metered** — 10k/day free. `/v1/overview` makes three upstream calls and
   is cached 60s at the edge, which works only on a custom domain.
4. **`DASHBOARD_KEY` is a stopgap, not authentication.** Cloudflare Access in front of `/` and
   `/v1/*` is free at this scale, is real SSO, and needs no code.

**Token hygiene, open:** `CF_API_TOKEN` was created from the "Read analytics and logs"
template, so it carries Workers Observability, Zone Logs and Zone Analytics on **all accounts
and all zones**. The ingest Worker needs only `Account · Account Analytics · Read`. Zone
Analytics is needed too — the coverage panel depends on it — but scoped to the ten zones,
not to "all accounts, all zones". Rotate and narrow.
