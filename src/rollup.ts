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
import { askSql, buildPagesQuery, buildQuery, parseBreakdown, parseRows, type StatsEnv } from "./stats";
import { dayBefore, utcDay } from "./stores/schema";

/**
 * Сколько страниц архивируется за сутки. Тысяча против шестидесяти на экране: у самого крупного
 * сайта 3758 страниц за год, но в один день столько не читают, а хвост из «одна страница — один
 * просмотр» стоит места и ничего не отвечает.
 */
const PAGE_ARCHIVE_LIMIT = 1000;

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

  // Окно — параметр, а не подмена строки в собранном SQL. Формат дня проверяет buildQuery.
  let sources;
  try {
    const response = await askSql(env, buildQuery(env.DATASET, { day }));
    if (!response.ok) {
      return { day, rows: 0, sources: 0, sampled: false, note: `sql ${response.status}` };
    }
    sources = parseRows(await response.json());
  } catch (error) {
    return { day, rows: 0, sources: 0, sampled: false, note: String(error) };
  }
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

/**
 * Постраничная свёртка того же дня.
 *
 * Отдельно от источников, потому что размерность другая, и отдельным запросом, потому что
 * группировка другая. Нужна ровно для одного: чтобы через девяносто дней остался ответ на
 * вопрос «какая статья собирала трафик в августе», а не только «сколько его было всего».
 */
export async function rollupPages(
  env: StatsEnv & { STORES?: D1Database },
  now: number,
  explicitDay?: string,
): Promise<{ day: string; rows: number; note?: string }> {
  const day = explicitDay ?? dayBefore(utcDay(now), 1);
  if (env.STORES === undefined || env.CF_ACCOUNT_ID === undefined || env.CF_API_TOKEN === undefined) {
    return { day, rows: 0, note: "not configured" };
  }

  // Потолок, а не верхушка: LIMIT по умолчанию 60 — это про экран. В архив должны попасть
  // все страницы всех сайтов за день, иначе тихий сайт исчезает из истории безвозвратно.
  let rows;
  try {
    const response = await askSql(env, buildPagesQuery(env.DATASET, { day }, PAGE_ARCHIVE_LIMIT));
    if (!response.ok) return { day, rows: 0, note: `sql ${response.status}` };
    rows = parseBreakdown(await response.json());
  } catch (error) {
    return { day, rows: 0, note: String(error) };
  }
  if (rows.length === 0) return { day, rows: 0, note: "no pages" };

  const statement = env.STORES.prepare(
    `INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled)
     VALUES (?, ?, 'own', ?, ?, ?, ?)
     ON CONFLICT (day, source, provider, path)
     DO UPDATE SET page_views = excluded.page_views, engaged = excluded.engaged, rolled = excluded.rolled`,
  );
  await env.STORES.batch(
    rows.map((r) => statement.bind(day, r.source, r.key, r.page_views, r.engaged, now)),
  );
  return { day, rows: rows.length };
}

/** Строка архива страниц: чей счётчик, какой день, сколько просмотров. */
export type PageHistoryRow = { day: string; source: string; provider: string; page_views: number };

/**
 * Постраничная история из архива — единственный источник за пределами 90 дней.
 *
 * Свёрнуто по дням и продуктам, а не по страницам: панель отвечает на «сколько читали», а не
 * «что читали», и тысяча строк на день ради суммы — это лишняя работа для D1 и для браузера.
 */
export async function readPageHistory(
  db: D1Database,
  from: string,
  to: string,
): Promise<PageHistoryRow[]> {
  const { results } = await db
    .prepare(
      `SELECT day, source, provider, SUM(page_views) AS page_views
         FROM page_daily
        WHERE day >= ? AND day <= ?
     GROUP BY day, source, provider
     ORDER BY day`,
    )
    .bind(from, to)
    .all<PageHistoryRow>();
  return results;
}

/** Просмотры одной страницы одним счётчиком за окно. */
export type PageTotal = { path: string; provider: string; page_views: number; engaged: number };

/**
 * Постраничные суммы одного продукта из архива.
 *
 * Фильтр по источнику — в SQL, а не после выборки. Тот же урок, что дважды стоил пустых
 * таблиц: LIMIT срезает строки ДО фильтра, и сайт вне общей верхушки получает нули,
 * неотличимые от «его никто не читал».
 */
export async function readPagesForSource(
  db: D1Database,
  source: string,
  from: string,
  to: string,
): Promise<PageTotal[]> {
  const { results } = await db
    .prepare(
      `SELECT path, provider, SUM(page_views) AS page_views, SUM(engaged) AS engaged
         FROM page_daily
        WHERE source = ? AND day >= ? AND day <= ?
     GROUP BY path, provider
     ORDER BY page_views DESC
        LIMIT 400`,
    )
    .bind(source, from, to)
    .all<PageTotal>();
  return results;
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
