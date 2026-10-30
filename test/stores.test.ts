/**
 * The store numbers are a copy of somebody else's arithmetic, and the only way to be sure the
 * copy means the same thing is to parse a real report shape and assert what came out. No network
 * and no credentials — the same rule as everywhere else here.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import schemaSql from "../db/schema.sql?raw";
import { findSilent, readOwnHistory } from "../src/rollup";
import { RETENTION_DAYS } from "../src/schema";
import { buildPagesQuery, buildQuery } from "../src/stats";
import { parseSalesReport, rowsSalesWrites } from "../src/stores/appstore";
import { readCampaigns, readTotals, readSync, writeRows, writeSync } from "../src/stores/db";
import { dayBefore, daysBetween, storeWindow, utcDay, type StoreRow } from "../src/stores/schema";

/** The real header, in Apple's order, so a positional reader would pass and a named one earns it. */
const HEADER = [
  "Provider", "Provider Country", "SKU", "Developer", "Title", "Version",
  "Product Type Identifier", "Units", "Developer Proceeds", "Begin Date", "End Date",
  "Customer Currency", "Country Code", "Currency of Proceeds", "Apple Identifier",
  "Customer Price", "Promo Code", "Parent Identifier", "Subscription", "Period", "Category",
].join("\t");

function line(over: Partial<Record<string, string>>): string {
  const row: Record<string, string> = {
    Provider: "APPLE", "Provider Country": "US", SKU: "sku", Developer: "Dev",
    Title: "App", Version: "1.0", "Product Type Identifier": "1F", Units: "1",
    "Developer Proceeds": "0", "Begin Date": "08/01/2026", "End Date": "08/01/2026",
    "Customer Currency": "USD", "Country Code": "TR", "Currency of Proceeds": "USD",
    "Apple Identifier": "6794324877", "Customer Price": "0", "Promo Code": "",
    "Parent Identifier": "", Subscription: "", Period: "", Category: "",
    ...over,
  };
  return HEADER.split("\t").map((h) => row[h] ?? "").join("\t");
}

const SOURCES = new Map([
  ["6794324877", "carettafriends"],
  ["6761656888", "life2film"],
]);

const report = (...rows: string[]) => [HEADER, ...rows].join("\n");

