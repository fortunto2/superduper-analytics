/**
 * Фид по страницам для чужой админки: сколько собирает каждая страница одного сайта.
 *
 * Спека — docs/tz-site-feed.md. Здесь только то, что стоит держать рядом с кодом.
 *
 * НЕ ОТДАЁТСЯ ПО HTTP ВООБЩЕ. Вызывается через именованную точку входа `Feed` в index.ts,
 * которую видят только воркеры этого аккаунта с явной привязкой. Первая версия была
 * `GET /feed` с ключом на источник: она работала, но требовала от потребителя двух секретов,
 * а от нас — их выдачи, хранения и отзыва. Ничего из этого больше не существует.
 */
import { askSql, buildPagesQuery, parseBreakdown, type StatsEnv } from "./stats";
import { RETENTION_DAYS } from "./schema";
import { LAG_DAYS, readSearch } from "./search/sync";
import { dayBefore, utcDay } from "./stores/schema";

/**
 * Строк из Analytics Engine до фильтра по источнику. Запрос группирует по всем источникам
 * сразу, поэтому предел должен покрывать их все — иначе сайт вне верхушки получает пустой фид.
 */
const FEED_ROW_LIMIT = 1000;

export type FeedEnv = StatsEnv & { STORES?: D1Database };

export type FeedPage = {
  path: string;
  /** Наши: боты исключены, взвешено. */
  page_views: number;
  engaged: number;
  /** Google: показы в выдаче и средняя позиция. НЕ складывать с нашими — разные события. */
  impressions: number;
  clicks: number;
  position: number;
};

/**
 * Один вид пути для склейки.
 *
 * У нас в слоте лежит путь, у Search Console — полный адрес, а у сайтов с markdown-двойниками
 * ещё и `/turkey/slug.md`. Не приведя их к одному виду, одна статья разъезжается на две строки:
 * у одной показы, у другой просмотры, и обе выглядят слабее, чем есть.
 *
 * Хвостовой слэш снимается везде, кроме корня: `/` и `` — разные вещи, а `/about/` и `/about`
 * это одна страница.
 */
export function normalisePath(raw: string): string {
  let path = raw.trim();
  if (path === "") return "";
  // Полный адрес → путь. Хост отбрасывается целиком: www и голый домен это один сайт.
  const schemeAt = path.indexOf("://");
  if (schemeAt >= 0) {
    const slash = path.indexOf("/", schemeAt + 3);
    path = slash < 0 ? "/" : path.slice(slash);
  }
  const cut = path.search(/[?#]/);
  if (cut >= 0) path = path.slice(0, cut);
  if (path.endsWith(".md")) path = path.slice(0, -3);
  if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
  return path === "" ? "/" : path;
}

export type FeedResult = {
  source: string;
  window_days: number;
  from: string;
  to: string;
  pages: FeedPage[];
};

export async function buildFeed(
  env: FeedEnv,
  source: string,
  days: number,
  now: number,
): Promise<FeedResult> {
  const window = Math.min(Math.max(1, Math.trunc(days)), RETENTION_DAYS);
  const to = utcDay(now);
  const result: FeedResult = {
    source,
    window_days: window,
    from: dayBefore(to, window - 1),
    to,
    pages: [],
  };

  const merged = new Map<string, FeedPage>();
  const at = (path: string): FeedPage => {
    const key = normalisePath(path);
    let row = merged.get(key);
    if (row === undefined) {
      row = { path: key, page_views: 0, engaged: 0, impressions: 0, clicks: 0, position: 0 };
      merged.set(key, row);
    }
    return row;
  };

  // Наши просмотры. Предел поднят и строки всё равно фильтруются по источнику — но не после
  // выборки, как было: LIMIT срезает ДО фильтра, и сайт вне глобальной верхушки получал пустой
  // фид, неотличимый от «его никто не читал». Ровно эта ошибка уже была найдена и исправлена
  // в readSearch по D1 — здесь она оставалась в той же функции.
  if (env.CF_ACCOUNT_ID !== undefined && env.CF_API_TOKEN !== undefined) {
    const response = await askSql(env, buildPagesQuery(env.DATASET, window, FEED_ROW_LIMIT));
    if (response.ok) {
      for (const row of parseBreakdown(await response.json())) {
        if (row.source !== source) continue;
        const page = at(row.key);
        page.page_views += row.page_views;
        page.engaged += row.engaged;
      }
    }
  }

  // Google. Окно сдвинуто на три дня: консоль отстаёт, и «за последние N дней считая сегодня»
  // вернуло бы три пустых дня и заниженные показы.
  if (env.STORES !== undefined) {
    try {
      const searchTo = dayBefore(to, LAG_DAYS);
      for (const row of await readSearch(
        env.STORES,
        "page",
        dayBefore(searchTo, window - 1),
        searchTo,
        source,
      )) {
        const page = at(row.key);
        page.impressions += row.impressions;
        page.clicks += row.clicks;
        // Позиция уже взвешена по показам внутри readSearch; строки на один путь здесь
        // складываются редко, и брать лучшую из них честнее, чем усреднять среднее.
        page.position = page.position === 0 ? row.position : Math.min(page.position, row.position);
      }
    } catch {
      // Нет Google — остаются наши колонки. Пустая админка хуже неполной.
    }
  }

  result.pages = [...merged.values()]
    .filter((p) => p.path !== "" && (p.page_views > 0 || p.impressions > 0))
    .sort((a, b) => b.page_views - a.page_views || b.impressions - a.impressions)
    .slice(0, 200);
  return result;
}
