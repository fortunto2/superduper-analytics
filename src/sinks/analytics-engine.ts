/**
 * The hot sink. Free on every Workers plan, queryable in seconds through the SQL API, and
 * hard-deleted by Cloudflare after three months — which is the entire reason the archive
 * exists. Nothing historical may ever be answered from here.
 *
 * This file is deliberately dumb: it maps EnrichedEvent onto positions and nothing else.
 * Every judgement — validation, stripping, budgets — happened in ingest.ts, so a bug here can
 * only be a mapping bug, and the mapping is checked by the compiler.
 */
import { BLOB_SLOTS, DOUBLE_SLOTS, INDEX_FIELD, type EnrichedEvent } from "../schema";

/**
 * Absent values become `null`, never omitted. An omitted value would shift every later blob
 * left by one and silently redefine what blob7 means for that row — the failure the
 * append-only rule is written to prevent, arriving through the back door.
 */
export function toDataPoint(event: EnrichedEvent): AnalyticsEngineDataPoint {
  return {
    blobs: BLOB_SLOTS.map((slot) => event[slot] ?? null),
    doubles: DOUBLE_SLOTS.map((slot) => event[slot]),
    // Exactly one index is allowed, and it is the sampling key: Analytics Engine samples per
    // index value, so `source` keeps one noisy site from thinning out a quiet one.
    indexes: [event[INDEX_FIELD]],
  };
}

/**
 * `writeDataPoint` returns void and is documented as non-blocking — the runtime flushes it
 * after the response. That is why there is no `ctx.waitUntil` here despite the build order
 * saying so: there is no promise to wait on. `waitUntil` becomes necessary at the Pipelines
 * sink, which really is async.
 */
export function writeEvents(dataset: AnalyticsEngineDataset, events: EnrichedEvent[]): void {
  for (const event of events) dataset.writeDataPoint(toDataPoint(event));
}