describe("reading Apple's sales report", () => {
  it("counts a first-time download as an install, against the store's own day", () => {
    const { rows } = parseSalesReport(report(line({ Units: "4" })), SOURCES);
    expect(rows).toEqual([
      {
        day: "2026-08-01",
        source: "carettafriends",
        provider: "appstore",
        metric: "installs",
        campaign: "",
        country: "TR",
        value: 4,
      },
    ]);
  });

  it("keeps re-downloads and updates apart from installs — a reinstall is not a new person", () => {
    const { rows } = parseSalesReport(
      report(
        line({ "Product Type Identifier": "1F", Units: "4" }),
        line({ "Product Type Identifier": "3F", Units: "9" }),
        line({ "Product Type Identifier": "7F", Units: "30" }),
      ),
      SOURCES,
    );
    expect(Object.fromEntries(rows.map((r) => [r.metric, r.value]))).toEqual({
      installs: 4,
      redownloads: 9,
      updates: 30,
    });
  });

  it("matches the family, not the exact code, so a new device class still counts", () => {
    // Apple has added device classes to this column before. `1V` is not a code we have seen;
    // the point is that when it appears it lands in installs rather than vanishing.
    const { rows } = parseSalesReport(
      report(
        line({ "Product Type Identifier": "1", Units: "2" }),
        line({ "Product Type Identifier": "1T", Units: "3" }),
        line({ "Product Type Identifier": "1V", Units: "5" }),
      ),
      SOURCES,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ metric: "installs", value: 10 });
  });

  it("never adds in-app purchase units to installs", () => {
    const { rows } = parseSalesReport(
      report(
        line({ "Product Type Identifier": "1F", Units: "2" }),
        line({ "Product Type Identifier": "IA1", Units: "7", "Developer Proceeds": "2.1" }),
      ),
      SOURCES,
    );
    const byMetric = Object.fromEntries(rows.map((r) => [r.metric, r.value]));
    expect(byMetric.installs).toBe(2);
    expect(byMetric.units).toBe(7);
    expect(byMetric.proceeds_usd).toBeCloseTo(14.7); // per-unit proceeds × units
  });

  it("sums the device-class rows Apple splits one measurement across", () => {
    const { rows } = parseSalesReport(
      report(
        line({ "Product Type Identifier": "1F", Units: "2" }),
        line({ "Product Type Identifier": "1T", Units: "3" }),
      ),
      SOURCES,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.value).toBe(5);
  });

  it("keeps countries and days apart", () => {
    const { rows } = parseSalesReport(
      report(
        line({ "Country Code": "TR", Units: "2" }),
        line({ "Country Code": "DE", Units: "3" }),
        line({ "Begin Date": "08/02/2026", "Country Code": "TR", Units: "4" }),
      ),
      SOURCES,
    );
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => `${r.day}/${r.country}=${r.value}`).sort()).toEqual([
      "2026-08-01/DE=3",
      "2026-08-01/TR=2",
      "2026-08-02/TR=4",
    ]);
  });

  it("skips an app the registry does not know rather than inventing a source id", () => {
    const { rows, skipped } = parseSalesReport(
      report(line({ "Apple Identifier": "9999999999" }), line({ Units: "1" })),
      SOURCES,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe("carettafriends");
    expect(skipped).toBe(1);
  });

  it("reads by column name, so an inserted column shifts nothing", () => {
    const shifted = [
      `Extra\t${HEADER}`,
      ...[line({ Units: "6" })].map((l) => `whatever\t${l}`),
    ].join("\n");
    const { rows } = parseSalesReport(shifted, SOURCES);
    expect(rows[0]).toMatchObject({ metric: "installs", value: 6, source: "carettafriends" });
  });

  it("returns nothing for an empty report instead of throwing", () => {
    expect(parseSalesReport("", SOURCES).rows).toEqual([]);
    expect(parseSalesReport(HEADER, SOURCES).rows).toEqual([]);
  });

  it("never adds euros or yen to dollars — Developer Proceeds is in the currency of proceeds", () => {
    const { rows } = parseSalesReport(
      report(
        line({ "Product Type Identifier": "IA1", Units: "1", "Developer Proceeds": "2.1" }),
        line({ "Product Type Identifier": "IA1", Units: "2", "Developer Proceeds": "1.9",
          "Country Code": "DE", "Currency of Proceeds": "EUR" }),
        line({ "Product Type Identifier": "IA1", Units: "1", "Developer Proceeds": "450",
          "Country Code": "JP", "Currency of Proceeds": "JPY" }),
      ),
      SOURCES,
    );
    const money = Object.fromEntries(
      rows.filter((r) => r.metric.startsWith("proceeds_")).map((r) => [r.metric, r.value]),
    );
    expect(money).toEqual({ proceeds_usd: 2.1, proceeds_eur: 3.8, proceeds_jpy: 450 });
  });

  it("leaves installs and re-downloads to App Analytics, their one writer", () => {
    const { rows } = parseSalesReport(
      report(
        line({ "Product Type Identifier": "1F", Units: "4" }),
        line({ "Product Type Identifier": "3F", Units: "1" }),
        line({ "Product Type Identifier": "7F", Units: "9" }),
        line({ "Product Type Identifier": "IA1", Units: "1", "Developer Proceeds": "2.1" }),
      ),
      SOURCES,
    );
    expect(rowsSalesWrites(rows).map((r) => r.metric).sort()).toEqual([
      "proceeds_usd", "units", "updates",
    ]);
  });
});

