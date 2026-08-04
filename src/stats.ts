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
  /** Проверенные ИИ-агенты на хосте этого продукта за сутки. Заполняется в overview.ts. */
  ai_requests?: number;
  source: string;
  platform: string;
  /** Everything, humans and bots together. */
  events: number;
  /** Classified `bot` by ua_kind. Reported, not hidden — see buildQuery. */
  bot_events: number;
  /** Page views from clients NOT classified as bots. This is the number worth reading. */
  page_views: number;
  /** Of those, how many saw a scroll, click or keypress. The hardest signal to fake cheaply. */
  engaged: number;
  /**
   * Distinct anonymous ids among non-bot rows. A LOWER BOUND: Analytics Engine samples, and a
   * sampled-away row takes its `anon` with it, so no weighting recovers it. `max_sample` says
   * when to distrust it.
   *
   * Still the better figure for "how many people" than Cloudflare's edge uniques, which do not
   * lose rows to sampling but do count every scraper. A bot-filtered undercount beats an
   * unfiltered overcount — measured on life2film, the edge said 20k and the truth was 2.
   */
  people_seen: number;
  /** 1 means nothing was dropped; above 1 means `people_seen` understates. */
  max_sample: number;
  /** Registrable domain, attached by overview.ts so a product's subdomains sit together. */
  domain?: string;
};

/**
 * One day of one product. Kept per source rather than pre-summed: the overview adds them up in
 * the browser, and a product page needs its own line — two queries for the same rows would cost
 * twice the metered read budget to answer the same question.
 */
export type DayTotal = { day: string; source: string; events: number };

export type Stats = {
  /** Empty until something is tagged — which is the normal state before the first campaign. */
  campaigns?: CampaignTotal[];
  window_days: number;
  /** Always true, and stated in the payload so a consumer cannot forget what these are. */
  sampled: true;
  total_events: number;
  total_bot_events: number;
  /** Non-bot page views, and the distinct non-bot ids behind them. */
  total_page_views: number;
  total_engaged: number;
  total_people: number;
  /** True when sampling actually dropped rows, i.e. when `people_seen` is understated. */
  sampling_active: boolean;
  sources: SourceTotal[];
  daily: DayTotal[];
};

export type StatsFailure = { status: 400 | 500 | 502; body: { error: string } & Record<string, unknown> };

/** Only what the SQL API is actually asked for; the rest of its response is ignored. */
type SqlResponse = { data?: Record<string, unknown>[] };

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
    "  sum(_sample_interval) AS events,",
    // blob9 is ua_kind. Bots are counted, never silently dropped — a source that is 90% bot
    // is a fact about that source, and hiding it is how a number quietly becomes wrong.
    "  sum(if(blob9 = 'bot', _sample_interval, 0)) AS bot_events,",
    "  sum(if(blob9 != 'bot' AND blob3 = 'page_viewed', _sample_interval, 0)) AS page_views,",
    // Loading a page is what a crawler does; scrolling or clicking is what a person does. This
    // is the strongest human signal in the dataset and it costs one event per visit.
    "  sum(if(blob9 != 'bot' AND blob3 = 'page_engaged', _sample_interval, 0)) AS engaged,",
    // `uniq()` does not exist in this dialect; `count(DISTINCT …)` does. It is a lower bound
    // under sampling, which is why max_sample rides along to say when to distrust it.
    //
    // `if(…, blob8, null)` is rejected — both branches must share a type — so bot rows collapse
    // onto the empty string and contribute exactly one spurious distinct value, removed below.
    "  count(DISTINCT if(blob9 != 'bot', blob8, '')) AS people_raw,",
    "  max(_sample_interval) AS max_sample",
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
  return rows.map((row) => {
    const bot_events = Number(row.bot_events ?? 0);
    // Remove the empty-string bucket every bot row collapsed onto — see buildQuery.
    const people_raw = Number(row.people_raw ?? 0);
    return {
      source: String(row.source ?? ""),
      platform: String(row.platform ?? ""),
      events: Number(row.events ?? 0),
      bot_events,
      page_views: Number(row.page_views ?? 0),
      engaged: Number(row.engaged ?? 0),
      people_seen: Math.max(0, people_raw - (bot_events > 0 ? 1 : 0)),
      max_sample: Number(row.max_sample ?? 1),
    };
  });
}

/** Events per day, for the trend line. Same weighting rule as everything else. */
export function buildDailyQuery(dataset: string, days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) {
    throw new Error(`days must be an integer in 1..${RETENTION_DAYS}, got ${String(days)}`);
  }
  return [
    "SELECT",
    "  toDate(timestamp) AS day,",
    "  blob1 AS source,",
    "  sum(_sample_interval) AS events",
    `FROM ${dataset}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY`,
    "GROUP BY day, source",
    "ORDER BY day",
    "FORMAT JSON",
  ].join("\n");
}

