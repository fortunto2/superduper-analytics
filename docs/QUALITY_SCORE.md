# Quality score

Honest grades per area, so the next session knows where the thin ice is.
Scale: A solid · B works, rough edges · C stub · D absent.

| Area | Grade | Note |
|---|---|---|
| PRD / brief | A | Records what was rejected and why — the expensive part to rediscover |
| Event schema | B | Real and reviewed; a slot without a field is now a compile error. Unproven against actual traffic |
| Source registry | B | 13 sites and 12 apps from live inventory; generated into the Worker, drift caught by `make check`. `sync` not written |
| Architecture doc | B | Boundaries and the two-sink rationale are clear |
| Ingest Worker | B | `POST /e` validates, refuses unknown sources, enriches. No auth, no sinks |
| CLI | B | `gen`, `check`, `replay` real and offline; `sync` still a stub |
| Analytics Engine sink | D | Not started — step 2 |
| Pipelines → Iceberg | D | v2 |
| Dashboard | D | Not started |
| Tests | B | 50 across ingest, the HTTP contract and the registry; no sink to test yet |
| Ingest auth | D | **Open to writes on purpose** — see ARCHITECTURE.md. Web needs the origin allow-list, apps need write keys |
| Lint | D | `make lint` and `make format` fail — neither eslint nor prettier is installed |

**Next:** step 2 of the build order — the Analytics Engine sink behind `ctx.waitUntil`, mapping
`EnrichedEvent` onto `BLOB_SLOTS`. Two things to settle there before writing code:

1. `DOUBLE_SLOTS` does not exist yet. `ts`, and every value in `metrics`, needs a position, and
   positions are a wire format the same way blobs are.
2. Free-form `props` cannot go into positional `blob10..blob20` — key order differs per event,
   so `blob10` would mean something different from row to row. One JSON blob in a single slot
   is probably the answer. Ingest already enforces the count budget, which is all it can do
   without deciding this.
