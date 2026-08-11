/**
 * GA4 — второй счётчик на тех же страницах, и вся его ценность в том, что он ЧУЖОЙ. Значит
 * проверять надо ровно то, где чужое может незаметно смешаться со своим: фильтр по хосту,
 * раскладку ответа и то, что строки GA ложатся рядом с нашими, а не поверх них.
 *
 * Без сети и без ключей — то же правило, что и везде здесь.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import schemaSql from "../db/schema.sql?raw";
import wranglerConfig from "../wrangler.jsonc?raw";
import { gaReportBody, gaSites, parseGaReport } from "../src/ga/api";
import { GA_CRON, writeGaRows } from "../src/ga/sync";
import { rollupPages } from "../src/rollup";

describe("gaReportBody", () => {
  it("спрашивает только свой хост", () => {
    const body = gaReportBody("miralinka.com", "2026-08-10") as {
      dimensionFilter: { filter: { fieldName: string; stringFilter: { value: string; matchType: string } } };
    };
    // Без этого фильтра в блог попали бы 203 просмотра с localhost за месяц: свойство GA4
    // видит и рабочую машину, и превью-развёртки, и соседний сайт с тем же тегом
    expect(body.dimensionFilter.filter.fieldName).toBe("hostName");
    expect(body.dimensionFilter.filter.stringFilter).toEqual({
      value: "miralinka.com",
      matchType: "EXACT",
    });
  });

  it("берёт один день, а не окно", () => {
    const body = gaReportBody("miralinka.com", "2026-08-10") as {
      dateRanges: { startDate: string; endDate: string }[];
    };
    expect(body.dateRanges).toEqual([{ startDate: "2026-08-10", endDate: "2026-08-10" }]);
  });
});

describe("parseGaReport", () => {
  const report = {
    rows: [
      { dimensionValues: [{ value: "/mesta/antiohiya" }], metricValues: [{ value: "168" }, { value: "105" }] },
      { dimensionValues: [{ value: "/" }], metricValues: [{ value: "73" }, { value: "21" }] },
    ],
  };

  it("раскладывает метрики по порядку, в котором их заказали", () => {
    expect(parseGaReport(report, "miralinka", "2026-08-10")).toEqual([
      { day: "2026-08-10", source: "miralinka", path: "/mesta/antiohiya", page_views: 168, engaged: 105 },
      { day: "2026-08-10", source: "miralinka", path: "/", page_views: 73, engaged: 21 },
    ]);
  });

  it("день без данных — пустой список, а не строка с нулём", () => {
    expect(parseGaReport({}, "miralinka", "2026-08-10")).toEqual([]);
  });

  it("выбрасывает строку без пути: писать её некуда, путь входит в ключ", () => {
    const broken = { rows: [{ dimensionValues: [{ value: "" }], metricValues: [{ value: "5" }] }] };
    expect(parseGaReport(broken, "miralinka", "2026-08-10")).toEqual([]);
  });
});

describe("gaSites", () => {
  it("берёт из реестра только сайты со свойством", () => {
    const ids = gaSites().map((s) => s.id);
    expect(ids).toContain("miralinka");
    // У марафона своего ресурса GA нет — и спрашивать его не за что
    expect(ids).not.toContain("miralinka-marafon");
  });

  it("одно свойство на два сайта различается хостом", () => {
    const shared = gaSites().filter((s) => s.property === "374549185");
    expect(shared.map((s) => s.host).sort()).toEqual([
      "live2play.superduperai.co",
      "superduperai.co",
    ]);
  });
});

describe("расписание", () => {
  it("крон GA заведён в wrangler.jsonc — иначе джоб не запускается никогда, и молча", () => {
    expect(wranglerConfig).toContain(`"${GA_CRON}"`);
  });
});

describe("две строки на один день", () => {
  beforeEach(async () => {
    await env.STORES.exec("DROP TABLE IF EXISTS page_daily");
    const bare = schemaSql.replace(/--[^\n]*/g, "");
    for (const statement of bare.split(";")) {
      const sql = statement.trim();
      if (sql !== "") await env.STORES.exec(`${sql.replace(/\s+/g, " ")};`);
    }
  });

  const row = (over: Partial<{ page_views: number; engaged: number }> = {}) => ({
    day: "2026-08-10",
    source: "miralinka",
    path: "/mesta/antiohiya",
    page_views: 168,
    engaged: 105,
    ...over,
  });

  it("не затирает наш счётчик: у одной страницы за день два числа, и оба верные", async () => {
    await env.STORES.prepare(
      `INSERT INTO page_daily (day, source, provider, path, page_views, engaged, rolled)
       VALUES ('2026-08-10', 'miralinka', 'own', '/mesta/antiohiya', 4, 2, 1)`,
    ).run();
    await writeGaRows(env.STORES, [row()], 2);

    const { results } = await env.STORES.prepare(
      `SELECT provider, page_views FROM page_daily WHERE day = '2026-08-10' ORDER BY provider`,
    ).all<{ provider: string; page_views: number }>();
    expect(results).toEqual([
      { provider: "ga4", page_views: 168 },
      { provider: "own", page_views: 4 },
    ]);
  });

  it("повторный прогон уточняет день, а не удваивает его", async () => {
    await writeGaRows(env.STORES, [row()], 1);
    await writeGaRows(env.STORES, [row({ page_views: 171 })], 2);

    const { results } = await env.STORES.prepare(
      `SELECT COUNT(*) AS n, SUM(page_views) AS views FROM page_daily WHERE provider = 'ga4'`,
    ).all<{ n: number; views: number }>();
    expect(results[0]).toEqual({ n: 1, views: 171 });
  });

  it("свёртка своих суток не трогает строки GA", async () => {
    await writeGaRows(env.STORES, [row()], 1);
    // Без ключей SQL API свёртка не ходит никуда и возвращает «not configured» — этого хватает:
    // проверяется, что путь записи у неё свой и чужие строки он не задевает
    await rollupPages({ STORES: env.STORES, DATASET: "x" } as never, Date.now());

    const { results } = await env.STORES.prepare(
      `SELECT page_views FROM page_daily WHERE provider = 'ga4'`,
    ).all<{ page_views: number }>();
    expect(results).toEqual([{ page_views: 168 }]);
  });
});
