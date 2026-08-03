/**
 * What a store reports about itself, in one shape.
 *
 * This is a SECOND contract, deliberately separate from `src/schema.ts`. Events are things that
 * happened, one row each, sampled by Analytics Engine. These are daily totals computed by
 * somebody else — exact, restated after the fact, and ours only by copy. Folding them into the
 * event schema would mean applying `sum(_sample_interval)` weighting to numbers that were never
 * sampled, which does not produce an error, it produces a bigger number.
 *
 * The two meet in the dashboard and nowhere else, and even there they are never added together:
 * "people on the landing page" and "installs" are different things counted by different parties
 * with different definitions of a day.
 */

/**
 * The metric names we normalise onto. Apple and Google each invent their own; the mapping lives
 * with the fetcher that knows that store, so nothing downstream has to care which one produced a
 * row.
 *
 * The column in D1 is free text on purpose — a store adding a metric must not need a migration,
 * and an unrecognised metric is better stored than dropped. This list is what the dashboard
 * knows how to draw, not a constraint on what may be written.
 */
export const METRICS = {
  /** Times the store showed the app anywhere — search results, browse, a related-apps shelf. */
  impressions: "impressions",
  /** Times somebody opened the app's page. The step before deciding. */
  page_views: "page_views",
  /** First-time downloads. NOT redownloads — a reinstall is not a new person. */
  installs: "installs",
  redownloads: "redownloads",
  updates: "updates",
  /** Money, in the store's reporting currency converted to USD by the store itself. */
  proceeds_usd: "proceeds_usd",
  /** Units sold, which for a free app with IAP is not the same as installs. */
  units: "units",
} as const;

export type Metric = (typeof METRICS)[keyof typeof METRICS];

/** One measurement. The first six fields are its identity — see the primary key in db/schema.sql. */
export type StoreRow = {
  /** UTC day as the STORE defines it, `YYYY-MM-DD`. Copied, never recomputed from a timestamp. */
  day: string;
  /** Registry id — the same namespace as `source` on an event, which is what makes them comparable. */
  source: string;
  store: "appstore" | "play";
  metric: string;
  /** `ct` on Apple, `utm_campaign` on Play. Empty when the report is not broken down by campaign. */
  campaign: string;
  /** ISO 3166 alpha-2, or empty for a worldwide total. */
  country: string;
  value: number;
};

/**
 * How far back to re-fetch on every run.
 *
 * Apple restates recent days — a number read on Monday for Saturday is not final. Re-fetching a
 * trailing window and upserting is what makes the copy converge on the truth instead of freezing
 * whatever the first read happened to see. Cheap: a week of one app is a few dozen rows.
 */
export const RESTATEMENT_DAYS = 7;

/** `YYYY-MM-DD` in UTC. Store days are UTC days; the local clock never enters into it. */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/** The day `n` days before `day`, staying in UTC. */
export function dayBefore(day: string, n: number): string {
  return utcDay(Date.parse(`${day}T00:00:00Z`) - n * 86_400_000);
}

/** Every day from `from` to `to` inclusive. Empty if `from` is after `to`, never infinite. */
export function daysBetween(from: string, to: string): string[] {
  const out: string[] = [];
  const end = Date.parse(`${to}T00:00:00Z`);
  for (let t = Date.parse(`${from}T00:00:00Z`); t <= end; t += 86_400_000) {
    out.push(utcDay(t));
    // A malformed range must not spin the Worker until it is killed by the runtime.
    if (out.length >= 400) break;
  }
  return out;
}
