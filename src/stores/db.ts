/**
 * Reading and writing the store numbers in D1.
 *
 * Dumb by design, like the sinks: it positions rows and answers questions, it decides nothing.
 * Every judgement about what a number means lives in the fetcher that produced it.
 */
import type { StoreRow } from "./schema";

/**
 * Writes are UPSERTs, and that is load-bearing rather than tidy.
 *
 * Apple restates recent days: the number read on Monday for Saturday is not final. The daily job
 * therefore re-fetches a trailing window every run, and against an append-only table that would
 * double every number in the window on every run — silently, because a doubled install count
 * still looks like a plausible install count. Keyed on the whole identity of a measurement, a
 * re-run either changes a value or does nothing.
 */
export async function writeRows(db: D1Database, rows: StoreRow[], now: number): Promise<number> {
  if (rows.length === 0) return 0;

  const statement = db.prepare(
    `INSERT INTO store_daily (day, source, store, metric, campaign, country, value, fetched)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, source, store, metric, campaign, country)
     DO UPDATE SET value = excluded.value, fetched = excluded.fetched`,
  );

  // One batch is one transaction: a run that dies halfway leaves the day either written or not,
  // never half-written and looking complete.
  await db.batch(
    rows.map((r) =>
      statement.bind(r.day, r.source, r.store, r.metric, r.campaign, r.country, r.value, now),
    ),
  );
  return rows.length;
}

/** Where the last run got to, so the next one starts from fact rather than from the clock. */
export async function readSync(
  db: D1Database,
  store: string,
): Promise<Map<string, string>> {
  const { results } = await db
    .prepare(`SELECT source, through FROM store_sync WHERE store = ?`)
    .bind(store)
    .all<{ source: string; through: string }>();
  return new Map(results.map((r) => [r.source, r.through]));
}

export async function writeSync(
  db: D1Database,
  store: string,
  through: Map<string, string>,
  now: number,
  note = "",
): Promise<void> {
  if (through.size === 0) return;
  const statement = db.prepare(
    `INSERT INTO store_sync (store, source, through, ran, note) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (store, source)
     DO UPDATE SET through = excluded.through, ran = excluded.ran, note = excluded.note`,
  );
  await db.batch(
    [...through].map(([source, day]) => statement.bind(store, source, day, now, note)),
  );
}

export type StoreTotal = {
  source: string;
  store: string;
  metric: string;
  value: number;
};

/**
 * Totals per source over a window — what the dashboard draws next to the site numbers.
 *
 * Country and campaign are summed away here. Both are worth keeping in the table (they cost
 * nothing and cannot be recovered once dropped) and neither belongs on the overview: the question
 * that page answers is "is this product alive", and thirty countries do not help answer it.
 */
export async function readTotals(
  db: D1Database,
  from: string,
  to: string,
): Promise<StoreTotal[]> {
  const { results } = await db
    .prepare(
      `SELECT source, store, metric, SUM(value) AS value
         FROM store_daily
        WHERE day >= ? AND day <= ?
     GROUP BY source, store, metric
     ORDER BY source, store, metric`,
    )
    .bind(from, to)
    .all<StoreTotal>();
  return results;
}

/** One metric per day, for a chart. Campaign and country summed away for the same reason. */
export async function readSeries(
  db: D1Database,
  source: string,
  metric: string,
  from: string,
  to: string,
): Promise<{ day: string; value: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT day, SUM(value) AS value
         FROM store_daily
        WHERE source = ? AND metric = ? AND day >= ? AND day <= ?
     GROUP BY day
     ORDER BY day`,
    )
    .bind(source, metric, from, to)
    .all<{ day: string; value: number }>();
  return results;
}

/**
 * Installs broken down by campaign token — the one question the funnel work exists to answer:
 * did the landing page produce installs, and which button.
 *
 * Rows with an empty campaign are the ones Apple could not attribute; they are returned as `''`
 * rather than hidden, because "40 installs, 38 of them unattributed" is a very different fact
 * from "2 installs".
 */
export async function readCampaigns(
  db: D1Database,
  from: string,
  to: string,
): Promise<{ source: string; campaign: string; metric: string; value: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT source, campaign, metric, SUM(value) AS value
         FROM store_daily
        WHERE day >= ? AND day <= ? AND campaign <> ''
     GROUP BY source, campaign, metric
     ORDER BY value DESC`,
    )
    .bind(from, to)
    .all<{ source: string; campaign: string; metric: string; value: number }>();
  return results;
}
