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

/**
 * Имя числовой размерности. Тот же алфавит, что у имён событий: это ключ, который попадает в
 * `GROUP BY` и в имя колонки, и пробел или дефис в нём отравляет и то и другое.
 */
export const MetricName = z
  .string()
  .min(2)
  .max(40)
  .regex(/^[a-z][a-z0-9_]*$/, "snake_case, e.g. days_since_first");

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

  /**
   * The client says it is automated — `navigator.webdriver`, or a headless user agent.
   * Honest automation sets this; dishonest automation lies about everything anyway, so this
   * costs one boolean and catches the large, careless majority: SEO crawlers, uptime monitors
   * and scrapers built on Playwright or Puppeteer, all of which DO run JavaScript and would
   * otherwise be indistinguishable from a person.
   *
   * Not a slot: it folds into `ua_kind` at ingest, so the wire format is unchanged.
   */
  auto: z.boolean().optional(),

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

  /**
   * Where this visit came from, as an ALLOWLIST of three utm tags — never the query string.
   *
   * The query string is stripped at ingest and that stays true: it is where session tokens,
   * password-reset links and email addresses live, and keeping it would turn this from a
   * counter into a leak. But stripping everything also threw away the one thing a campaign
   * needs, so the tags are read by name and nothing else survives.
   *
   * Not free-form props: Analytics Engine's SQL has no JSON functions, so anything that must
   * appear in a GROUP BY has to be its own blob. "Which video sent people" is exactly that.
   */
  utm: z
    .object({
      source: z.string().max(64).optional(),
      medium: z.string().max(64).optional(),
      campaign: z.string().max(64).optional(),
    })
    .optional(),
});

export type Event = z.infer<typeof Event>;

/**
 * Analytics Engine limits, from the Cloudflare docs — the numbers the design must respect:
 *   - 20 blobs and 20 doubles per data point
 *   - 16 KB for ALL blobs in a data point together, not each
 *   - 250 data points per Worker invocation  ← caps the batch size below
 *   - ONE index per data point, max 96 bytes
 *   - data is deleted after 3 months  ← the reason the Iceberg archive exists at all
 *
 * Declared before `Batch` because `Batch` reads MAX_EVENTS_PER_REQUEST at module load.
 */
export const MAX_EVENTS_PER_REQUEST = 250;
export const MAX_BLOBS = 20;
export const MAX_DOUBLES = 20;
export const MAX_BLOB_BYTES = 16 * 1024;

/**
 * How far back the hot store can be asked about. Cloudflare deletes beyond this, so a query
 * with a longer window must be refused rather than silently answered with a short one — a
 * chart that quietly changes what it covers is worse than a chart that errors.
 */
export const RETENTION_DAYS = 90;

/**
 * Reserved for the fixed slots below. Every one of them is length-capped by this schema and
 * they total 1246 characters at most; 5 KB covers that even if every character costs 4 bytes
 * in UTF-8. What remains is what `props` and `metrics` may occupy.
 */
const RESERVED_BLOB_BYTES = 5 * 1024;
export const MAX_FREEFORM_BYTES = MAX_BLOB_BYTES - RESERVED_BLOB_BYTES;

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
  "props_json", // 10  all of `props` as one canonical JSON object — see below
  "metrics_json", // 11  all of `metrics`, likewise
  "utm_source", // 12  allowlisted campaign tags — see `utm` on Event. Appended 2026-08-03.
  "utm_medium", // 13
  "utm_campaign", // 14
  "placement", // 15  где на странице нажали — своя размерность, а не props. Дописано 2026-08-04.
] as const;

/**
 * Why props and metrics are ONE blob each rather than one blob per key.
 *
 * Free-form keys cannot have positions. Two events of the same name may carry different keys,
 * so "props go into blob12 onwards in key order" makes blob12 mean `colour` in one row and
 * `count` in the next — the exact silent corruption the append-only rule exists to prevent.
 * A single JSON object per row has no such ambiguity.
 *
 * The price: the Analytics Engine SQL API has string functions but NO JSON functions, so
 * these two columns cannot be aggregated in the hot store. That is the right trade — the hot
 * store answers "how many, from where, doing what", which lives entirely in the fixed slots
 * above. Numeric analysis of free-form measures is an archive question, and the archive is
 * read by engines that do parse JSON.
 */