export function parseDays(payload: unknown): DayTotal[] {
  const rows = (payload as { data?: Record<string, unknown>[] } | null)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    day: String(row.day ?? ""),
    source: String(row.source ?? ""),
    events: Number(row.events ?? 0),
  }));
}

/** One campaign, as our own side of the funnel sees it. */
export type CampaignTotal = {
  source: string;
  utm_source: string;
  utm_medium: string;
  utm_campaign: string;
  /** Visits carrying the tag. Bots excluded — a crawler following a tagged link is not a click. */
  page_views: number;
  /** Of those, the ones that scrolled, clicked or typed. The honest denominator for a channel. */
  engaged: number;
  /** Clicks on a store button, when the site marks one up with `data-sda-event`. */
  store_clicks: number;
  /**
   * Bots that followed the tagged link. Kept rather than filtered away, because a campaign whose
   * row is all zeros except this one is not a broken tag — it is a link that got scraped and not
   * clicked, and those two look identical if the column is missing.
   */
  bot_views: number;
};

/**
 * What each campaign brought — the question a video or an ad exists to answer.
 *
 * Only rows that carry a tag: an untagged visit is not "campaign none", it is a visit that this
 * table has nothing to say about, and putting it here as a row called '' would make every
 * channel look tiny next to it.
 *
 * `store_clicks` counts `app_store_opened`, which is what the shared snippet fires from
 * `data-sda-event` markup. That is our last observable step — everything after it is Apple's,
 * and it joins back by the same tag rather than by any identifier.
 */
export function buildCampaignQuery(dataset: string, days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) {
    throw new Error(`days must be an integer in 1..${RETENTION_DAYS}, got ${String(days)}`);
  }
  return [
    "SELECT",
    "  blob1 AS source,",
    "  blob12 AS utm_source,",
    "  blob13 AS utm_medium,",
    "  blob14 AS utm_campaign,",
    "  sum(if(blob9 != 'bot' AND blob3 = 'page_viewed', _sample_interval, 0)) AS page_views,",
    "  sum(if(blob9 != 'bot' AND blob3 = 'page_engaged', _sample_interval, 0)) AS engaged,",
    "  sum(if(blob9 != 'bot' AND blob3 = 'app_store_opened', _sample_interval, 0)) AS store_clicks,",
    "  sum(if(blob9 = 'bot', _sample_interval, 0)) AS bot_views",
    `FROM ${dataset}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY AND blob14 != ''`,
    "GROUP BY source, utm_source, utm_medium, utm_campaign",
    "ORDER BY page_views DESC",
    "LIMIT 50",
    "FORMAT JSON",
  ].join("\n");
}

export function parseCampaigns(payload: unknown): CampaignTotal[] {
  const rows = (payload as { data?: Record<string, unknown>[] } | null)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    source: String(row.source ?? ""),
    utm_source: String(row.utm_source ?? ""),
    utm_medium: String(row.utm_medium ?? ""),
    utm_campaign: String(row.utm_campaign ?? ""),
    page_views: Number(row.page_views ?? 0),
    engaged: Number(row.engaged ?? 0),
    store_clicks: Number(row.store_clicks ?? 0),
    bot_views: Number(row.bot_views ?? 0),
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

  const url = `${SQL_ENDPOINT}/${env.CF_ACCOUNT_ID}/analytics_engine/sql`;
  const ask = (sql: string) =>
    fetch(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN ?? ""}` },
      body: sql,
    });

  const [totals, daily, campaigns] = await Promise.all([
    ask(buildQuery(env.DATASET, days)),
    ask(buildDailyQuery(env.DATASET, days)),
    ask(buildCampaignQuery(env.DATASET, days)),
  ]);

  if (!totals.ok) {
    // The upstream text is safe to relay — it never echoes the token — and without it every
    // failure here looks identical from the outside.
    return {
      ok: false,
      status: 502,
      body: { error: "sql_api_failed", status: totals.status, detail: await totals.text() },
    };
  }

  const sources = parseRows(await totals.json());
  return {
    ok: true,
    stats: {
      window_days: days,
      sampled: true,
      total_events: sources.reduce((sum, row) => sum + row.events, 0),
      total_bot_events: sources.reduce((sum, row) => sum + row.bot_events, 0),
      total_page_views: sources.reduce((sum, row) => sum + row.page_views, 0),
      total_engaged: sources.reduce((sum, row) => sum + row.engaged, 0),
      // Summed across sources rather than counted globally: the same person on two sites is
      // two ids anyway, since `anon` is derived per day and never joined across properties.
      total_people: sources.reduce((sum, row) => sum + row.people_seen, 0),
      sampling_active: sources.some((row) => row.max_sample > 1),
      sources,
      // The trend is decoration next to the totals: if it fails, show the numbers anyway.
      daily: daily.ok ? parseDays(await daily.json()) : [],
      campaigns: campaigns.ok ? parseCampaigns(await campaigns.json()) : [],
    },
  };
}
