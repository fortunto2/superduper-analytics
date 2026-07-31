/**
 * The event contract. Schemas first — everything else (ingest, archive, dashboard, the Swift
 * and web snippets) is derived from this file, so change it here and nowhere else.
 *
 * One schema for web AND mobile on purpose: a landing visit and an app launch must be
 * comparable without a join, otherwise the funnel this project exists for cannot be built.
 */
import { z } from "zod/v4";

/** Ids come from registry/sources.yaml and are permanent — they partition the archive. */
export const SourceId = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z0-9-]+$/, "lowercase, digits and dashes — it becomes a partition value");

export const Platform = z.enum(["web", "ios", "android", "macos", "server"]);

/**
 * Event names are deliberately open. Fixed taxonomies rot: every product invents a verb the
 * taxonomy did not anticipate, and the workaround is worse than the freedom.
 * Convention: `object_verb` in past tense — `page_viewed`, `take_recorded`, `purchase_completed`.
 */
export const EventName = z
  .string()
  .min(2)
  .max(64)
  .regex(/^[a-z][a-z0-9_]*$/, "snake_case, e.g. page_viewed");

export const Event = z.object({
  /** Which site or app. Must exist in registry/sources.yaml — ingest rejects unknown ids. */
  source: SourceId,
  platform: Platform,
  name: EventName,

  /**
   * Coarse anonymous id. NOT a cookie and NOT stable across devices — that is the point:
   * it keeps the consent-banner question closed. Web derives it per-day from a salted hash
   * of IP + user agent; apps use an install-scoped UUID.
   */
  anon: z.string().max(64).optional(),

  /** Client timestamp (ms). Advisory only — ingest stamps the authoritative server time. */
  ts: z.number().int().positive().optional(),

  /** Where it happened: page path, or app screen. Query strings are stripped at ingest. */
  path: z.string().max(512).optional(),
  referrer: z.string().max(512).optional(),

  /** Product/app version, so a regression can be pinned to a release. */
  version: z.string().max(32).optional(),

  /**
   * Free-form dimensions. Analytics Engine allows 20 blobs total and the fixed fields above
   * already claim some, so this is capped — see BLOB_BUDGET below.
   */
  props: z.record(z.string().max(40), z.string().max(200)).optional(),

  /** Free-form measures — durations, counts, prices. */
  metrics: z.record(z.string().max(40), z.number()).optional(),
});

export type Event = z.infer<typeof Event>;

/**
 * Analytics Engine limits, from the Cloudflare docs — the numbers the design must respect:
 *   - 20 blobs and 20 doubles per data point
 *   - 16 KB per data point
 *   - 250 data points per Worker invocation  ← caps the batch size below
 *   - ONE index per data point, max 96 bytes
 *   - data is deleted after 3 months  ← the reason the Iceberg archive exists at all
 *
 * Declared before `Batch` because `Batch` reads MAX_EVENTS_PER_REQUEST at module load.
 */
export const MAX_EVENTS_PER_REQUEST = 250;
export const MAX_BLOBS = 20;
export const MAX_DOUBLES = 20;

/** A batch: one HTTP request may carry many events, which is how mobile flushes its buffer. */
export const Batch = z.object({
  events: z.array(Event).min(1).max(MAX_EVENTS_PER_REQUEST),
});

/**
 * Fixed blob slots. Positions are part of the wire format: every query written against this
 * data refers to blob1..blobN by position, so slots may be APPENDED but never reordered or
 * reused for something else.
 */
export const BLOB_SLOTS = [
  "source", // 1
  "platform", // 2
  "name", // 3
  "path", // 4
  "referrer_host", // 5  host only — the full referrer is not kept
  "country", // 6  from request.cf, not from the client
  "version", // 7
  "anon", // 8
  "ua_kind", // 9  coarse: browser / app / bot
] as const;

/** Blobs left for `props` after the fixed slots above. */
export const BLOB_BUDGET = MAX_BLOBS - BLOB_SLOTS.length;

/**
 * The index is what Analytics Engine samples and groups by, and there is only one.
 * `source` is the right choice: nearly every question starts "for which site or app".
 */
export const INDEX_FIELD = "source" as const;
