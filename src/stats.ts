/**
 * Reading the hot store. Never writes — that direction is the sink's, and mixing them is how
 * a dashboard eventually starts creating sources.
 *
 * The dangerous part of this file is not the HTTP call, it is the SQL. Analytics Engine
 * SAMPLES: each stored row carries `_sample_interval`, the number of real events it stands
 * for, and a plain `count()` returns a smaller number with no error and no warning. Every
 * aggregate here is built weighted, and `buildQuery` is pure so a test can read the SQL and
 * prove it.
 */
import { RETENTION_DAYS } from "./schema";

export type SourceTotal = {
  source: string;
  platform: string;
  events: number;
};

export type Stats = {
  window_days: number;
  /** Always true, and stated in the payload so a consumer cannot forget what these are. */
  sampled: true;
  total_events: number;
  sources: SourceTotal[];
};

export type StatsFailure = { status: 400 | 500 | 502; body: { error: string } & Record<string, unknown> };

/** Only what the SQL API is actually asked for; the rest of its response is ignored. */
type SqlResponse = { data?: { source?: unknown; platform?: unknown; events?: unknown }[] };

const SQL_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";

/**
 * `days` is interpolated into SQL, so it is forced through Number and an integer check first —
 * the only user input that reaches the query, and the only place injection could enter.
 * Blob positions are spelled out with their meaning because that is what the numbers are: a
 * wire format, not an implementation detail.
 */
export function buildQuery(dataset: string, days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) {
    throw new Error(`days must be an integer in 1..${RETENTION_DAYS}, got ${String(days)}`);
  }
  return [
    "SELECT",
    "  blob1 AS source,",
    "  blob2 AS platform,",
    // count() would undercount silently — Analytics Engine samples.
    "  sum(_sample_interval) AS events",
    `FROM ${dataset}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY`,
    "GROUP BY source, platform",
    // ORDER BY must name the ALIAS. `ORDER BY blob1` after `blob1 AS source` fails with
    // "unable to find type of column" — the dialect resolves the select list first and forgets
    // the raw name. Same for GROUP BY. Verified against the live API.
    "ORDER BY events DESC",
    // JSONCompact does not exist here; JSON does. The dialect is ClickHouse-shaped, not
    // ClickHouse — assume nothing about a function until it has answered.
    "FORMAT JSON",
  ].join("\n");
}

/** The SQL API returns aggregates as strings often enough that coercing is not optional. */
export function parseRows(payload: unknown): SourceTotal[] {
  const rows = (payload as SqlResponse | null)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    source: String(row.source ?? ""),
    platform: String(row.platform ?? ""),
    events: Number(row.events ?? 0),
  }));
}

export type StatsEnv = {
  DATASET: string;
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
};

export async function fetchStats(
  env: StatsEnv,
  days: number,
): Promise<{ ok: true; stats: Stats } | ({ ok: false } & StatsFailure)> {
  if (!Number.isInteger(days) || days < 1) {
    return { ok: false, status: 400, body: { error: "bad_window", message: "days must be a positive integer" } };
  }
  if (days > RETENTION_DAYS) {
    // Refuse rather than quietly answer a shorter window. Longer questions are archive
    // questions, and the archive is a different store with different numbers.
    return {
      ok: false,
      status: 400,
      body: {
        error: "beyond_retention",
        message: `the hot store keeps ${RETENTION_DAYS} days; anything older lives in the archive`,
        limit: RETENTION_DAYS,
      },
    };
  }
  if (env.CF_ACCOUNT_ID === undefined || env.CF_API_TOKEN === undefined) {
    return {
      ok: false,
      status: 500,
      body: {
        error: "not_configured",
        message: "CF_ACCOUNT_ID and CF_API_TOKEN are unset — see `wrangler secret put`",
      },
    };
  }

  const response = await fetch(`${SQL_ENDPOINT}/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: buildQuery(env.DATASET, days),
  });

  if (!response.ok) {
    // The upstream text is safe to relay — it never echoes the token — and without it every
    // failure here looks identical from the outside.
    return {
      ok: false,
      status: 502,
      body: { error: "sql_api_failed", status: response.status, detail: await response.text() },
    };
  }

  const sources = parseRows(await response.json());
  return {
    ok: true,
    stats: {
      window_days: days,
      sampled: true,
      total_events: sources.reduce((sum, row) => sum + row.events, 0),
      sources,
    },
  };
}
