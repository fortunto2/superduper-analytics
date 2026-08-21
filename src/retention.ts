/**
 * Возвраты в приложениях — единственное место в этом проекте, где «сколько людей» имеет смысл.
 *
 * На вебе `anon` выводится на краю и меняется в полночь UTC (`src/anon.ts`), поэтому один
 * человек за неделю — это до семи разных идентификаторов, и вопрос «вернулся ли он» там не
 * просто трудный, а бессмысленный: возврата не видно by design, и так и должно остаться.
 *
 * В приложении `anon` — install-scoped UUID: сгенерирован при первом запуске, живёт до удаления
 * приложения, не привязан ни к аккаунту, ни к устройству, ни к рекламному идентификатору
 * (`docs/tz-funnel-and-mobile.md`). Он стабилен во времени, и это единственное отличие, которое
 * делает возвраты измеримыми, не добавляя ни одного нового поля и не трогая декларацию Apple.
 *
 * Отсюда жёсткое правило файла: **`platform = web` сюда не попадает никогда.** Не «пока не
 * поддерживается» — а не попадает, потому что число получилось бы похожим на ретеншен и им бы
 * не было. Фильтр стоит в SQL, а не в разборе, чтобы веб-строки не доехали даже до памяти.
 *
 * Второе правило — про честность знаменателя. Установка, впервые увиденная вчера, ФИЗИЧЕСКИ не
 * могла вернуться на другой день, и её место в знаменателе занижает долю возвратов ровно тем
 * сильнее, чем быстрее продукт растёт. Такие установки считаются отдельно (`too_new`) и в долю
 * не входят. Это то, чем честная метрика отличается от той, что красиво падает на релизе.
 */
import { RETENTION_DAYS } from "./schema";
import { askSql, type StatsEnv } from "./stats";

/**
 * Сколько суток установка должна прожить, прежде чем её можно спрашивать «вернулась ли».
 *
 * Два: первый день — сам факт установки, второй — первая возможность вернуться. Меньше нельзя
 * (тогда знаменатель включает тех, у кого шанса не было), больше — значит выбросить свежие
 * установки, которых у маленького продукта большинство.
 */
export const MATURITY_DAYS = 2;

/** Активна «сейчас» — событие за последние столько суток. Неделя: короче шумит на выходных. */
export const ACTIVE_WINDOW_DAYS = 7;

/**
 * Потолок строк: одна строка на установку. При нынешних объёмах (десятки) это с запасом, а
 * когда упрёмся — `truncated` скажет об этом вслух, вместо того чтобы молча показать долю,
 * посчитанную по случайной половине установок.
 */
export const MAX_INSTALLS = 10000;

/** Одна установка: во сколько разных суток была активна и когда её видели впервые и в последний раз. */
export type InstallRow = {
  source: string;
  platform: string;
  /** Install-scoped UUID. Наружу не отдаётся — по нему только считают, его не показывают. */
  anon: string;
  /** Число РАЗНЫХ суток с событиями. Ровно 1 — установка не вернулась ни разу. */
  days_active: number;
  /** YYYY-MM-DD, UTC. */
  first_day: string;
  last_day: string;
  events: number;
  max_sample: number;
};

export type RetentionRow = {
  source: string;
  platform: string;
  /**
   * Установок, приславших хотя бы одно событие в окне. Точнее — устройств, впервые
   * ОТЧИТАВШИХСЯ: идентификатор рождается при первом запуске версии со счётчиком, а не при
   * скачивании. Замерено на life2film 2026-08-21: 43 «установки», из них 41 на версии 1.2,
   * и все первые события с 18 августа — то есть это раскатка обновления, а не сорок три
   * новых пользователя. Сколько скачиваний было на самом деле, знает Apple (`src/stores/`),
   * и эти два числа никогда не складываются.
   */
  installs: number;
  /**
   * Первый день, в который в этой группе вообще что-то отчиталось. Если он внутри окна —
   * счётчик здесь моложе вопроса, и доля возвратов посчитана по тем немногим, кто успел.
   */
  first_report_day: string;
  /**
   * Из них зрелых — тех, кто прожил `MATURITY_DAYS` и мог вернуться. Знаменатель доли.
   */
  mature: number;
  /** Зрелых установок, у которых события были больше чем в один день. */
  returned: number;
  /** `returned / mature`, 0..1. `null`, когда зрелых нет — доля от нуля не бывает. */
  return_rate: number | null;
  /** Установок, впервые увиденных в окне слишком недавно, чтобы спрашивать про возврат. */
  too_new: number;
  /** Активных за последнюю неделю окна. Отвечает «продукт жив сейчас», а не «был когда-то». */
  active_now: number;
  /** Событий на установку. Десять запусков на установку и два — это два разных продукта. */
  events_per_install: number;
  /** Медиана `days_active` среди зрелых. Устойчивее среднего на десятках установок. */
  median_days_active: number;
  events: number;
  /** >1 — установок было больше: сэмплирование уносит строку вместе с её идентификатором. */
  max_sample: number;
};

