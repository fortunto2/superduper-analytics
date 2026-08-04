/**
 * Суточный джоб Search Console: показы и запросы за день, в D1.
 *
 * Search Console отдаёт данные с задержкой в два-три дня и потом уточняет их, поэтому джоб
 * ходит не за «вчера», а за окно, и пишет UPSERT'ом. Взять один вчерашний день значило бы
 * записывать пустоту каждый раз и не заметить этого.
 */
import { fetchSearchDay, googleToken, searchableSites, type SearchEnv, type SearchRow } from "./console";
import { dayBefore, utcDay } from "../stores/schema";

/** Насколько отстаёт консоль. Три дня — с запасом к её обычным двум. */
const LAG_DAYS = 3;

/** И насколько глубоко перезабирать: столько дней она ещё уточняет. */
const RESTATE_DAYS = 5;

export type SearchSyncResult = {
  provider: "search-console";
  days: number;
  sites: number;
  rows: number;
  notes: string[];
};

export async function syncSearchConsole(
  env: SearchEnv & { STORES?: D1Database },
  now: number,
): Promise<SearchSyncResult> {
  const notes: string[] = [];
  if (env.STORES === undefined) return { provider: "search-console", days: 0, sites: 0, rows: 0, notes: ["no D1"] };

  const token = await googleToken(env, now);
  if (token === undefined) {
    return {
      provider: "search-console",
      days: 0,
      sites: 0,
      rows: 0,
      notes: ["not configured: GOOGLE_SA_EMAIL, GOOGLE_SA_KEY"],
    };
  }

  const to = dayBefore(utcDay(now), LAG_DAYS);
  const days: string[] = [];
  for (let i = 0; i < RESTATE_DAYS; i += 1) days.push(dayBefore(to, i));

  const sites = searchableSites();
  const statement = env.STORES.prepare(
    `INSERT INTO search_daily (day, site, kind, key, clicks, impressions, position, fetched)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, site, kind, key) DO UPDATE SET
       clicks = excluded.clicks, impressions = excluded.impressions,
       position = excluded.position, fetched = excluded.fetched`,
  );

  let rows = 0;
  for (const site of sites) {
    const collected: SearchRow[] = [];
    for (const day of days) {
      for (const kind of ["query", "page"] as const) {
        try {
          collected.push(...(await fetchSearchDay(token, site.url, site.id, day, kind)));
        } catch (error) {
          // Один сайт без доступа не должен уносить остальные: ресурс мог быть не подтверждён
          // для сервисного аккаунта, и это факт про настройку, а не сбой джоба.
          notes.push(`${site.id} ${day} ${kind}: ${String(error)}`);
        }
      }
    }
    if (collected.length === 0) continue;
    await env.STORES.batch(
      collected.map((r) =>
        statement.bind(r.day, r.site, r.kind, r.key, r.clicks, r.impressions, r.position, now),
      ),
    );
    rows += collected.length;
  }

  return { provider: "search-console", days: days.length, sites: sites.length, rows, notes };
}

export type SearchTotal = {
  site: string;
  kind: string;
  key: string;
  clicks: number;
  impressions: number;
  position: number;
};

/**
 * Итоги за окно. Позиция усредняется ВЗВЕШЕННО по показам, а не арифметически: запрос с одним
 * показом на 90-м месте иначе утянул бы среднее сайта вниз наравне с запросом, который показали
 * триста раз.
 */
export async function readSearch(
  db: D1Database,
  kind: "query" | "page",
  from: string,
  to: string,
): Promise<SearchTotal[]> {
  const { results } = await db
    .prepare(
      `SELECT site, kind, key,
              SUM(clicks) AS clicks,
              SUM(impressions) AS impressions,
              CASE WHEN SUM(impressions) > 0
                   THEN SUM(position * impressions) / SUM(impressions) ELSE 0 END AS position
         FROM search_daily
        WHERE kind = ? AND day >= ? AND day <= ?
     GROUP BY site, kind, key
     ORDER BY impressions DESC
        LIMIT 60`,
    )
    .bind(kind, from, to)
    .all<SearchTotal>();
  return results;
}
