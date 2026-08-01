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
| Stats read path | C | `GET /v1/stats` deployed and guarded, but **the round trip is still unproven** — the SQL API secrets are not set, so nothing has ever been read back |
| Dashboard | D | Not started; `/v1/stats` is the JSON it will render |
| Tests | B | 88 across ingest, the sink, stats SQL, the HTTP contract and the registry |
| Ingest auth | D | **Open to writes on purpose** — see ARCHITECTURE.md. Web needs the origin allow-list, apps need write keys |
| Lint | D | `make lint` and `make format` fail — neither eslint nor prettier is installed |

**Blocking, before anything else:** the round trip has never run. `/v1/stats` answers
`not_configured` in production because two secrets are unset:

```sh
pnpm wrangler secret put CF_ACCOUNT_ID   # 33dec9645c443eef5859b1e10ce71e01
pnpm wrangler secret put CF_API_TOKEN    # Account > Account Analytics > Read
```

Until that returns real rows, "events are being collected" is an assumption. `writeDataPoint`
does not persist in local dev — `wrangler dev` accepts the call and stores nothing queryable —
so this cannot be checked any other way, and it is why the sink is tested by spying on the
binding rather than by reading data back.

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