/**
 * Doubles are positional exactly like blobs, with the same append-only rule.
 *
 * Only `ts` is fixed here. Analytics Engine stamps its own `timestamp` at write time, which is
 * when the batch arrived — useless for a phone that buffered for two days, so the event's own
 * time has to be carried.
 *
 * Everything after it is the registry's `metrics:` list — see METRIC_SLOTS in `registry.ts`,
 * which is where it lives because a generated file may not be imported from here: `gen` reads
 * this module to validate the very file it is about to write. That split is
 * the point: a new number worth aggregating is one line of YAML and `make gen`, not an edit to
 * this file and a deploy. The discipline does not loosen, it just moves: the list is
 * append-only too, and `make check` refuses a reordering.
 */
export const DOUBLE_SLOTS = ["ts"] as const;

/**
 * The index is what Analytics Engine samples and groups by, and there is only one.
 * `source` is the right choice: nearly every question starts "for which site or app".
 */
export const INDEX_FIELD = "source" as const;

/**
 * Coarse client kind, derived at ingest from the user agent — never sent by the client.
 * Cloudflare's bot *score* lives in `request.cf.botManagement`, which is Enterprise-only, so
 * this is a heuristic and is deliberately named as one.
 */
export const UaKind = z.enum(["browser", "app", "bot"]);

export type BlobSlot = (typeof BLOB_SLOTS)[number];
export type DoubleSlot = (typeof DOUBLE_SLOTS)[number];

/**
 * What comes OUT of ingest: the client's event, validated, stripped and stamped with what the
 * edge knows. `country`, `referrer_host` and `ua_kind` exist only here — a client cannot send
 * them. This is the shape the sinks write, so it is also the shape the slots index into: every
 * field named below is a slot, and every slot is a field.
 */
export type EnrichedEvent = {
  source: string;
  platform: z.infer<typeof Platform>;
  name: string;
  path?: string;
  referrer_host?: string;
  country?: string;
  version?: string;
  anon?: string;
  ua_kind: z.infer<typeof UaKind>;

  /** Authoritative event time (ms). Never the raw client value — see enrich() in ingest.ts. */
  ts: number;

  /** Serialized at ingest, not at the sink, so the 16 KB limit is checked where it can be
   *  reported to the client instead of silently dropping a row later. */
  props_json?: string;
  metrics_json?: string;

  /**
   * Те же метрики необработанным объектом — для позиционных double-слотов.
   *
   * Не дублирование `metrics_json`, а два разных назначения: JSON хранит ВСЁ, что прислали, и
   * читается построчно; слоты берут только имена из реестра и делают их считаемыми. Разбирать
   * JSON обратно в синке было бы дешевле по строчкам и дороже по смыслу: синк обязан оставаться
   * тупым позиционером, иначе он станет вторым местом, где что-то решают про содержимое события.
   */
  metrics?: Record<string, number>;

  /**
   * The campaign that produced the visit. Own slots rather than a JSON blob because every
   * question worth asking here — which video, which ad, which button — is a GROUP BY, and
   * Analytics Engine's SQL cannot reach inside JSON.
   */
  utm_source?: string;
  utm_medium?: string;
  utm_campaign?: string;

  /**
   * Где на странице нажали: `hero`, `footer`, `studio-hero`.
   *
   * Отдельный слот, а не ключ в `props`, по той же причине, что и `utm_*`: у SQL Analytics
   * Engine нет функций для JSON, а «какая кнопка работает» — это GROUP BY. Приходит не от
   * сайта произвольно, а из `data-sda-placement`, который ставит наш же обработчик кликов.
   */
  placement?: string;
};

/**
 * Appending a slot without giving EnrichedEvent a field of that name is now a compile error
 * rather than a column of silent `undefined`. This is what makes the append-only rule above
 * safe to actually follow.
 */
type SlotsCovered =
  Exclude<BlobSlot | DoubleSlot, keyof EnrichedEvent> extends never ? true : never;
const _slotsCovered: SlotsCovered = true;
void _slotsCovered;
