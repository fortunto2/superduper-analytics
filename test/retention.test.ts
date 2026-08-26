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
  COHORT_DAYS,
  fetchRetention,
  foldInstalls,
  MATURITY_DAYS,
  parseInstallDays,
  summarize,
  type InstallRow,
} from "../src/retention";
import { RETENTION_DAYS } from "../src/schema";

const env = { DATASET: "superduper_events", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" };

/** 2026-08-21T12:00:00Z — полдень, чтобы округление к суткам было видно, а не случайно верным. */
const NOW = Date.UTC(2026, 7, 21, 12, 0, 0);
const day = (offset: number) => new Date(NOW + offset * 86_400_000).toISOString().slice(0, 10);

/**
 * Установка, заданная днём первого запуска и смещениями активных суток от него.
 *
 * `active: [0, 1]` — пришёл и вернулся назавтра; `[0, 5]` — вернулся на шестые сутки, что для
 * D1 означает «не вернулся», а для «вернулся хоть раз» — что вернулся. Ровно это различие
 * когорты и добавляют, поэтому фикстура задаёт дни, а не их количество.
 */
function install(over: Partial<InstallRow> & { first?: number; active?: number[] } = {}): InstallRow {
  const { first = -10, active = [0], ...rest } = over;
  const days = new Set(active.map((offset) => day(first + offset)));
  const sorted = [...days].sort();
  return {
    source: "life2film",
    platform: "ios",
    anon: "uuid",
    days,
    first_day: sorted[0] ?? day(first),
    last_day: sorted[sorted.length - 1] ?? day(first),
    events: 1,
    max_sample: 1,
    ...rest,
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

  it("returns a row per install-DAY, because a cohort needs the days themselves", () => {
    expect(sql).toContain("toDate(timestamp) AS day");
    expect(sql).toContain("GROUP BY source, platform, anon, day");
    // Свёрнутое число суток здесь больше не считается: из него не выводится «вернулся на первые».
    expect(sql).not.toContain("days_active");
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

describe("parseInstallDays / foldInstalls", () => {
  it("coerces the strings the SQL API returns for aggregates", () => {
    const rows = parseInstallDays({
      data: [{ source: "s", platform: "ios", anon: "u", day: "2026-08-01", events: "42", smpl: 1 }],
    });
    expect(rows[0]?.day).toBe("2026-08-01");
    expect(rows[0]?.events).toBe(42);
  });

  it("returns nothing rather than throwing when the payload has no rows", () => {
    expect(parseInstallDays(null)).toEqual([]);
    expect(parseInstallDays({})).toEqual([]);
  });

  it("сворачивает дни в установку, сохраняя множество суток целиком", () => {
    const [one] = foldInstalls([
      { source: "s", platform: "ios", anon: "u", day: "2026-08-03", events: 2, max_sample: 1 },
      { source: "s", platform: "ios", anon: "u", day: "2026-08-01", events: 5, max_sample: 4 },
    ]);
    expect(one?.days).toEqual(new Set(["2026-08-01", "2026-08-03"]));
    expect(one?.first_day).toBe("2026-08-01");
    expect(one?.last_day).toBe("2026-08-03");
    expect(one?.events).toBe(7);
    // Худший интервал по установке, а не последний увиденный.
    expect(one?.max_sample).toBe(4);
  });

  it("разные anon остаются разными установками", () => {
    const folded = foldInstalls([
      { source: "s", platform: "ios", anon: "a", day: "2026-08-01", events: 1, max_sample: 1 },
      { source: "s", platform: "ios", anon: "b", day: "2026-08-01", events: 1, max_sample: 1 },
    ]);
    expect(folded).toHaveLength(2);
  });
});

describe("дневные когорты", () => {
  const cohort = (rows: InstallRow[], n: number) =>
    summarize(rows, NOW)[0]?.cohorts.find((c) => c.day === n);

  it("D1 — вернулся ИМЕННО на следующие сутки, а не когда-нибудь", () => {
    const rows = [
      install({ anon: "d1", first: -8, active: [0, 1] }),
      // Вернулся на шестые сутки: для «хоть раз» это возврат, для D1 — нет.
      install({ anon: "late", first: -8, active: [0, 6] }),
    ];
    expect(cohort(rows, 1)).toMatchObject({ eligible: 2, returned: 1 });
    // При этом обе установки считаются вернувшимися в общем `return_rate`.
    expect(summarize(rows, NOW)[0]?.returned).toBe(2);
  });

  it("не спрашивает про седьмые сутки ту установку, которой три дня", () => {
    const rows = [install({ anon: "young", first: -3, active: [0] })];
    expect(cohort(rows, 7)).toMatchObject({ eligible: 0, rate: null });
    expect(cohort(rows, 1)).toMatchObject({ eligible: 1, returned: 0, rate: 0 });
  });

  it("считает долю по своему знаменателю на каждой когорте", () => {
    const rows = [
      install({ anon: "a", first: -9, active: [0, 1, 7] }),
      install({ anon: "b", first: -9, active: [0, 1] }),
      install({ anon: "c", first: -9, active: [0] }),
      install({ anon: "young", first: -2, active: [0, 1] }),
    ];
    // D1: спрашиваем всех четверых, вернулись трое.
    expect(cohort(rows, 1)).toMatchObject({ eligible: 4, returned: 3 });
    // D7: младшую спросить нельзя, из троих вернулась одна.
    expect(cohort(rows, 7)).toMatchObject({ eligible: 3, returned: 1 });
  });

  it("отдаёт ровно те когорты, что объявлены", () => {
    expect(summarize([install()], NOW)[0]?.cohorts.map((c) => c.day)).toEqual([...COHORT_DAYS]);
  });
});

describe("summarize", () => {
  it("keeps an install that has not had the chance to return OUT of the rate", () => {
    const rows = summarize(
      [
        install({ anon: "old", first: -10, active: [0, 1] }),
        // Поставлено сегодня: вернуться было физически некогда.
        install({ anon: "fresh", first: 0, active: [0] }),
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
        install({ anon: "a", first: -8, active: [0] }),
        install({ anon: "b", first: -8, active: [0, 1] }),
        install({ anon: "c", first: -8, active: [0, 1, 2, 3, 5] }),
      ],
      NOW,
    );
    expect(rows[0]?.returned).toBe(2);
    expect(rows[0]?.return_rate).toBeCloseTo(2 / 3);
  });

  it("says n/a instead of zero when nobody is old enough to ask", () => {
    const rows = summarize([install({ first: 0, active: [0] })], NOW);
    // Ноль читался бы как «никто не вернулся»; здесь никого ещё и не спрашивали.
    expect(rows[0]?.return_rate).toBeNull();
    expect(rows[0]?.mature).toBe(0);
  });

  it("counts active_now from the last day seen, not from the first", () => {
    const rows = summarize(
      [
        install({ anon: "живой", first: -20, active: [0, 1, 2, 19] }),
        install({ anon: "ушёл", first: -20, active: [0] }),
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
        install({ anon: "a", events: 150, first: -6, active: [0, 1, 2, 4] }),
        install({ anon: "b", events: 50, first: -6, active: [0, 1] }),
      ],
      NOW,
    );
    expect(rows[0]?.events_per_install).toBe(100);
  });

  it("takes the median over MATURE installs only, so fresh ones cannot drag it to 1", () => {
    const rows = summarize(
      [
        install({ anon: "a", first: -9, active: [0, 1, 2, 4] }),
        install({ anon: "b", first: -9, active: [0, 1, 2, 3, 4, 6] }),
        install({ anon: "new1", first: 0, active: [0] }),
        install({ anon: "new2", first: 0, active: [0] }),
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
        install({ anon: "a", first: -3, active: [0, 2] }),
        install({ anon: "b", first: -5, active: [0, 1] }),
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
