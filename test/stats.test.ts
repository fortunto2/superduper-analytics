/**
 * The SQL is the risky part, not the HTTP. A wrong aggregate here returns a plausible number
 * and no error, so these tests read the query text itself.
 */
import { describe, expect, it } from "vitest";
import { buildQuery, fetchStats, parseRows } from "../src/stats";
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
    expect(parseRows({ data: [{ source: "books", platform: "web", events: "42" }] })).toEqual([
      { source: "books", platform: "web", events: 42 },
    ]);
  });

  it.each([[null], [{}], [{ data: null }], ["nonsense"]])(
    "returns nothing rather than throwing on %s",
    (payload) => {
      expect(parseRows(payload)).toEqual([]);
    },
  );
});

describe("fetchStats guards", () => {
  it("refuses a window past the hot store's retention instead of silently shortening it", async () => {
    const result = await fetchStats(env, RETENTION_DAYS + 1);
    expect(result).toMatchObject({
      ok: false,
      status: 400,
      body: { error: "beyond_retention", limit: RETENTION_DAYS },
    });
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

  it("totals the rows and marks the result as sampled", async () => {
    const result = await withFetch(
      async () =>
        Response.json({
          data: [
            { source: "superduperai", platform: "web", events: "100" },
            { source: "live2play", platform: "ios", events: "23" },
          ],
        }),
      () => fetchStats(env, 7),
    );
    expect(result).toEqual({
      ok: true,
      stats: {
        window_days: 7,
        sampled: true,
        total_events: 123,
        sources: [
          { source: "superduperai", platform: "web", events: 100 },
          { source: "live2play", platform: "ios", events: 23 },
        ],
      },
    });
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
