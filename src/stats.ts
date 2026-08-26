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
import { METRIC_SLOTS, metricSlot } from "./registry";
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
   * Distinct anonymous ids among non-bot rows.
   *
   * READ THIS AS PEOPLE ONLY WHEN THE WINDOW IS ONE DAY. On the web `anon` is derived at the
   * edge and rotates at midnight UTC (`src/anon.ts`), so the same person visiting on three days
   * contributes three ids. Over a 28-day window this is people-DAYS, and calling it people
   * overstates by however often people come back — the one thing it cannot measure.
   *
   * It is also a LOWER BOUND: Analytics Engine samples, and a sampled-away row takes its `anon`
   * with it, so no weighting recovers it. `max_sample` says when to distrust it. Two errors in
   * opposite directions, neither of known size, which is why the honest questions moved out:
   * app returns to `src/retention.ts`, page quality to `src/conversion.ts`.
   *
   * Still the better figure than Cloudflare's edge uniques, which do not lose rows to sampling
   * but do count every scraper. A bot-filtered undercount beats an unfiltered overcount —
   * measured on life2film, the edge said 20k and the truth was 2.
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
  /** Окно длиннее срока хранения событий: числа ниже пусты не от сбоя, а по устройству. */
  beyond_retention?: boolean;
  /** Empty until something is tagged — which is the normal state before the first campaign. */
  campaigns?: CampaignTotal[];
  /** Откуда пришли — хосты рефереров. Прямые заходы не в счёт: у них реферера нет. */
  referrers?: Breakdown[];
  /** Что читали — пути. */
  pages?: Breakdown[];
  /** Откуда географически — страна с края. */
  countries?: Breakdown[];
  /** Цели: всё, что не просмотр страницы. То, ради чего сайт существует. */
  goals?: Goal[];
  window_days: number;
  /** Always true, and stated in the payload so a consumer cannot forget what these are. */
  sampled: true;
  total_events: number;
  total_bot_events: number;
  /** Non-bot page views, and the distinct non-bot ids behind them. */
  total_page_views: number;
  total_engaged: number;
  /**
   * Сумма `people_seen` по продуктам — и потому НЕ число людей, а человеко-дни.
   *
   * Складываются две разные вещи. Идентификатор на вебе живёт одни сутки, так что один человек
   * за месяц даёт до тридцати записей. И один человек, зашедший на два наших сайта, даёт две:
   * `anon` не сшивается между свойствами — именно этого свойства от него и добивались.
   *
   * Имя `total_people` было снято намеренно: под ним число читалось как аудитория и в этом
   * качестве было завышено ровно настолько, насколько люди возвращаются. Сколько людей и
   * возвращаются ли они — вопрос `src/retention.ts`, и там на него отвечают только приложения,
   * где идентификатор живёт дольше суток.
   */
  people_days: number;
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
/**
 * Окно запроса: либо последние N суток, либо ровно один день.
 *
 * Один день нужен свёртке. Раньше она получала его подменой строки в уже собранном SQL — и это
 * держалось на том, что текст WHERE в этом файле никто не переформатирует. Переформатировал бы —
 * `.replace()` стал бы пустой операцией, фильтр остался бы 90-дневным, и свёртка записала бы
 * квартал трафика в строку одного дня. Молча, потому что UPSERT.
 *
 * `day` проверяется формой: в SQL он попадает как литерал, и `?day=` из ручного запуска доходит
 * сюда без другой проверки.
 */
export type Window = { days: number } | { day: string };

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

function whereWindow(window: Window): string {
  if ("day" in window) {
    if (!DAY_RE.test(window.day)) throw new Error(`day must be YYYY-MM-DD, got ${window.day}`);
    // toDate(timestamp) = 'YYYY-MM-DD' — единственная форма, которую принимает этот диалект:
    // toDate() не берёт STRING, а timestamp не сравнивается со строкой напрямую.
    return `WHERE toDate(timestamp) = '${window.day}'`;
  }
  if (!Number.isInteger(window.days) || window.days < 1 || window.days > RETENTION_DAYS) {
    throw new Error(`days must be an integer in 1..${RETENTION_DAYS}, got ${String(window.days)}`);
  }
  return `WHERE timestamp > NOW() - INTERVAL '${window.days}' DAY`;
}