export type Retention = {
  window_days: number;
  /**
   * Самый ранний день, в который вообще есть мобильные события. Без него «за 28 дней» врёт на
   * продукте, где счётчик включили четыре дня назад: доля возвратов там честная, а слово
   * «месяц» рядом с ней — нет.
   */
  first_day_seen?: string;
  /** Уперлись в `MAX_INSTALLS`: доли посчитаны по срезу и занижены неизвестно насколько. */
  truncated: boolean;
  rows: RetentionRow[];
};

export type RetentionFailure = { status: 400 | 500 | 502; body: { error: string } & Record<string, unknown> };

/**
 * Одна строка на установку, агрегация — в TypeScript.
 *
 * Диалект умеет `count(DISTINCT …)`, `min`/`max` по `toDate(timestamp)` — проверено на живом
 * API. Чего он не даёт дёшево, так это агрегата над агрегатом («доля тех, у кого дней > 1»):
 * это подзапрос, а подзапрос здесь — гадание о диалекте, которое сломается молча. Установок
 * десятки, так что вторая агрегация в памяти стоит ничего и читается глазами.
 *
 * `_sample_interval` НЕ взвешивает число установок и не может: взвешивание восстанавливает
 * сумму, а не множество, и выброшенная строка уносит свой идентификатор насовсем. Поэтому
 * `installs` — нижняя граница, а `max_sample` едет рядом, чтобы сказать, когда ей не верить.
 * На мобильных объёмах он пока равен единице.
 */
export function buildRetentionQuery(dataset: string, days: number): string {
  if (!Number.isInteger(days) || days < 1 || days > RETENTION_DAYS) {
    throw new Error(`days must be an integer in 1..${RETENTION_DAYS}, got ${String(days)}`);
  }
  return [
    "SELECT",
    "  blob1 AS source,",
    "  blob2 AS platform,",
    "  blob8 AS anon,",
    "  count(DISTINCT toDate(timestamp)) AS days_active,",
    "  min(toDate(timestamp)) AS first_day,",
    "  max(toDate(timestamp)) AS last_day,",
    "  sum(_sample_interval) AS events,",
    "  max(_sample_interval) AS smpl",
    `FROM ${dataset}`,
    `WHERE timestamp > NOW() - INTERVAL '${days}' DAY`,
    // Веб отрезан здесь, а не при разборе: идентификатор, живущий одни сутки, не должен
    // доехать даже до памяти — иначе однажды кто-нибудь уберёт фильтр «на время отладки».
    "  AND blob2 != 'web'",
    // Пустой anon — приложение старой версии, ещё не научившееся его слать. Считать его за
    // одну общую установку значило бы склеить всех пользователей в одного очень лояльного.
    "  AND blob8 != ''",
    "  AND blob9 != 'bot'",
    "GROUP BY source, platform, anon",
    "ORDER BY events DESC",
    `LIMIT ${MAX_INSTALLS}`,
    "FORMAT JSON",
  ].join("\n");
}

type SqlResponse = { data?: Record<string, unknown>[] };

