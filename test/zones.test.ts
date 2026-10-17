import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ZONES_PER_QUERY, fetchZoneTotals, listZones, type Zone } from "../src/zones";

/**
 * The regression these guard against cost a month of blank edge numbers.
 *
 * `zoneTag_in` refuses more than ten zones outright — `too many zones requested`, no partial
 * result — and the old code turned that refusal into `return []`. The account crossed ten on
 * 5 August 2026 and every zone-derived figure in the Worker silently emptied: coverage said
 * "edge data unavailable", `agent_traffic` said "no verified AI agent traffic" for sites
 * Cloudflare was logging hundreds of crawler hits a day for.
 */
const zones = (n: number): Zone[] =>
  Array.from({ length: n }, (_, i) => ({ tag: `tag${i}`, name: `zone${i}.example` }));

const dayFor = (tag: string) => ({
  zoneTag: tag,
  httpRequests1dGroups: [
    { dimensions: { date: "2026-09-06" }, sum: { requests: 10, pageViews: 4 }, uniq: { uniques: 3 } },
  ],
});

/** A stand-in that REFUSES more than ten zones, exactly as the real API does. */
function cloudflareWithZoneCeiling(seen: string[][]) {
  return vi.fn(async (_url: string, init: RequestInit) => {
    const ids = JSON.parse(String(init.body)).variables.ids as string[];
    seen.push(ids);
    if (ids.length > MAX_ZONES_PER_QUERY) {
      return new Response(
        JSON.stringify({ errors: [{ message: "too many zones requested" }], data: null }),
        { status: 200 },
      );
    }
    return new Response(
      JSON.stringify({ data: { viewer: { zones: ids.map(dayFor) } } }),
      { status: 200 },
    );
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("fetchZoneTotals batching", () => {
  it("returns every zone when there are more than the API accepts", async () => {
    const seen: string[][] = [];
    vi.stubGlobal("fetch", cloudflareWithZoneCeiling(seen));

    const { totals, failures } = await fetchZoneTotals({ CF_API_TOKEN: "t" }, zones(11), 7, Date.now());
    expect(failures).toEqual([]);

    // The failing behaviour was zero, so assert the count AND that nothing was over the ceiling.
    expect(totals).toHaveLength(11);
    expect(seen.length).toBeGreaterThan(1);
    expect(Math.max(...seen.map((batch) => batch.length))).toBeLessThanOrEqual(MAX_ZONES_PER_QUERY);
  });

  it("still uses a single request when the list fits", async () => {
    const seen: string[][] = [];
    vi.stubGlobal("fetch", cloudflareWithZoneCeiling(seen));

    const { totals } = await fetchZoneTotals({ CF_API_TOKEN: "t" }, zones(10), 7, Date.now());

    expect(totals).toHaveLength(10);
    expect(seen).toHaveLength(1);
  });

  it("keeps the zones it could read when one batch fails", async () => {
    // A batch that fails must not take the others with it — half an answer beats none, as long
    // as nobody calls it whole.
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const ids = JSON.parse(String(init.body)).variables.ids as string[];
        call += 1;
        if (call === 1) return new Response("nope", { status: 500 });
        return new Response(JSON.stringify({ data: { viewer: { zones: ids.map(dayFor) } } }), { status: 200 });
      }),
    );

    const { totals, failures } = await fetchZoneTotals({ CF_API_TOKEN: "t" }, zones(15), 7, Date.now());
    expect(totals).toHaveLength(5);
    // ...and every zone it lost is named, with the reason, so nothing downstream calls it whole.
    expect(failures).toHaveLength(10);
    expect(failures[0]?.unavailable).toContain("HTTP 500");
  });

  it("keeps the other batches when one batch throws instead of answering", async () => {
    let call = 0;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const ids = JSON.parse(String(init.body)).variables.ids as string[];
        call += 1;
        if (call === 2) throw new TypeError("Network connection lost.");
        return new Response(JSON.stringify({ data: { viewer: { zones: ids.map(dayFor) } } }), { status: 200 });
      }),
    );

    const { totals, failures } = await fetchZoneTotals({ CF_API_TOKEN: "t" }, zones(15), 7, Date.now());
    expect(totals).toHaveLength(10);
    expect(failures.map((f) => f.zone)).toEqual(zones(15).slice(10).map((z) => z.name));
    expect(failures[0]?.unavailable).toContain("Network connection lost.");
  });

  it("treats a non-JSON body as a failure of that batch, not of the call", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>gateway</html>", { status: 200 })));
    const { totals, failures } = await fetchZoneTotals({ CF_API_TOKEN: "t" }, zones(3), 7, Date.now());
    expect(totals).toEqual([]);
    expect(failures).toHaveLength(3);
  });

  it("names a zone the reply left out instead of dropping it", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const ids = JSON.parse(String(init.body)).variables.ids as string[];
        return new Response(JSON.stringify({ data: { viewer: { zones: ids.slice(1).map(dayFor) } } }), { status: 200 });
      }),
    );
    const { totals, failures } = await fetchZoneTotals({ CF_API_TOKEN: "t" }, zones(3), 7, Date.now());
    expect(totals).toHaveLength(2);
    expect(failures).toEqual([{ zone: "zone0.example", unavailable: expect.stringContaining("no data") }]);
  });

  it("asks for exactly the window's days: no fixed 90, and never wider than Cloudflare allows", async () => {
    const asked: { limit: number; since: string; until: string }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        const body = JSON.parse(String(init.body));
        asked.push(body.variables);
        return new Response(JSON.stringify({ data: { viewer: { zones: body.variables.ids.map(dayFor) } } }), { status: 200 });
      }),
    );
    await fetchZoneTotals({ CF_API_TOKEN: "t" }, zones(1), 365, Date.UTC(2026, 9, 17, 8));
    // Measured on 17 Oct 2026: 2025-10-17..2026-10-17 (366 dates) is refused as wider than 52w1d,
    // 2025-10-18..2026-10-17 (365 dates) is answered.
    expect(asked[0]).toMatchObject({ limit: 365, since: "2025-10-18", until: "2026-10-17" });
  });
});

describe("listZones", () => {
  const page = (ids: number[], totalPages: number) =>
    new Response(
      JSON.stringify({
        success: true,
        result: ids.map((i) => ({ id: `tag${i}`, name: `zone${i}.example` })),
        result_info: { total_pages: totalPages },
      }),
      { status: 200 },
    );

  it("reads every page, not just the first fifty zones", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string) => {
        const n = Number(new URL(url).searchParams.get("page") ?? "1");
        return n === 1
          ? page(Array.from({ length: 50 }, (_, i) => i), 2)
          : page([50], 2);
      }),
    );
    const { zones: listed, problem } = await listZones({ CF_API_TOKEN: "t" });
    expect(problem).toBeUndefined();
    expect(listed).toHaveLength(51);
  });

  it("says why the list is empty instead of returning an empty list", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("denied", { status: 403 })));
    expect((await listZones({ CF_API_TOKEN: "t" })).problem).toContain("HTTP 403");

    vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("Network connection lost."); }));
    expect((await listZones({ CF_API_TOKEN: "t" })).problem).toContain("Network connection lost.");

    expect((await listZones({})).problem).toContain("CF_API_TOKEN");
  });
});
