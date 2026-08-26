/**
 * Сеть: кто кого кормит. Переходы между нашими же продуктами.
 *
 * Вопрос звучит как «сколько человек пришло с miralinka на carettafriends», и на него уже
 * несколько месяцев есть ответ — просто его никто не задавал. `referrer_host` пишется с первого
 * дня (blob5), а список наших хостов лежит в реестре; всё, чего не хватало, — соединить одно с
 * другим. Никаких новых полей, никакого кода на сайтах.
 *
 * ДВА РОДА РЁБЕР, и складывать их нельзя.
 *
 *   1. Сайт → сайт. Браузер сам присылает `Referer`, мы оставляем от него хост. Это факт: этот
 *      просмотр случился после клика вон оттуда.
 *   2. Сайт → магазин. Наше событие `app_store_opened` / `play_store_opened`: человек нажал
 *      кнопку установки. Это НАМЕРЕНИЕ, а не установка — поставил ли он приложение, знает
 *      только Apple, и знает по своему `ct`-токену (`docs/tz-funnel-and-mobile.md`).
 *
 * Первое считает браузер, второе — мы, а третье звено (установку) считает магазин. Три разные
 * стороны, поэтому цепочка читается по звеньям, а не суммой.
 *
 * ЧЕГО ЗДЕСЬ НЕ БУДЕТ. Перехода «приложение → приложение» не видно и не будет: у приложения нет
 * реферера, а связать запуск одного с кликом в другом можно только сквозным идентификатором —
 * ровно тем, которого в этом проекте нет намеренно. Мост между продуктами всегда проходит через
 * магазин, и меряется он на своих концах: клик у нас, установка у Apple по токену кампании.
 */
import { SITES } from "./registry.generated";
import { RETENTION_DAYS } from "./schema";
import { askSql, type StatsEnv } from "./stats";

/** Ребро графа: откуда, куда и сколько. */
export type Edge = { from: string; to: string; views: number };

/** Клик в магазин: с какого продукта, куда и откуда на странице. */
export type StoreClick = { source: string; store: string; placement: string; clicks: number };

export type Network = {
  window_days: number;
  /** Переходы между нашими сайтами, по убыванию. */
  edges: Edge[];
  /** Клики по кнопкам установки. Намерение, не установка. */
  store_clicks: StoreClick[];
  /** Хостов в реестре, по которым узнаются свои. Для читателя, который увидит пустой список. */
  known_hosts: number;
};

export type NetworkFailure = { status: 400 | 500 | 502; body: { error: string } & Record<string, unknown> };

/** `www.` — деталь хостинга, которая меняется без ведома аналитики. */
function bare(host: string): string {
  const lower = host.toLowerCase();
  return lower.startsWith("www.") ? lower.slice(4) : lower;
}

/** Хост → id продукта. Строится из реестра, поэтому новый сайт попадает в граф сам. */
export function hostIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const site of SITES) index.set(bare(site.host), site.id);
  return index;
}

export function buildReferrerQuery(dataset: string, days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) {
    throw new Error(`days must be an integer in 1..${RETENTION_DAYS}, got ${String(days)}`);
  }
  return [
    "SELECT",
    "  blob1 AS target,",
    "  blob5 AS ref,",
    "  sum(_sample_interval) AS views",
    `FROM ${dataset}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY`,
    "  AND blob9 != 'bot'",
    "  AND blob2 = 'web'",
    "  AND blob5 != ''",
    "  AND blob3 = 'page_viewed'",
    "GROUP BY target, ref",
    "ORDER BY views DESC",
    // Своих в этом списке единицы против сотен поисковых, поэтому потолок высокий: обрезать
    // хвост здесь значит потерять как раз редкие внутренние переходы, ради которых всё и есть.
    "LIMIT 500",
    "FORMAT JSON",
  ].join("\n");
}

export function buildStoreClickQuery(dataset: string, days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) {
    throw new Error(`days must be an integer in 1..${RETENTION_DAYS}, got ${String(days)}`);
  }
  return [
    "SELECT",
    "  blob1 AS source,",
    "  blob3 AS name,",
    "  blob15 AS placement,",
    "  sum(_sample_interval) AS clicks",
    `FROM ${dataset}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY`,
    "  AND blob9 != 'bot'",
    "  AND (blob3 = 'app_store_opened' OR blob3 = 'play_store_opened')",
    "GROUP BY source, name, placement",
    "ORDER BY clicks DESC",
    "LIMIT 60",
    "FORMAT JSON",
  ].join("\n");
}

type SqlRows = { data?: Record<string, unknown>[] };

/**
 * Оставить только свои рёбра.
 *
 * Внешние источники отбрасываются здесь, а не в SQL: список хостов пришлось бы вписывать в
 * запрос, и он молча разъезжался бы с реестром при каждом новом сайте. Пятьсот строк отфильтровать
 * в памяти дешевле, чем держать две правды о том, кто мы такие.
 */
export function parseEdges(payload: unknown, index = hostIndex()): Edge[] {
  const rows = (payload as SqlRows | null)?.data;
  if (!Array.isArray(rows)) return [];
  const edges: Edge[] = [];
  for (const row of rows) {
    const from = index.get(bare(String(row.ref ?? "")));
    const to = String(row.target ?? "");
    if (from === undefined || to === "") continue;
    // Переход внутри одного продукта — это навигация по его же страницам, а не переток между
    // продуктами. Ребро из вершины в себя же засоряет граф и ни на что не отвечает.
    if (from === to) continue;
    edges.push({ from, to, views: Number(row.views ?? 0) });
  }
  return edges.sort((a, b) => b.views - a.views);
}

export function parseStoreClicks(payload: unknown): StoreClick[] {
  const rows = (payload as SqlRows | null)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    source: String(row.source ?? ""),
    store: String(row.name ?? "") === "play_store_opened" ? "play" : "appstore",
    placement: String(row.placement ?? ""),
    clicks: Number(row.clicks ?? 0),
  }));
}

export async function fetchNetwork(
  env: StatsEnv,
  days: number,
): Promise<{ ok: true; network: Network } | ({ ok: false } & NetworkFailure)> {
  if (!Number.isInteger(days) || days < 1) {
    return { ok: false, status: 400, body: { error: "bad_window", message: "days must be a positive integer" } };
  }
  if (days > RETENTION_DAYS) {
    return {
      ok: false,
      status: 400,
      body: { error: "beyond_retention", message: `the hot store keeps ${RETENTION_DAYS} days` },
    };
  }
  if (env.CF_ACCOUNT_ID === undefined || env.CF_API_TOKEN === undefined) {
    return { ok: false, status: 500, body: { error: "not_configured", message: "CF_ACCOUNT_ID and CF_API_TOKEN are unset" } };
  }

  const [referrers, clicks] = await Promise.all([
    askSql(env, buildReferrerQuery(env.DATASET, days)),
    askSql(env, buildStoreClickQuery(env.DATASET, days)),
  ]);
  if (!referrers.ok) {
    return { ok: false, status: 502, body: { error: "sql_api_failed", status: referrers.status, detail: await referrers.text() } };
  }

  return {
    ok: true,
    network: {
      window_days: days,
      edges: parseEdges(await referrers.json()),
      // Клики — приложение к графу: если этот запрос упал, граф всё равно стоит показать.
      store_clicks: clicks.ok ? parseStoreClicks(await clicks.json()) : [],
      known_hosts: hostIndex().size,
    },
  };
}
