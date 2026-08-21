/**
 * Здесь ломается знаменатель, и ломается тихо.
 *
 * Страница с одним просмотром и одним нажатием даёт «конверсию 100%» — и в сортировке по доле
 * встаёт выше страницы, которую стоило бы чинить. Порог просмотров и есть защита от этого, а не
 * косметика, поэтому он проверяется отдельно.
 */
import { describe, expect, it } from "vitest";
import {
  buildConversionQuery,
  fetchConversion,
  MIN_VIEWS,
  parseRaw,
  summarize,
} from "../src/conversion";
import { RETENTION_DAYS } from "../src/schema";

const env = { DATASET: "superduper_events", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" };

const row = (path: string, name: string, count: number, source = "visaphoto") => ({
  source,
  path,
  name,
  count,
});

describe("buildConversionQuery", () => {
  const sql = buildConversionQuery("superduper_events", 28);

  it("weights every count by the sample interval", () => {
    expect(sql).toContain("sum(_sample_interval) AS count");
    expect(sql).not.toMatch(/\bcount\(\)/);
  });

  it("asks only about web — an app screen has no page views to divide by", () => {
    expect(sql).toContain("blob2 = 'web'");
  });

  it("drops events with no path rather than crediting them to some page", () => {
    expect(sql).toContain("blob4 != ''");
  });

  it("excludes bots, which click nothing and would deflate every rate", () => {
    expect(sql).toContain("blob9 != 'bot'");
  });

  it("groups by page AND event name, so views and goals arrive in one round trip", () => {
    expect(sql).toContain("GROUP BY source, path, name");
  });

  it("refuses a window the hot store cannot serve", () => {
    expect(() => buildConversionQuery("d", RETENTION_DAYS + 1)).toThrow();
    expect(() => buildConversionQuery("d", 0)).toThrow();
  });
});

describe("parseRaw", () => {
  it("coerces counts the API returns as strings", () => {
    expect(parseRaw({ data: [{ source: "s", path: "/", name: "page_viewed", count: "7" }] })[0]?.count).toBe(7);
  });

  it("survives an empty or malformed payload", () => {
    expect(parseRaw(null)).toEqual([]);
    expect(parseRaw({ data: "nope" })).toEqual([]);
  });
});

describe("summarize", () => {
  it("divides goals by views of the same page", () => {
    const rows = summarize([row("/", "page_viewed", 100), row("/", "photo_checked", 4)]);
    expect(rows[0]?.conversion).toBeCloseTo(0.04);
    expect(rows[0]?.goals).toBe(4);
  });

  it("does not count engagement as a goal — it is the weaker signal, not the same one", () => {
    const rows = summarize([
      row("/", "page_viewed", 100),
      row("/", "page_engaged", 60),
      row("/", "photo_checked", 4),
    ]);
    expect(rows[0]?.goals).toBe(4);
    expect(rows[0]?.engagement).toBeCloseTo(0.6);
  });

  it("drops a page below the view threshold, where one click reads as 100%", () => {
    const rows = summarize([row("/rare", "page_viewed", 1), row("/rare", "clicked", 1)]);
    expect(rows).toEqual([]);
  });

  it("drops a page with goals but no views instead of dividing by zero", () => {
    const rows = summarize([row("/ghost", "app_store_opened", 5)]);
    expect(rows).toEqual([]);
  });

  it("honours a caller-supplied threshold", () => {
    const raw = [row("/small", "page_viewed", 5), row("/small", "clicked", 1)];
    expect(summarize(raw)).toEqual([]);
    expect(summarize(raw, 5)).toHaveLength(1);
  });

  it("lists which goals, most frequent first — a rate alone is not actionable", () => {
    const rows = summarize([
      row("/", "page_viewed", 100),
      row("/", "photo_downloaded", 3),
      row("/", "photo_checked", 20),
    ]);
    expect(rows[0]?.by_goal.map(g => g.name)).toEqual(["photo_checked", "photo_downloaded"]);
  });

  it("allows a rate above 100%: one visitor may click twice", () => {
    const rows = summarize([row("/", "page_viewed", 10), row("/", "clicked", 25)]);
    expect(rows[0]?.conversion).toBe(2.5);
  });

  it("keeps the same path on two products apart", () => {
    const rows = summarize([
      row("/", "page_viewed", 50, "visaphoto"),
      row("/", "photo_checked", 10, "visaphoto"),
      row("/", "page_viewed", 50, "life2film"),
    ]);
    expect(rows).toHaveLength(2);
    // По доле: страница с целями впереди пустой — это и есть вопрос «где хуже всего».
    expect(rows[0]?.source).toBe("visaphoto");
    expect(rows[1]?.conversion).toBe(0);
  });

  it("breaks a tie on views, so the bigger page is the one worth looking at first", () => {
    const rows = summarize([
      row("/big", "page_viewed", 500, "s"),
      row("/small", "page_viewed", 20, "s"),
    ]);
    expect(rows[0]?.path).toBe("/big");
  });

  it("has a threshold above one, which is the whole point of having one", () => {
    expect(MIN_VIEWS).toBeGreaterThan(1);
  });
});

describe("fetchConversion", () => {
  it("refuses a window past the retention of the hot store", async () => {
    const result = await fetchConversion(env, RETENTION_DAYS + 1);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.error).toBe("beyond_retention");
  });

  it("says it is unconfigured rather than calling the API without a token", async () => {
    const result = await fetchConversion({ DATASET: "d" }, 7);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.body.error).toBe("not_configured");
  });
});
