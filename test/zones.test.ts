import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ZONES_PER_QUERY, fetchZoneTotals, type Zone } from "../src/zones";

/**
 * The regression these guard against cost a month of blank edge numbers.
 *
 * `zoneTag_in` refuses more than ten zones outright — `too many zones requested`, no partial
 * result — and the old code turned that refusal into `return []`. The account crossed ten on
 * 5 August 2026 and every zone-derived figure in the Worker silently emptied: coverage said
 * "edge data unavailable", `agent_traffic` said "no verified AI agent traffic" for sites
 * Cloudflare was logging a million crawler hits for.
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

    const totals = await fetchZoneTotals({ CF_API_TOKEN: "t" }, zones(11), 7, Date.now());

    // The failing behaviour was zero, so assert the count AND that nothing was over the ceiling.
    expect(totals).toHaveLength(11);
    expect(seen.length).toBeGreaterThan(1);
    expect(Math.max(...seen.map((batch) => batch.length))).toBeLessThanOrEqual(MAX_ZONES_PER_QUERY);
  });

  it("still uses a single request when the list fits", async () => {
    const seen: string[][] = [];
    vi.stubGlobal("fetch", cloudflareWithZoneCeiling(seen));

    const totals = await fetchZoneTotals({ CF_API_TOKEN: "t" }, zones(10), 7, Date.now());

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

    const totals = await fetchZoneTotals({ CF_API_TOKEN: "t" }, zones(15), 7, Date.now());
    expect(totals).toHaveLength(5);
  });
});
