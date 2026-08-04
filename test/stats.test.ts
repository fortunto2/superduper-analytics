/**
 * The SQL is the risky part, not the HTTP. A wrong aggregate here returns a plausible number
 * and no error, so these tests read the query text itself.
 */
import { describe, expect, it } from "vitest";
import { buildQuery, fetchStats, parseRows,
  buildCampaignQuery,
  parseCampaigns,
} from "../src/stats";
import { RETENTION_DAYS } from "../src/schema";

const env = { DATASET: "superduper_events", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" };

describe("buildQuery", () => {
  const sql = buildQuery("superduper_events", 7);

  it("weights the count by the sample interval", () => {
    expect(sql).toContain("sum(_sample_interval) AS events");
  });

  it("never emits a bare count(), which would undercount without saying so", () => {
    expect(sql).not.toMatch(/\bcount\(\)/);
  });

  it("reads source and platform from the positions BLOB_SLOTS assigns them", () => {
    expect(sql).toContain("blob1 AS source");
    expect(sql).toContain("blob2 AS platform");
  });

  it("scopes to the requested window", () => {
    expect(buildQuery("d", 30)).toContain("INTERVAL '30' DAY");
  });

  it("orders and groups by the alias, never the raw column", () => {
    // `ORDER BY blob1` after `blob1 AS source` is rejected by the live API with "unable to
    // find type of column". Cost two failed queries to discover; cheap to keep discovered.
    expect(sql).toContain("ORDER BY events");
    expect(sql).toContain("GROUP BY source, platform");
    expect(sql).not.toMatch(/(ORDER|GROUP) BY[^\n]*blob\d/);
  });

  it.each([0, -1, 1.5, Number.NaN, RETENTION_DAYS + 1])(
    "refuses to build a query for days=%s rather than interpolating it",
    (days) => {
      expect(() => buildQuery("d", days)).toThrow();
    },
  );

  it("cannot be injected through the window, because only integers survive", () => {
    expect(() => buildQuery("d", "7; DROP TABLE x" as unknown as number)).toThrow();
  });
});

describe("parseRows", () => {
  it("coerces the string aggregates the SQL API returns", () => {
    const row = { source: "books", platform: "web", events: "42", page_views: "40", people_raw: "9" };
    expect(parseRows({ data: [row] })).toEqual([
      { source: "books", platform: "web", events: 42, bot_events: 0, page_views: 40, engaged: 0, people_seen: 9, max_sample: 1 },
    ]);
  });

  it("assumes no sampling when max_sample is missing, rather than assuming the worst", () => {
    expect(parseRows({ data: [{ source: "a", platform: "web" }] })[0]?.max_sample).toBe(1);
  });

  it.each([[null], [{}], [{ data: null }], ["nonsense"]])(
    "returns nothing rather than throwing on %s",
    (payload) => {
      expect(parseRows(payload)).toEqual([]);
    },
  );
});

describe("fetchStats guards", () => {
  it("answers past retention with an empty set and says so, never with a shorter window", async () => {
    // Раньше здесь был отказ, и он был прав, пока архива не существовало: молча ответить за
    // 90 дней на вопрос про год — худшее из возможного. Теперь архив есть, и отказ означал бы
    // «за год ничего нет» вместо «событий нет, а архив отвечает».
    const result = await fetchStats(env, RETENTION_DAYS + 1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Окно возвращается ЗАПРОШЕННОЕ, а не урезанное — иначе подмена всё равно случилась бы,
    // просто тише.
    expect(result.stats.window_days).toBe(RETENTION_DAYS + 1);
    expect(result.stats.beyond_retention).toBe(true);
    expect(result.stats.sources).toEqual([]);
    expect(result.stats.total_page_views).toBe(0);
  });

  it.each([0, -3, 1.5])("refuses a nonsense window (%s)", async (days) => {
    expect(await fetchStats(env, days)).toMatchObject({ ok: false, body: { error: "bad_window" } });
  });

  it("says plainly when the secrets are missing rather than failing at the API", async () => {
    const result = await fetchStats({ DATASET: "d" }, 7);
    expect(result).toMatchObject({ ok: false, status: 500, body: { error: "not_configured" } });
  });
});

describe("fetchStats against a stubbed SQL API", () => {
  const withFetch = async <T>(impl: typeof fetch, run: () => Promise<T>): Promise<T> => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      return await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  it("totals the rows and reports whether sampling was active", async () => {
    const result = await withFetch(
      async () =>
        Response.json({
          data: [
            { source: "superduperai", platform: "web", events: "100", bot_events: "40", page_views: "90", people_raw: "8", max_sample: "15" },
            { source: "live2play", platform: "ios", events: "23", page_views: "0", people_raw: "3", max_sample: "1" },
          ],
        }),
      () => fetchStats(env, 7),
    );
    if (!result.ok) throw new Error("expected success");
    expect(result.stats.total_events).toBe(123);
    expect(result.stats.total_page_views).toBe(90);
    // One group was sampled, so the whole payload is flagged — the dashboard must say so.
    expect(result.stats.sampling_active).toBe(true);
  });

  it("does not flag sampling when every group kept every row", async () => {
    const result = await withFetch(
      async () => Response.json({ data: [{ source: "books", events: "5", max_sample: "1" }] }),
      () => fetchStats(env, 7),
    );
    if (!result.ok) throw new Error("expected success");
    expect(result.stats.sampling_active).toBe(false);
  });

  it("sends the token as a bearer and the query as the body", async () => {
    let seen: { url: string; auth: string | null; body: string } | undefined;
    await withFetch(
      async (input, init) => {
        seen = {
          url: String(input),
          auth: new Headers(init?.headers).get("authorization"),
          body: String(init?.body),
        };
        return Response.json({ data: [] });
      },
      () => fetchStats(env, 14),
    );
    expect(seen?.url).toBe("https://api.cloudflare.com/client/v4/accounts/acc/analytics_engine/sql");
    expect(seen?.auth).toBe("Bearer tok");
    expect(seen?.body).toContain("INTERVAL '14' DAY");
  });

  it("reports an upstream failure as 502 instead of pretending there were no events", async () => {
    const result = await withFetch(
      async () => new Response("Authentication error", { status: 401 }),
      () => fetchStats(env, 7),
    );
    expect(result).toMatchObject({ ok: false, status: 502, body: { error: "sql_api_failed" } });
  });
});

describe("bots are separated, not hidden", () => {
  it("drops the empty-string bucket bot rows collapse onto", () => {
    // The SQL maps every bot row to '' because if(cond, x, null) is rejected by the dialect,
    // so one spurious distinct value has to come back off.
    const withBots = parseRows({ data: [{ people_raw: "8", bot_events: "40" }] })[0];
    const without = parseRows({ data: [{ people_raw: "8", bot_events: "0" }] })[0];
    expect(withBots?.people_seen).toBe(7);
    expect(without?.people_seen).toBe(8);
  });

  it("never reports negative people, however odd the row", () => {
    expect(parseRows({ data: [{ people_raw: "0", bot_events: "5" }] })[0]?.people_seen).toBe(0);
  });

  it("reports bot volume rather than discarding it", () => {
    // life2film's real shape on day two: 88 bot events against 10 human ones.
    const row = parseRows({ data: [{ events: "98", bot_events: "88", people_raw: "3" }] })[0];
    expect(row?.bot_events).toBe(88);
    expect(row?.people_seen).toBe(2);
  });
});

describe("what each campaign brought", () => {
  it("counts only tagged visits, and only ones a browser made", () => {
    const sql = buildCampaignQuery("events", 7);
    // The tag is the whole filter: an untagged visit is not "campaign none", it is a visit this
    // table has nothing to say about.
    expect(sql).toContain("blob14 != ''");
    // Weighted like everything else here — plain count() returns a smaller number, not an error.
    expect(sql).toContain("sum(if(blob9 != 'bot' AND blob3 = 'page_viewed', _sample_interval, 0))");
    // Analytics Engine needs the alias in ORDER BY, not the expression.
    expect(sql).toContain("ORDER BY page_views DESC");
  });

  it("keeps bots in their own column instead of dropping the row", () => {
    // A campaign whose visits are zero and bots are not is a scraped link, not a broken tag.
    // Those two are indistinguishable if the column is missing.
    expect(buildCampaignQuery("events", 7)).toContain("AS bot_views");
  });

  it("refuses a window past retention rather than quietly shortening it", () => {
    expect(() => buildCampaignQuery("events", 400)).toThrow();
    expect(() => buildCampaignQuery("events", 0)).toThrow();
  });

  it("reads the rows Analytics Engine actually returns, numbers as strings and all", () => {
    const rows = parseCampaigns({
      data: [
        {
          source: "carettafriends",
          utm_source: "youtube",
          utm_medium: "shorts",
          utm_campaign: "nest-01",
          page_views: "12",
          engaged: "5",
          store_clicks: "2",
          bot_views: "1",
        },
      ],
    });
    expect(rows).toEqual([
      {
        source: "carettafriends",
        utm_source: "youtube",
        utm_medium: "shorts",
        utm_campaign: "nest-01",
        page_views: 12,
        engaged: 5,
        store_clicks: 2,
        bot_views: 1,
      },
    ]);
  });

  it("survives an empty or malformed payload — a missing panel beats a broken page", () => {
    expect(parseCampaigns({ data: [] })).toEqual([]);
    expect(parseCampaigns(null)).toEqual([]);
    expect(parseCampaigns({})).toEqual([]);
  });
});
