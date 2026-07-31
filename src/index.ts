/**
 * Worker entry — STUB. Routing and the shape of the ingest path are sketched here so the
 * contract is unambiguous; none of it is implemented yet.
 *
 * Build order that keeps every step verifiable:
 *   1. POST /e  → validate against schema.ts, reject unknown `source`, 204. No sinks yet.
 *   2. Analytics Engine sink behind ctx.waitUntil, with the BLOB_SLOTS mapping.
 *   3. /v1/stats reading back through the SQL API — proves the round trip.
 *   4. The web snippet, then the Swift snippet.
 *   5. Only then Pipelines → R2 Iceberg (v2).
 */
import { Hono } from "hono";
import { Batch, BLOB_SLOTS, INDEX_FIELD } from "./schema";

type Bindings = {
  /** Analytics Engine dataset — hot store, 3-month retention. */
  EVENTS: AnalyticsEngineDataset;
};

const app = new Hono<{ Bindings: Bindings }>();

app.get("/health", (c) => c.json({ ok: true, stage: "skeleton" }));

/**
 * Ingest. One endpoint for web beacons and mobile flushes — same schema, so a landing visit
 * and an app launch are comparable without a join.
 *
 * TODO(1): parse with Batch, 400 on failure with the zod issues.
 * TODO(2): reject a `source` that is not in registry/sources.yaml (generated at build time
 *          into a Set — do NOT read YAML at request time).
 * TODO(3): enrich from request.cf — country, bot score — and stamp server time. Client
 *          values stay advisory.
 * TODO(4): strip query strings from `path`, reduce `referrer` to its host.
 * TODO(5): write via ctx.waitUntil so the beacon never delays the page. Map fields onto
 *          blobs using BLOB_SLOTS order and set the index to INDEX_FIELD.
 * Respond 204 with no body — nothing useful to say, and it keeps the beacon cheap.
 */
app.post("/e", async (c) => {
  void Batch;
  void BLOB_SLOTS;
  void INDEX_FIELD;
  return c.json({ error: "not implemented" }, 501);
});

/** Read-only stats for the dashboard. Never writes. */
app.get("/v1/stats", (c) => c.json({ error: "not implemented" }, 501));

export default app;