export function buildQuery(dataset: string, window: Window | number): string {
  const w: Window = typeof window === "number" ? { days: window } : window;
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
    whereWindow(w),
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

/** Одна строка «откуда пришли» или «что читали» — форма у обоих вопросов одна. */
export type Breakdown = { source: string; key: string; page_views: number; engaged: number };

/**
 * Откуда пришли: хост реферера, боты исключены.
 *
 * Хост, а не полная ссылка — так решено в ingest и это не изменится: полный реферер несёт
 * поисковые запросы и токены из чужих адресных строк. «google.com» отвечает на вопрос, ради
 * которого сюда смотрят, и не приносит с собой ничего лишнего.
 *
 * Прямые заходы сюда не попадают: у них реферера нет, и строка с пустым ключом означала бы
 * «источник неизвестен», а не «источника не было».
 */
export function buildReferrerQuery(dataset: string, window: Window | number, limit?: number): string {
  return breakdown(dataset, window, "blob5", "AND blob5 != ''", limit);
}

/**
 * Откуда географически: страна с края, из `request.cf`, а не со слов клиента.
 *
 * Страна, а не город и не координаты. Город сузил бы круг до опознаваемого на сайте с тридцатью
 * посетителями в неделю, и это ровно та граница, за которой счётчик перестаёт быть анонимным.
 */
export function buildCountryQuery(dataset: string, window: Window | number, limit?: number): string {
  return breakdown(dataset, window, "blob6", "AND blob6 != ''", limit);
}

/** Что читали: путь без строки запроса — её срезает ingest, и в слот она не попадает. */
export function buildPagesQuery(dataset: string, window: Window | number, limit?: number): string {
  return breakdown(dataset, window, "blob4", "AND blob4 != ''", limit);
}

function breakdown(
  dataset: string,
  window: Window | number,
  column: string,
  extra: string,
  /**
   * Сколько строк вернуть. Шестьдесят — для панели: там это верхушка по всему аккаунту, и
   * больше на экране не нужно. Свёртке в архив нужен ПОТОЛОК, а не верхушка: с LIMIT 60 тихие
   * сайты перестают попадать в архив вовсе, а Analytics Engine через 90 дней стирает исходник,
   * и потеря невосстановима.
   */
  limit = 60,
): string {
  const w: Window = typeof window === "number" ? { days: window } : window;
  return [
    "SELECT",
    "  blob1 AS source,",
    `  ${column} AS key,`,
    "  sum(if(blob3 = 'page_viewed', _sample_interval, 0)) AS page_views,",
    "  sum(if(blob3 = 'page_engaged', _sample_interval, 0)) AS engaged",
    `FROM ${dataset}`,
    `${whereWindow(w)} AND blob9 != 'bot' ${extra}`,
    "GROUP BY source, key",
    "ORDER BY page_views DESC",
    `LIMIT ${limit}`,
    "FORMAT JSON",
  ].join("\n");
}

export function parseBreakdown(payload: unknown): Breakdown[] {
  const rows = (payload as { data?: Record<string, unknown>[] } | null)?.data;
  if (!Array.isArray(rows)) return [];
  return rows
    .map((row) => ({
      source: String(row.source ?? ""),
      key: String(row.key ?? ""),
      page_views: Number(row.page_views ?? 0),
      engaged: Number(row.engaged ?? 0),
    }))
    .filter((row) => row.page_views > 0 || row.engaged > 0);
}

/** Одна цель: событие, которое не просмотр страницы. */
export type Goal = { source: string; name: string; placement: string; count: number };

/**
 * Цели — всё, что не `page_viewed` и не `page_engaged`.
 *
 * Отдельный список, а не строка в общей таблице: просмотр это фон, а цель — то, ради чего сайт
 * существует. Скачать бинарник, уйти в магазин, начать регистрацию. Их единицы против сотен
 * просмотров, и в общей сортировке они не видны никогда.
 *
 * `placement` берётся из СЛОТА, а не из props: у SQL Analytics Engine нет функций для JSON, и
 * без слота «какая кнопка работает» — вопрос без ответа.
 */
export function buildGoalsQuery(dataset: string, days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) {
    throw new Error(`days must be an integer in 1..${RETENTION_DAYS}, got ${String(days)}`);
  }
  return [
    "SELECT",
    "  blob1 AS source,",
    "  blob3 AS name,",
    "  blob15 AS placement,",
    "  sum(_sample_interval) AS count",
    `FROM ${dataset}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY`,
    "  AND blob9 != 'bot'",
    "  AND blob3 != 'page_viewed' AND blob3 != 'page_engaged'",
    "GROUP BY source, name, placement",
    "ORDER BY count DESC",
    "LIMIT 40",
    "FORMAT JSON",
  ].join("\n");
}

