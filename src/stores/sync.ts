/**
 * The daily job: ask each store what happened, write it down.
 *
 * Runs on cron, and also on demand from `POST /v1/stores/sync` — because a job that can only be
 * observed by waiting until tomorrow is a job nobody can debug.
 */
import { APPS } from "../registry.generated";
import { ascToken, fetchSalesReport, parseSalesReport } from "./appstore";
import { readSync, writeRows, writeSync } from "./db";
import { dayBefore, daysBetween, RESTATEMENT_DAYS, utcDay } from "./schema";

export type SyncResult = {
  provider: string;
  days: number;
  rows: number;
  skipped: number;
  from: string;
  to: string;
  notes: string[];
};

/**
 * How far back a first run reaches. Apple keeps daily sales reports for a rolling year or so;
 * pulling that on the very first run would be a hundred-odd requests in one invocation. Thirty
 * days is enough to see the current shape, and backfill is a deliberate act with an explicit
 * `?from=` rather than something that happens by surprise on a Tuesday.
 */
const FIRST_RUN_DAYS = 30;

/**
 * Apple's summary report covers the whole vendor account, so twelve apps cost one request per
 * day rather than twelve. The registry decides which of them we keep: an app in the account but
 * not in `registry/sources.yaml` is skipped, never invented as a new source.
 */
export async function syncAppStore(
  env: {
    STORES: D1Database;
    ASC_KEY_ID?: string;
    ASC_ISSUER_ID?: string;
    ASC_PRIVATE_KEY?: string;
    ASC_VENDOR_NUMBER?: string;
  },
  now: number,
  explicitFrom?: string,
): Promise<SyncResult> {
  const notes: string[] = [];
  const { ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, ASC_VENDOR_NUMBER } = env;
  if (!ASC_KEY_ID || !ASC_ISSUER_ID || !ASC_PRIVATE_KEY || !ASC_VENDOR_NUMBER) {
    return {
      provider: "appstore",
      days: 0,
      rows: 0,
      skipped: 0,
      from: "",
      to: "",
      notes: ["not configured: ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, ASC_VENDOR_NUMBER"],
    };
  }

  const storeIdToSource = new Map(
    APPS.filter((a) => a.platform === "ios").map((a) => [a.storeId, a.id as string]),
  );

  // Yesterday, not today: today's report does not exist yet, and asking for it is a 404 on every
  // single run — noise that teaches you to ignore the logs.
  const to = dayBefore(utcDay(now), 1);
  const previous = await readSync(env.STORES, "appstore");
  const furthest = [...previous.values()].sort().pop();
  const from =
    explicitFrom ??
    (furthest === undefined
      ? dayBefore(to, FIRST_RUN_DAYS)
      : // Back up over the restatement window: the last few days we already have are not final.
        dayBefore(furthest, RESTATEMENT_DAYS));

  const token = await ascToken(ASC_KEY_ID, ASC_ISSUER_ID, ASC_PRIVATE_KEY, now);
  const days = daysBetween(from, to);

  let rows = 0;
  let skipped = 0;
  let lastGood = "";
  for (const day of days) {
    let tsv: string | null;
    try {
      tsv = await fetchSalesReport({ token, vendorNumber: ASC_VENDOR_NUMBER, day });
    } catch (error) {
      // One bad day must not lose the days after it. Recorded and carried past, because the
      // alternative — stopping — means a single transient 500 freezes the watermark forever.
      notes.push(`${day}: ${String(error)}`);
      continue;
    }
    // 404 is the honest answer for a day with no sales at all. Nothing to write, and the
    // watermark still advances — otherwise a quiet week would make the job re-ask forever.
    if (tsv !== null) {
      const parsed = parseSalesReport(tsv, storeIdToSource);
      rows += await writeRows(env.STORES, parsed.rows, now);
      skipped += parsed.skipped;
    }
    lastGood = day;
  }

  if (lastGood !== "") {
    // One watermark per source, all the same day: the report is per-vendor, so either every app
    // in it is current or none is.
    await writeSync(
      env.STORES,
      "appstore",
      new Map([...storeIdToSource.values()].map((id) => [id, lastGood])),
      now,
      notes.join("; ").slice(0, 500),
    );
  }

  return { provider: "appstore", days: days.length, rows, skipped, from, to, notes };
}
