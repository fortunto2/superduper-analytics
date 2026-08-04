/**
 * The daily rollup: yesterday's numbers, copied out of Analytics Engine into D1 before the
 * store forgets them.
 *
 * Analytics Engine deletes after 90 days. The first events here are from late July 2026, so the
 * first day of history disappears around late October — a deadline that arrives whether or not
 * anybody is ready for it, and which the PRD answers with Pipelines into R2 Iceberg, a design
 * that needs Workers Paid.
 *
 * This is the cheap two thirds of that. One row per product per day per metric — about four
 * thousand rows a year — kept in a database that is already here and already free. What it
 * cannot do is answer a question nobody has asked yet: there are no raw events in it, so
 * "which countries in March" is unanswerable once March is gone. The archive fork stays open
 * for exactly that; this closes the part that hurts first.
 *
 * It also makes silence visible. A product that reported yesterday and reports nothing today is
 * the failure mode of this whole project — a counter removed by a redeploy in a repository
 * nobody is watching — and until now the only way to notice was to look.
 */
import { RETENTION_DAYS } from "./schema";
import { buildQuery, parseRows, type StatsEnv } from "./stats";
import { dayBefore, utcDay } from "./stores/schema";

const SQL_ENDPOINT = "https://api.cloudflare.com/client/v4/accounts";

export type RollupResult = {
  day: string;
  rows: number;
  sources: number;
  sampled: boolean;
  note?: string;
};

/**
 * Yesterday, not today: a day still in progress would be written as if it were final and then
 * never corrected, because the primary key would already be taken. UTC throughout — the store's
 * day boundary is UTC and the local clock never enters into it.
 */
export async function rollupDay(
  env: StatsEnv & { STORES?: D1Database },
  now: number,
  explicitDay?: string,
): Promise<RollupResult> {
  const day = explicitDay ?? dayBefore(utcDay(now), 1);
  if (env.STORES === undefined) return { day, rows: 0, sources: 0, sampled: false, note: "no D1" };
  if (env.CF_ACCOUNT_ID === undefined || env.CF_API_TOKEN === undefined) {
    return { day, rows: 0, sources: 0, sampled: false, note: "not configured" };
  }

  // Один день ровно: границы задаются явно, а не «за последние сутки», иначе прогон в 05:00
  // и прогон в 06:00 записали бы разные числа в одну и ту же строку.
  const sql = buildQuery(env.DATASET, RETENTION_DAYS)
    .replace(
      `WHERE timestamp > NOW() - INTERVAL '${RETENTION_DAYS}' DAY`,
      // `toDate(timestamp) = 'YYYY-MM-DD'` — строка справа, но НЕ внутри toDate: эта функция
      // не принимает STRING и отвечает 422. Сравнение timestamp со строкой напрямую тоже
      // отвергается — DateTime и String не комбинируются. Работает ровно одна форма.
      `WHERE toDate(timestamp) = '${day}'`,
    );

  const response = await fetch(`${SQL_ENDPOINT}/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
    body: sql,
  });
  if (!response.ok) {
    return { day, rows: 0, sources: 0, sampled: false, note: `sql ${response.status}` };
  }

  const sources = parseRows(await response.json());
  if (sources.length === 0) return { day, rows: 0, sources: 0, sampled: false, note: "no events" };

  const sampled = sources.some((r) => r.max_sample > 1);
  const statement = env.STORES.prepare(
    `INSERT INTO own_daily (day, source, platform, metric, value, sampled, rolled)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, source, platform, metric)
     DO UPDATE SET value = excluded.value, sampled = excluded.sampled, rolled = excluded.rolled`,
  );

  // UPSERT, а не вставка: сутки перезаписываются, если прогон повторили. Analytics Engine
  // досчитывает поздние строки, и вчерашнее число, прочитанное в 05:00, не окончательное.
  const binds = sources.flatMap((row) =>
    (
      [
        ["people", row.people_seen],
        ["page_views", row.page_views],
        ["engaged", row.engaged],
        ["bot_events", row.bot_events],
        ["events", row.events],
      ] as const
    ).map(([metric, value]) =>
      statement.bind(day, row.source, row.platform, metric, value, sampled ? 1 : 0, now),
    ),
  );
  await env.STORES.batch(binds);

  return { day, rows: binds.length, sources: sources.length, sampled };
}

export type OwnDaily = { day: string; source: string; platform: string; value: number };

/** История одной метрики по продуктам. Отвечает и за пределами 90 дней — в этом весь смысл. */
export async function readOwnHistory(
  db: D1Database,
  metric: string,
  from: string,
  to: string,
): Promise<OwnDaily[]> {
  const { results } = await db
    .prepare(
      `SELECT day, source, platform, value
         FROM own_daily
        WHERE metric = ? AND day >= ? AND day <= ?
     ORDER BY day, source`,
    )
    .bind(metric, from, to)
    .all<OwnDaily>();
  return results;
}

/**
 * Кто замолчал: отчитывался в предыдущие дни и не отчитался вчера.
 *
 * Это главный отказ этого проекта — счётчик, снесённый передеплоем в чужом репозитории, — и
 * до сих пор единственным способом его заметить было посмотреть. Порог в два дня подряд, а не
 * один: у сайта с тремя посетителями в неделю пустой вторник это вторник, а не поломка.
 */
export async function findSilent(
  db: D1Database,
  day: string,
): Promise<{ source: string; last_seen: string }[]> {
  const { results } = await db
    .prepare(
      `SELECT source, MAX(day) AS last_seen
         FROM own_daily
        WHERE metric = 'page_views' AND value > 0 AND day >= ? AND day <= ?
     GROUP BY source
       HAVING last_seen <= ?`,
    )
    .bind(dayBefore(day, 14), day, dayBefore(day, 2))
    .all<{ source: string; last_seen: string }>();
  return results;
}