export function parseGoals(payload: unknown): Goal[] {
  const rows = (payload as { data?: Record<string, unknown>[] } | null)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    source: String(row.source ?? ""),
    name: String(row.name ?? ""),
    placement: String(row.placement ?? ""),
    count: Number(row.count ?? 0),
  }));
}

/**
 * Один вызов SQL API на всех. Раньше эта пара строк жила в четырёх местах, и обработка ошибок
 * успела разойтись: одна возвращала текст ответа, другая код, третья молча отдавала ноль строк
 * как «страницу никто не читал».
 */
export function askSql(env: StatsEnv, sql: string): Promise<Response> {
  return fetch(`${SQL_ENDPOINT}/${env.CF_ACCOUNT_ID ?? ""}/analytics_engine/sql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN ?? ""}` },
    body: sql,
  });
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
    // Раньше здесь был отказ, и он был прав, пока архива не существовало. Теперь архив есть, и
    // отказ означал бы «за год ничего нет» вместо «за год есть архив, а событий нет».
    // Возвращаем пустой набор с честным флагом: панель истории читает D1 и рисует своё,
    // остальные панели показывают пусто и говорят почему.
    return {
      ok: true,
      stats: {
        window_days: days,
        sampled: true,
        beyond_retention: true,
        total_events: 0,
        total_bot_events: 0,
        total_page_views: 0,
        total_engaged: 0,
        people_days: 0,
        sampling_active: false,
        sources: [],
        daily: [],
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

  const ask = (sql: string) => askSql(env, sql);

  // СЕМЬ запросов на один обзор, и это не бесплатно: чтения метрятся, 10k в сутки на free.
  // Арифметика: 10000 / 7 ≈ 1430 расчётов в сутки, то есть один раз в минуту непрерывно.
  // Поэтому кэш обзора поднят до двух минут — открытая на втором мониторе панель иначе съедала
  // бы бюджет на числе, которое не изменилось.
  const [totals, daily, campaigns, referrers, pages, countries, goals] = await Promise.all([
    ask(buildQuery(env.DATASET, days)),
    ask(buildDailyQuery(env.DATASET, days)),
    ask(buildCampaignQuery(env.DATASET, days)),
    ask(buildReferrerQuery(env.DATASET, days)),
    ask(buildPagesQuery(env.DATASET, days)),
    ask(buildCountryQuery(env.DATASET, days)),
    ask(buildGoalsQuery(env.DATASET, days)),
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
      // Складывается сознательно и называется тем, чем является: см. `people_days` выше.
      people_days: sources.reduce((sum, row) => sum + row.people_seen, 0),
      sampling_active: sources.some((row) => row.max_sample > 1),
      sources,
      // The trend is decoration next to the totals: if it fails, show the numbers anyway.
      daily: daily.ok ? parseDays(await daily.json()) : [],
      campaigns: campaigns.ok ? parseCampaigns(await campaigns.json()) : [],
      referrers: referrers.ok ? parseBreakdown(await referrers.json()) : [],
      pages: pages.ok ? parseBreakdown(await pages.json()) : [],
      countries: countries.ok ? parseBreakdown(await countries.json()) : [],
      goals: goals.ok ? parseGoals(await goals.json()) : [],
    },
  };
}

/**
 * Одна числовая размерность в разрезе продукта и события.
 *
 * `avg` взвешено через `_sample_interval`, как всё в этом файле. Невзвешенное среднее по
 * сэмплированным строкам смещено ровно настолько, насколько неравномерно сэмплирование, и
 * ошибка не видна: число выглядит правдоподобным.
 */
export type MetricTotal = {
  source: string;
  /** Имя события. Метрика без него бессмысленна: `film_seconds` на рендере и на превью — разное. */
  event: string;
  /** Событий с этим ключом, взвешенно. */
  events: number;
  avg: number;
  min: number;
  max: number;
  /** Сумма значений. Осмысленна для счётных величин и бессмысленна для долей — знать это должен читатель. */
  total: number;
};

export type Metric = { name: string; slot: number; window_days: number; rows: MetricTotal[] };

/**
 * Агрегат по одной метрике из реестра.
 *
 * Имя приходит снаружи и попадает в SQL, поэтому оно НЕ подставляется, а ищется в списке слотов:
 * в запрос уезжает найденная позиция (число) и то же имя, уже доказавшее, что оно из реестра.
 * Строки, где ключа не было, отсекаются по blob11 — иначе ноль «не прислали» смешался бы с
 * нулём «прислали ноль» и утянул бы среднее. JSON здесь читается как строка, что диалект умеет,
 * а не как JSON, чего он не умеет.
 */
export function buildMetricQuery(dataset: string, name: string, days: number): string {
  const slot = metricSlot(name);
  if (slot === undefined) {
    throw new Error(`"${name}" has no double slot — add it to registry/sources.yaml and run make gen`);
  }
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) {
    throw new Error(`days must be an integer in 1..${RETENTION_DAYS}, got ${String(days)}`);
  }
  const column = `double${slot}`;
  return [
    "SELECT",
    "  blob1 AS source,",
    "  blob3 AS event,",
    "  sum(_sample_interval) AS events,",
    `  sum(${column} * _sample_interval) / sum(_sample_interval) AS avg,`,
    `  min(${column}) AS lo,`,
    `  max(${column}) AS hi,`,
    `  sum(${column} * _sample_interval) AS total`,
    `FROM ${dataset}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY`,
    "  AND blob9 != 'bot'",
    `  AND blob11 LIKE '%"${name}"%'`,
    "GROUP BY source, event",
    "ORDER BY events DESC",
    "LIMIT 60",
    "FORMAT JSON",
  ].join("\n");
}

