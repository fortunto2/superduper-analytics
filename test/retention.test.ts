/**
 * Опасное здесь — не HTTP, а два правила, которые ломаются молча и оба дают правдоподобное число.
 *
 * Первое: в выборку не должен попадать веб. Идентификатор на вебе живёт одни сутки, так что
 * `days_active` там всегда 1, а доля возвратов — ноль. Не ошибка запроса, а бессмыслица, которая
 * выглядит как плохой продукт.
 *
 * Второе: установка, увиденная вчера, не могла вернуться. Оставь её в знаменателе — и доля
 * падает ровно тогда, когда продукт растёт быстрее всего.
 */
import { describe, expect, it } from "vitest";
import {
  ACTIVE_WINDOW_DAYS,
  buildRetentionQuery,
  fetchRetention,
  MATURITY_DAYS,
  parseInstalls,
  summarize,
  type InstallRow,
} from "../src/retention";
import { RETENTION_DAYS } from "../src/schema";

const env = { DATASET: "superduper_events", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" };

/** 2026-08-21T12:00:00Z — полдень, чтобы округление к суткам было видно, а не случайно верным. */
const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const day = (offset: number) => new Date(NOW + offset * 86_400_000).toISOString().slice(0, 10);

function install(over: Partial<InstallRow> = {}): InstallRow {
  return {
    source: "life2film",
    platform: "ios",
    anon: "uuid",
    days_active: 1,
    first_day: day(-10),
    last_day: day(-10),
    events: 1,
    max_sample: 1,
    ...over,
  };
}

describe("buildRetentionQuery", () => {
  const sql = buildRetentionQuery("superduper_events", 28);

  it("excludes web in the SQL, not later — a one-day id cannot answer this question", () => {
    expect(sql).toContain("blob2 != 'web'");
  });

  it("drops rows with no install id instead of merging them into one loyal user", () => {
    expect(sql).toContain("blob8 != ''");
  });

  it("excludes bots", () => {
    expect(sql).toContain("blob9 != 'bot'");
  });

  it("counts distinct calendar days, which is what a return is", () => {
    expect(sql).toContain("count(DISTINCT toDate(timestamp)) AS days_active");
  });

  it("carries max(_sample_interval) so a floor can be labelled as one", () => {
    expect(sql).toContain("max(_sample_interval) AS smpl");
  });

  it("groups per install, because the second aggregate happens in TypeScript", () => {
    expect(sql).toContain("GROUP BY source, platform, anon");
  });

  it("refuses a window the hot store cannot serve", () => {
    expect(() => buildRetentionQuery("d", RETENTION_DAYS + 1)).toThrow();
    expect(() => buildRetentionQuery("d", 0)).toThrow();
    expect(() => buildRetentionQuery("d", 1.5)).toThrow();
  });
});

describe("parseInstalls", () => {
  it("coerces the strings the SQL API returns for aggregates", () => {
    const rows = parseInstalls({
      data: [{ source: "s", platform: "ios", anon: "u", days_active: "3", first_day: "2026-08-01", last_day: "2026-08-03", events: "42", smpl: 1 }],
    });
    expect(rows[0]?.days_active).toBe(3);
    expect(rows[0]?.events).toBe(42);
  });

  it("returns nothing rather than throwing when the payload has no rows", () => {
    expect(parseInstalls(null)).toEqual([]);
    expect(parseInstalls({})).toEqual([]);
  });
});

describe("summarize", () => {
  it("keeps an install that has not had the chance to return OUT of the rate", () => {
    const rows = summarize(
      [
        install({ anon: "old", first_day: day(-10), last_day: day(-9), days_active: 2 }),
        // Поставлено сегодня: вернуться было физически некогда.
        install({ anon: "fresh", first_day: day(0), last_day: day(0), days_active: 1 }),
      ],
      NOW,
    );
    const row = rows[0];
    expect(row?.installs).toBe(2);
    expect(row?.mature).toBe(1);
    expect(row?.too_new).toBe(1);
    // Один зрелый из одного вернулся — 100%, а не 50%, как показала бы наивная доля.
    expect(row?.return_rate).toBe(1);
  });

  it("counts a return as activity on more than one calendar day", () => {
    const rows = summarize(
      [
        install({ anon: "a", days_active: 1, first_day: day(-8), last_day: day(-8) }),
        install({ anon: "b", days_active: 2, first_day: day(-8), last_day: day(-7) }),
        install({ anon: "c", days_active: 5, first_day: day(-8), last_day: day(-3) }),
      ],
      NOW,
    );
    expect(rows[0]?.returned).toBe(2);
    expect(rows[0]?.return_rate).toBeCloseTo(2 / 3);
  });

  it("says n/a instead of zero when nobody is old enough to ask", () => {
    const rows = summarize([install({ first_day: day(0), last_day: day(0) })], NOW);
    // Ноль читался бы как «никто не вернулся»; здесь никого ещё и не спрашивали.
    expect(rows[0]?.return_rate).toBeNull();
    expect(rows[0]?.mature).toBe(0);
  });

  it("counts active_now from the last day seen, not from the first", () => {
    const rows = summarize(
      [
        install({ anon: "живой", first_day: day(-20), last_day: day(-1), days_active: 4 }),
        install({ anon: "ушёл", first_day: day(-20), last_day: day(-20), days_active: 1 }),
      ],
      NOW,
    );
    expect(rows[0]?.active_now).toBe(1);
  });

  it("splits ios and android of the same product into their own rows", () => {
    const rows = summarize(
      [
        install({ source: "carettafriends", platform: "ios", anon: "i" }),
        install({ source: "carettafriends", platform: "android", anon: "a" }),
      ],
      NOW,
    );
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.platform).sort()).toEqual(["android", "ios"]);
  });

  it("reports events per install, which separates a used app from an opened one", () => {
    const rows = summarize(
      [
        install({ anon: "a", events: 150, days_active: 4, first_day: day(-6), last_day: day(-2) }),
        install({ anon: "b", events: 50, days_active: 2, first_day: day(-6), last_day: day(-5) }),
      ],
      NOW,
    );
    expect(rows[0]?.events_per_install).toBe(100);
  });

  it("takes the median over MATURE installs only, so fresh ones cannot drag it to 1", () => {
    const rows = summarize(
      [
        install({ anon: "a", days_active: 4, first_day: day(-9), last_day: day(-5) }),
        install({ anon: "b", days_active: 6, first_day: day(-9), last_day: day(-3) }),
        install({ anon: "new1", days_active: 1, first_day: day(0), last_day: day(0) }),
        install({ anon: "new2", days_active: 1, first_day: day(0), last_day: day(0) }),
      ],
      NOW,
    );
    expect(rows[0]?.median_days_active).toBe(5);
  });

  it("reports the day the group first said anything, so a fresh counter is visible", () => {
    // Раскатка счётчика выглядит как всплеск установок: идентификатор рождается на первом
    // запуске новой сборки. Без этой даты низкая доля возвратов читается как плохой продукт.
    const rows = summarize(
      [
        install({ anon: "a", first_day: day(-3), last_day: day(-1), days_active: 2 }),
        install({ anon: "b", first_day: day(-5), last_day: day(-4), days_active: 2 }),
      ],
      NOW,
    );
    expect(rows[0]?.first_report_day).toBe(day(-5));
  });

  it("carries the worst sample interval of the group, so a floor is labelled", () => {
    const rows = summarize(
      [install({ anon: "a", max_sample: 1 }), install({ anon: "b", max_sample: 10 })],
      NOW,
    );
    expect(rows[0]?.max_sample).toBe(10);
  });

  it("sorts by install count, so the rows where a rate means anything come first", () => {
    const rows = summarize(
      [
        install({ source: "small", anon: "a" }),
        install({ source: "big", anon: "b" }),
        install({ source: "big", anon: "c" }),
      ],
      NOW,
    );
    expect(rows[0]?.source).toBe("big");
  });

  it("has thresholds that are days, not hours", () => {
    expect(MATURITY_DAYS).toBe(2);
    expect(ACTIVE_WINDOW_DAYS).toBe(7);
  });
});

describe("fetchRetention", () => {
  it("refuses a window past what the hot store keeps instead of answering short", async () => {
    const result = await fetchRetention(env, RETENTION_DAYS + 1, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.error).toBe("beyond_retention");
  });

  it("says it is unconfigured rather than calling the API without a token", async () => {
    const result = await fetchRetention({ DATASET: "d" }, 7, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.error).toBe("not_configured");
  });

  it("rejects a window that is not a positive integer", async () => {
    const result = await fetchRetention(env, 0, NOW);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.error).toBe("bad_window");
  });
});
