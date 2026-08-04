/**
 * Фид по страницам для чужой админки: сколько собирает каждая страница одного сайта.
 *
 * Спека — docs/tz-site-feed.md. Здесь только то, что стоит держать рядом с кодом.
 *
 * ЖИВЁТ ВНЕ `/v1/*` НАМЕРЕННО. Там стоит Cloudflare Access, и он отвечает редиректом на логин
 * ДО того, как запрос дойдёт до воркера. Чужой сервер этот логин не пройдёт никогда, поэтому
 * фид получает свой префикс и свой ключ — рядом с `/e` и `/sda.js`, по той же причине.
 *
 * КЛЮЧ ОПРЕДЕЛЯЕТ ИСТОЧНИК. Не параметр запроса: иначе подстановка `?source=superduperai`
 * превращает фид одного сайта в чтение всего портфеля. Параметра `source` в этом файле нет
 * вовсе — не «игнорируется», а отсутствует, и добавить его обратно можно только осознанно.
 */
import { buildPagesQuery, parseBreakdown, RETENTION_DAYS_SAFE, type StatsEnv } from "./stats";
import { readSearch } from "./search/sync";
import { dayBefore, utcDay } from "./stores/schema";

export const FEED_CACHE_SECONDS = 900;

export type FeedEnv = StatsEnv & {
  /** `source:key` через запятую. Ключ на источник — отзыв одного не трогает остальные. */
  FEED_KEYS?: string;
  STORES?: D1Database;
};

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
 * Кому принадлежит ключ. Возвращает id источника или undefined.
 *
 * Сравнение идёт по всей строке ключа, а не по префиксу: ключ, совпавший началом, — это
 * подбор, а не совпадение.
 */
export function sourceForKey(keys: string | undefined, given: string | undefined): string | undefined {
  if (keys === undefined || keys === "" || given === undefined || given === "") return undefined;
  for (const pair of keys.split(",")) {
    const at = pair.indexOf(":");
    if (at < 0) continue;
    const source = pair.slice(0, at).trim();
    const key = pair.slice(at + 1).trim();
    if (key !== "" && key === given) return source;
  }
  return undefined;
}

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
  const window = Math.min(Math.max(1, Math.trunc(days)), RETENTION_DAYS_SAFE);
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

  // Наши просмотры. Запрос общий для всех источников — фильтр здесь, а не в SQL, потому что
  // тот же ответ уже кэшируется для панели, и второй почти такой же запрос стоил бы чтений.
  if (env.CF_ACCOUNT_ID !== undefined && env.CF_API_TOKEN !== undefined) {
    const response = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`,
      {
        method: "POST",
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
        body: buildPagesQuery(env.DATASET, window),
      },
    );
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
      const searchTo = dayBefore(to, 3);
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