/** Диалект отдаёт агрегаты строками достаточно часто, чтобы приведение не было опциональным. */
export function parseInstalls(payload: unknown): InstallRow[] {
  const rows = (payload as SqlResponse | null)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((row) => ({
    source: String(row.source ?? ""),
    platform: String(row.platform ?? ""),
    anon: String(row.anon ?? ""),
    days_active: Number(row.days_active ?? 0),
    first_day: String(row.first_day ?? ""),
    last_day: String(row.last_day ?? ""),
    events: Number(row.events ?? 0),
    max_sample: Number(row.smpl ?? 1),
  }));
}

/** YYYY-MM-DD в UTC, ровно как `toDate(timestamp)` на той стороне. */
function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const middle = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return middle;
  return ((sorted[mid - 1] ?? 0) + middle) / 2;
}

/**
 * Свести установки в строку на продукт.
 *
 * `now` приходит параметром, а не из часов: зрелость установки — это арифметика над датами, и
 * тест обязан уметь её проверить, не двигая системное время.
 */
export function summarize(installs: InstallRow[], now: number): RetentionRow[] {
  const cutoff = utcDay(now - MATURITY_DAYS * 86_400_000);
  const activeFrom = utcDay(now - ACTIVE_WINDOW_DAYS * 86_400_000);

  const groups = new Map<string, InstallRow[]>();
  for (const row of installs) {
    const key = `${row.source} ${row.platform}`;
    const bucket = groups.get(key);
    if (bucket === undefined) groups.set(key, [row]);
    else bucket.push(row);
  }

  const out: RetentionRow[] = [];
  for (const [key, rows] of groups) {
    const [source = "", platform = ""] = key.split(" ");
    // Зрелая — та, чей первый день не позже границы: у неё была хотя бы одна возможность вернуться.
    const mature = rows.filter((r) => r.first_day <= cutoff);
    const returned = mature.filter((r) => r.days_active > 1);
    const events = rows.reduce((sum, r) => sum + r.events, 0);
    const firstDays = rows.map((r) => r.first_day).filter((d) => d !== "");
    out.push({
      source,
      platform,
      installs: rows.length,
      first_report_day: firstDays.length > 0 ? firstDays.reduce((a, b) => (a < b ? a : b)) : "",
      mature: mature.length,
      returned: returned.length,
      return_rate: mature.length > 0 ? returned.length / mature.length : null,
      too_new: rows.length - mature.length,
      active_now: rows.filter((r) => r.last_day >= activeFrom).length,
      events_per_install: rows.length > 0 ? events / rows.length : 0,
      median_days_active: median(mature.map((r) => r.days_active)),
      events,
      max_sample: rows.reduce((max, r) => Math.max(max, r.max_sample), 1),
    });
  }
  // Сортировка по числу установок: сверху то, где чисел достаточно, чтобы доля что-то значила.
  return out.sort((a, b) => b.installs - a.installs);
}

export async function fetchRetention(
  env: StatsEnv,
  days: number,
  now: number,
): Promise<{ ok: true; retention: Retention } | ({ ok: false } & RetentionFailure)> {
  if (!Number.isInteger(days) || days < 1) {
    return { ok: false, status: 400, body: { error: "bad_window", message: "days must be a positive integer" } };
  }
  if (days > RETENTION_DAYS) {
    return {
      ok: false,
      status: 400,
      body: {
        error: "beyond_retention",
        message: `Analytics Engine keeps ${RETENTION_DAYS} days; ask the archive for anything older`,
      },
    };
  }
  if (env.CF_ACCOUNT_ID === undefined || env.CF_API_TOKEN === undefined) {
    return {
      ok: false,
      status: 500,
      body: { error: "not_configured", message: "CF_ACCOUNT_ID and CF_API_TOKEN are unset" },
    };
  }

  const response = await askSql(env, buildRetentionQuery(env.DATASET, days));
  if (!response.ok) {
    return {
      ok: false,
      status: 502,
      body: { error: "sql_api_failed", status: response.status, detail: await response.text() },
    };
  }

  const installs = parseInstalls(await response.json());
  const days_seen = installs.map((r) => r.first_day).filter((d) => d !== "");
  return {
    ok: true,
    retention: {
      window_days: days,
      first_day_seen: days_seen.length > 0 ? days_seen.reduce((a, b) => (a < b ? a : b)) : undefined,
      truncated: installs.length >= MAX_INSTALLS,
      rows: summarize(installs, now),
    },
  };
}
