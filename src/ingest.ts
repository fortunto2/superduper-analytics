/**
 * Validate → enrich. No I/O, no Cloudflare types, no clock: everything the edge knows arrives
 * in `EdgeContext`. That is what lets `cli replay` run the REAL pipeline offline instead of an
 * imitation of it, and what keeps this file testable without booting a Worker.
 *
 * Sinks are not here — they are step 2 of the build order, and they consume `EnrichedEvent`.
 */
import { isKnownSource } from "./registry";
import { BLOB_BUDGET, Batch, MAX_DOUBLES, type EnrichedEvent, type Event } from "./schema";

export type EdgeContext = {
  /** Server clock in ms. Injected rather than read, so replays are deterministic. */
  now: number;
  /** From `request.cf` or CF-IPCountry — never from the client. */
  country?: string;
  userAgent?: string;
};

export type IngestResult =
  | { ok: true; events: EnrichedEvent[] }
  | { ok: false; status: 400 | 403; body: { error: string } & Record<string, unknown> };

/**
 * How far behind the edge a client clock may be and still be believed. Mobile buffers events
 * while offline — "a phone on stage has no signal" — so lag is normal and must survive. A week
 * is generous; beyond it the timestamp is more likely a broken clock than a long flight.
 */
const MAX_CLOCK_LAG_MS = 7 * 24 * 60 * 60 * 1000;

/** A client clock ahead of the edge is simply wrong; allow only jitter. */
const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

/** At most this many zod issues come back — an error body is a hint, not a report. */
const MAX_REPORTED_ISSUES = 10;

/**
 * Heuristic, and named as one. Cloudflare's real bot score lives in
 * `request.cf.botManagement`, which is Enterprise-only, so this is what we get.
 */
const BOT_UA =
  /bot|crawl|spider|slurp|headless|preview|monitor|curl|wget|python-requests|facebookexternalhit|whatsapp|telegram/i;

/** Query strings and fragments carry tokens and PII. Neither is worth keeping. */
export function cleanPath(path: string | undefined): string | undefined {
  if (path === undefined) return undefined;
  const cut = path.search(/[?#]/);
  const stripped = cut === -1 ? path : path.slice(0, cut);
  return stripped === "" ? undefined : stripped;
}

/** Referrers are kept as a host only: enough to attribute, too little to leak. */
export function referrerHost(referrer: string | undefined): string | undefined {
  if (referrer === undefined) return undefined;
  try {
    return new URL(referrer).host || undefined;
  } catch {
    return undefined;
  }
}

export function uaKind(
  platform: Event["platform"],
  userAgent: string | undefined,
): EnrichedEvent["ua_kind"] {
  if (platform !== "web") return "app";
  // Every real browser sends a user agent. Nothing that omits it is a person.
  if (userAgent === undefined || userAgent === "") return "bot";
  return BOT_UA.test(userAgent) ? "bot" : "browser";
}

/** Client time when it is plausible, server time when it is not. */
export function stampTime(clientTs: number | undefined, now: number): number {
  if (clientTs === undefined) return now;
  if (clientTs > now + MAX_CLOCK_SKEW_MS) return now;
  if (clientTs < now - MAX_CLOCK_LAG_MS) return now;
  return clientTs;
}

function enrich(event: Event, edge: EdgeContext): EnrichedEvent {
  return {
    source: event.source,
    platform: event.platform,
    name: event.name,
    path: cleanPath(event.path),
    referrer_host: referrerHost(event.referrer),
    country: edge.country,
    version: event.version,
    anon: event.anon,
    ua_kind: uaKind(event.platform, edge.userAgent),
    ts: stampTime(event.ts, edge.now),
    props: event.props,
    metrics: event.metrics,
  };
}

/**
 * A batch is accepted whole or refused whole. Partial acceptance would mean a client that
 * silently loses some events and never learns which — worse than a loud rejection.
 */
export function ingest(body: unknown, edge: EdgeContext): IngestResult {
  const parsed = Batch.safeParse(body);
  if (!parsed.success) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "invalid_batch",
        issues: parsed.error.issues.slice(0, MAX_REPORTED_ISSUES).map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      },
    };
  }

  for (const event of parsed.data.events) {
    // The registry is the whole access-control model. Nothing else may create a source.
    if (!isKnownSource(event.source)) {
      return { ok: false, status: 403, body: { error: "unknown_source", source: event.source } };
    }

    // The schema declares these budgets; without a check here the sink would quietly drop
    // whatever did not fit into blob10..blob20, and the loss would never surface.
    const props = event.props === undefined ? 0 : Object.keys(event.props).length;
    if (props > BLOB_BUDGET) {
      return {
        ok: false,
        status: 400,
        body: { error: "too_many_props", event: event.name, limit: BLOB_BUDGET, got: props },
      };
    }

    const metrics = event.metrics === undefined ? 0 : Object.keys(event.metrics).length;
    if (metrics > MAX_DOUBLES) {
      return {
        ok: false,
        status: 400,
        body: { error: "too_many_metrics", event: event.name, limit: MAX_DOUBLES, got: metrics },
      };
    }
  }

  return { ok: true, events: parsed.data.events.map((event) => enrich(event, edge)) };
}