export function parseMetric(payload: unknown): MetricTotal[] {
  const rows = (payload as { data?: Record<string, unknown>[] } | null)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    source: String(row.source ?? ""),
    event: String(row.event ?? ""),
    events: Number(row.events ?? 0),
    avg: Number(row.avg ?? 0),
    min: Number(row.lo ?? 0),
    max: Number(row.hi ?? 0),
    total: Number(row.total ?? 0),
  }));
}

export async function fetchMetric(
  env: StatsEnv,
  name: string,
  days: number,
): Promise<{ ok: true; metric: Metric } | ({ ok: false } & StatsFailure)> {
  const slot = metricSlot(name);
  if (slot === undefined) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "no_slot",
        message: `"${name}" has no double slot; aggregating it is not possible in the hot store`,
        // Список отдаётся в ответе: вопрос «а какие есть» возникает ровно здесь, и отправлять
        // за ним в YAML на GitHub — лишний круг для того, кто уже держит ответ в руках.
        available: [...METRIC_SLOTS],
      },
    };
  }
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) {
    return { ok: false, status: 400, body: { error: "bad_window", message: "days must be a positive integer" } };
  }
  if (env.CF_ACCOUNT_ID === undefined || env.CF_API_TOKEN === undefined) {
    return { ok: false, status: 500, body: { error: "not_configured", message: "CF_ACCOUNT_ID and CF_API_TOKEN are unset" } };
  }

  const response = await askSql(env, buildMetricQuery(env.DATASET, name, days));
  if (!response.ok) {
    return { ok: false, status: 502, body: { error: "sql_api_failed", status: response.status, detail: await response.text() } };
  }
  return { ok: true, metric: { name, slot, window_days: days, rows: parseMetric(await response.json()) } };
}