describe("UTC day arithmetic", () => {
  it("takes the day from UTC, never the local clock", () => {
    expect(utcDay(Date.parse("2026-08-01T23:30:00Z"))).toBe("2026-08-01");
  });

  it("steps back across a month boundary", () => {
    expect(dayBefore("2026-08-01", 1)).toBe("2026-07-31");
    expect(dayBefore("2026-08-01", 32)).toBe("2026-06-30");
  });

  it("lists an inclusive range, and refuses to run away on a reversed one", () => {
    expect(daysBetween("2026-08-01", "2026-08-03")).toEqual([
      "2026-08-01", "2026-08-02", "2026-08-03",
    ]);
    expect(daysBetween("2026-08-03", "2026-08-01")).toEqual([]);
    expect(daysBetween("2020-01-01", "2026-08-01").length).toBeLessThanOrEqual(400);
  });

  it("ends the store window on the last day Apple has delivered, not yesterday", () => {
    // Наблюдение 30.10.2026: после крона в 05:00 UTC последний записанный день — 28.10.
    expect(storeWindow(Date.parse("2026-10-30T06:00:00Z"), 7)).toEqual({
      from: "2026-10-22",
      to: "2026-10-28",
    });
    expect(storeWindow(Date.parse("2026-10-30T06:00:00Z"), 0)).toEqual({
      from: "2026-10-28",
      to: "2026-10-28",
    });
  });
});

const row = (over: Partial<StoreRow> = {}): StoreRow => ({
  day: "2026-08-01",
  source: "carettafriends",
  provider: "appstore",
  metric: "installs",
  campaign: "",
  country: "TR",
  value: 4,
  ...over,
});

describe("storing them", () => {
  beforeEach(async () => {
    await env.STORES.exec("DROP TABLE IF EXISTS own_daily");
    await env.STORES.exec("DROP TABLE IF EXISTS store_daily");
    await env.STORES.exec("DROP TABLE IF EXISTS store_sync");
    // One statement per exec: D1's exec takes a single statement, and the schema is the source
    // of truth for the test as well as for production — never a second copy of the DDL.
    //
    // Comments come out BEFORE the split, not after. They are prose, and prose contains
    // semicolons — splitting first tears a sentence in half and feeds the second half to SQLite.
    const bare = schemaSql.replace(/--[^\n]*/g, "");
    for (const statement of bare.split(";")) {
      const sql = statement.trim();
      if (sql !== "") await env.STORES.exec(`${sql.replace(/\s+/g, " ")};`);
    }
  });

  it("re-running a day changes the number instead of doubling it", async () => {
    await writeRows(env.STORES, [row({ value: 4 })], 1);
    await writeRows(env.STORES, [row({ value: 4 })], 2);
    expect((await readTotals(env.STORES, "2026-08-01", "2026-08-01"))[0]?.value).toBe(4);

    // Apple restating the day upward must land, not be ignored as a duplicate.
    await writeRows(env.STORES, [row({ value: 6 })], 3);
    expect((await readTotals(env.STORES, "2026-08-01", "2026-08-01"))[0]?.value).toBe(6);
  });

  it("sums countries away for the overview but keeps them in the table", async () => {
    await writeRows(env.STORES, [row({ country: "TR", value: 2 }), row({ country: "DE", value: 3 })], 1);
    const totals = await readTotals(env.STORES, "2026-08-01", "2026-08-01");
    expect(totals).toHaveLength(1);
    expect(totals[0]?.value).toBe(5);
  });

  it("answers only for the window asked for", async () => {
    await writeRows(env.STORES, [row({ day: "2026-07-01" }), row({ day: "2026-08-01" })], 1);
    expect(await readTotals(env.STORES, "2026-08-01", "2026-08-01")).toHaveLength(1);
    expect(await readTotals(env.STORES, "2026-07-01", "2026-08-01")).toHaveLength(1);
  });

  it("shows attributed campaigns and leaves the unattributed out of that list", async () => {
    await writeRows(
      env.STORES,
      [row({ campaign: "site-hero", value: 2 }), row({ campaign: "", value: 38 })],
      1,
    );
    const campaigns = await readCampaigns(env.STORES, "2026-08-01", "2026-08-01");
    expect(campaigns).toEqual([
      { source: "carettafriends", campaign: "site-hero", metric: "installs", value: 2 },
    ]);
    // …but the total still counts all 40, so the two numbers together say "38 unattributed".
    expect((await readTotals(env.STORES, "2026-08-01", "2026-08-01"))[0]?.value).toBe(40);
  });

  it("remembers how far it got, so a missed run does not become a permanent gap", async () => {
    await writeSync(env.STORES, "appstore", new Map([["carettafriends", "2026-08-01"]]), 1);
    expect(await readSync(env.STORES, "appstore")).toEqual(
      new Map([["carettafriends", "2026-08-01"]]),
    );
    await writeSync(env.STORES, "appstore", new Map([["carettafriends", "2026-08-02"]]), 2);
    expect((await readSync(env.STORES, "appstore")).get("carettafriends")).toBe("2026-08-02");
  });
});

