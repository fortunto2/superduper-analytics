/**
 * Суточный джоб GA4: просмотры страниц за день, в ту же таблицу, что и наши.
 *
 * `page_daily` различает счётчики полем `provider`, и это не украшение: за один день у одной
 * страницы будет два разных числа, оба верные, и складывать их нельзя. Джоб пишет только
 * `provider = 'ga4'` и никогда не трогает строки `own`.
 *
 * Отдельный крон, а не пятая задача в общем. Воркер на бесплатном тарифе делает 50 подзапросов
 * за вызов, и утренний джоб уже упирается в этот потолок из-за Search Console — новая работа в
 * той же задаче отняла бы вызовы у соседей, причём молча: их ошибки складываются в примечания,
 * а не в отказ.
 */
import { fetchGaDay, gaSites, type GaRow } from "./api";
import { googleToken, type SearchEnv } from "../search/console";
import { dayBefore, utcDay } from "../stores/schema";

const SCOPE = "https://www.googleapis.com/auth/analytics.readonly";

/**
 * Расписание этого джоба. Значение обязано совпадать со строкой в `wrangler.jsonc`: воркер
 * различает срабатывания по ней, и опечатка означала бы, что GA не запускается никогда, —
 * молча, потому что второй крон при этом честно срабатывает. На совпадение есть тест.
 */
export const GA_CRON = "20 5 * * *";

/**
 * Насколько глубоко перезабирать. Три дня: вчерашние сутки GA отдаёт почти целиком, но ещё
 * день-два уточняет, а запись идёт UPSERT'ом — уточнение просто ложится поверх.
 */
const RESTATE_DAYS = 3;

/** Сколько запросов к Google держать в воздухе разом. */
const CONCURRENCY = 6;

export type GaSyncResult = {
  provider: "ga4";
  days: number;
  sites: number;
  rows: number;
  notes: string[];
};

export async function syncGoogleAnalytics(
  env: SearchEnv & { STORES?: D1Database },
  now: number,
): Promise<GaSyncResult> {
  const notes: string[] = [];
  const sites = gaSites();
  if (env.STORES === undefined) return { provider: "ga4", days: 0, sites: 0, rows: 0, notes: ["no D1"] };
  if (sites.length === 0) {
    // Не молчание, а факт про реестр: ни у одного сайта не проставлен ga_property_id
    return { provider: "ga4", days: 0, sites: 0, rows: 0, notes: ["no site has ga_property_id"] };
  }

  const token = await googleToken(env, now, SCOPE);
  if (token === undefined) {
    return {
      provider: "ga4",
      days: 0,
      sites: sites.length,
      rows: 0,
      notes: ["not configured: GOOGLE_SA_EMAIL, GOOGLE_SA_KEY"],
    };
  }

  const days: string[] = [];
  for (let i = 1; i <= RESTATE_DAYS; i += 1) days.push(dayBefore(utcDay(now), i));

  const tasks = sites.flatMap((site) => days.map((day) => ({ site, day })));
  const collected: GaRow[] = [];
  for (let i = 0; i < tasks.length; i += CONCURRENCY) {
    const chunk = await Promise.all(
      tasks.slice(i, i + CONCURRENCY).map(async (t) => {
        try {
          return await fetchGaDay(token, t.site.property, t.site.host, t.site.id, t.day);
        } catch (error) {
          // Одно свойство без доступа не должно уносить остальные: сервисный аккаунт мог
          // остаться без роли на ресурсе, и это факт про настройку, а не сбой джоба
          notes.push(`${t.site.id} ${t.day}: ${String(error)}`);
          return [];
        }
      }),
    );
    for (const rows of chunk) collected.push(...rows);
  }

  if (collected.length > 0) await writeGaRows(env.STORES, collected, now);
  return { provider: "ga4", days: days.length, sites: sites.length, rows: collected.length, notes };
}

/**
 * Запись строк GA в `page_daily`.
 *
 * Отдельно от запроса, чтобы проверять без сети. UPSERT по тому же ключу, что и у нашей
 * свёртки, — `provider` входит в первичный ключ, поэтому два счётчика лежат рядом и не
 * затирают друг друга.
 */
export async function writeGaRows(db: D1Database, rows: GaRow[], now: number): Promise<void> {
  const statement = db.prepare(
    `INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled)
     VALUES (?, ?, 'ga4', ?, ?, ?, ?)
     ON CONFLICT (day, source, provider, path)
     DO UPDATE SET page_views = excluded.page_views, engaged = excluded.engaged, rolled = excluded.rolled`,
  );
  await db.batch(
    rows.map((r) => statement.bind(r.day, r.source, r.path, r.page_views, r.engaged, now)),
  );
}