describe("the archive of our own days", () => {
  it("asks Analytics Engine for ONE day in the only form that dialect accepts", () => {
    // Learned from a 422: toDate() refuses a STRING argument, and comparing timestamp to a
    // string refuses to combine DateTime with String. Exactly one shape works.
    const sql = buildQuery("events", RETENTION_DAYS).replace(
      `WHERE timestamp > NOW() - INTERVAL '${RETENTION_DAYS}' DAY`,
      "WHERE toDate(timestamp) = '2026-08-03'",
    );
    expect(sql).toContain("WHERE toDate(timestamp) = '2026-08-03'");
    expect(sql).not.toContain("toDate('");
  });

  it("keeps our rollup out of the store table, whose whole premise is exactness", async () => {
    // store_daily holds numbers nobody sampled. Ours are weighted estimates and `people` is a
    // floor; one table for both would quietly destroy the property the other table exists for.
    await env.STORES.exec(
      "INSERT INTO own_daily (day,source,platform,metric,value,sampled,rolled) VALUES ('2026-08-03','miralinka','web','people',4,1,1);",
    );
    const own = await readOwnHistory(env.STORES, "people", "2026-08-01", "2026-08-31");
    expect(own).toEqual([{ day: "2026-08-03", source: "miralinka", platform: "web", value: 4 }]);
    // …and the store table is untouched by it.
    expect(await readTotals(env.STORES, "2026-08-01", "2026-08-31")).toEqual([]);
  });

  it("names a product silent only after two quiet days, not one", async () => {
    const rows = [
      ["2026-08-01", "quiet", 5],
      ["2026-08-02", "quiet", 5],
      ["2026-08-09", "loud", 5],
    ] as const;
    for (const [day, source, value] of rows) {
      await env.STORES.exec(
        `INSERT INTO own_daily (day,source,platform,metric,value,sampled,rolled) VALUES ('${day}','${source}','web','page_views',${value},0,1);`,
      );
    }
    const silent = await findSilent(env.STORES, "2026-08-10");
    // A site with three visitors a week has empty Tuesdays; one of them is a Tuesday, not a fault.
    expect(silent.map((s) => s.source)).toEqual(["quiet"]);
  });
});

describe("окно запроса — параметр, а не подмена строки", () => {
  it("за один день фильтрует по дате, а не по интервалу", () => {
    const sql = buildQuery("events", { day: "2026-08-03" });
    expect(sql).toContain("WHERE toDate(timestamp) = '2026-08-03'");
    expect(sql).not.toContain("INTERVAL");
  });

  it("отвергает день неверной формы, а не подставляет его в SQL", () => {
    // Раньше `?day=` из ручного запуска доходил до литерала в запросе без единой проверки.
    expect(() => buildQuery("events", { day: "вчера" })).toThrow();
    expect(() => buildQuery("events", { day: "2026-8-3" })).toThrow();
    expect(() => buildQuery("events", { day: "2026-08-03' OR '1'='1" })).toThrow();
  });

  it("архиву даёт потолок, а не экранную верхушку", () => {
    // LIMIT 60 — это про панель. В архив должны попасть все страницы всех сайтов за день,
    // иначе тихий сайт исчезает из истории безвозвратно: Analytics Engine стирает через 90 дней.
    expect(buildPagesQuery("events", { day: "2026-08-03" }, 1000)).toContain("LIMIT 1000");
    expect(buildPagesQuery("events", 7)).toContain("LIMIT 60");
  });
});
