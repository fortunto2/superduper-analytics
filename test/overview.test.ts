import { describe, expect, it } from "vitest";
import { domainFamily, isReporting } from "../src/overview";

describe("группировка доменов", () => {
  it("сводит поддомены к одной семье", () => {
    expect(domainFamily("books.superduperai.co")).toBe("superduperai.co");
    expect(domainFamily("marafon.miralinka.com")).toBe("miralinka.com");
    expect(domainFamily("app.carettafriends.com")).toBe("carettafriends.com");
  });

  it("оставляет домен второго уровня как есть", () => {
    expect(domainFamily("rustman.org")).toBe("rustman.org");
    expect(domainFamily("akbuzat.net")).toBe("akbuzat.net");
  });

  it("не путает разные продукты на одном суффиксе", () => {
    expect(domainFamily("life2film.com")).not.toBe(domainFamily("miralinka.com"));
  });
});

import { afterEach, vi } from "vitest";
import { fetchOverview } from "../src/overview";
import { SITES } from "../src/registry.generated";

/**
 * Cloudflare's side of the overview, end to end with a stubbed fetch. Each case is a way the
 * edge used to be reported as complete — or as empty — when part of it was never read.
 */
const families = [...new Set(SITES.filter((s) => !s.retired).map((s) => domainFamily(s.host)))].sort();
const listed = [...families, "foreign.example"].map((name, i) => ({ id: `z${i}`, name }));
const tagOf = (name: string) => listed.find((z) => z.name === name)!.id;
const env = { DATASET: "superduper_events", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" };

type Plan = {
  zonesThrow?: boolean;
  failTotalsBatch?: number;
  failAgentsFor?: string;
};

function cloudflare(plan: Plan) {
  const seen = { totalsIds: [] as string[][], agentZones: [] as string[] };
  let batch = 0;
  const fn = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.includes("/analytics_engine/sql")) {
      return new Response(JSON.stringify({
        data: [{ source: "visaphoto", platform: "web", events: 10, page_views: 5, engaged: 3, people_raw: 2 }],
      }));
    }
    if (url.includes("/zones")) {
      if (plan.zonesThrow) throw new TypeError("Network connection lost.");
      return new Response(JSON.stringify({ success: true, result: listed, result_info: { total_pages: 1 } }));
    }
    const body = JSON.parse(String(init?.body));
    if (String(body.query).includes("httpRequests1dGroups")) {
      batch += 1;
      seen.totalsIds.push(body.variables.ids);
      if (batch === plan.failTotalsBatch) return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ data: { viewer: { zones: body.variables.ids.map((t: string) => ({
        zoneTag: t,
        httpRequests1dGroups: [{ dimensions: { date: "2026-10-16" }, sum: { requests: 100, pageViews: 40 }, uniq: { uniques: 20 } }],
      })) } } }));
    }
    const zone = listed.find((z) => z.id === body.variables.zone)!;
    seen.agentZones.push(zone.name);
    if (zone.name === plan.failAgentsFor) return new Response("nope", { status: 500 });
    return new Response(JSON.stringify({ data: { viewer: { zones: [{
      byCategory: [{ count: 7, dimensions: { verifiedBotCategory: "AI Crawler" } }],
      agents: [{ count: 7, dimensions: { userAgent: "GPTBot/1.1", verifiedBotCategory: "AI Crawler" } }],
      aiPaths: [],
      byHost: [{ count: 7, dimensions: { clientRequestHTTPHost: zone.name } }],
    }] } } }));
  });
  vi.stubGlobal("fetch", fn);
  return seen;
}

// A different minute per case: the agent cache is keyed by a ten-minute bucket.
let clock = Date.UTC(2026, 9, 17, 0, 0, 0);
const tick = () => (clock += 3_600_000);

describe("fetchOverview edge", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never asks for a zone that hosts no registered site", async () => {
    const seen = cloudflare({});
    await fetchOverview(env, 7, tick());
    expect(seen.totalsIds.flat()).not.toContain(tagOf("foreign.example"));
    expect(seen.agentZones).not.toContain("foreign.example");
  });

  it("reports a thrown zone list as unread, never as 'every zone was read'", async () => {
    cloudflare({ zonesThrow: true });
    const r = await fetchOverview(env, 7, tick());
    if (!r.ok) throw new Error("overview failed");
    expect(r.overview.edge_available).toBe(false);
    expect(r.overview.agent_zones_read).toBe(0);
    expect(r.overview.agent_failures?.[0]?.unavailable).toContain("Network connection lost.");
  });

  it("names the zones of a refused totals batch and still asks them about agents", async () => {
    const seen = cloudflare({ failTotalsBatch: 1 });
    const r = await fetchOverview(env, 7, tick());
    if (!r.ok) throw new Error("overview failed");
    expect(r.overview.zone_failures?.length).toBeGreaterThan(0);
    const lost = new Set(r.overview.zone_failures?.map((f) => f.zone));
    expect(r.overview.coverage.some((c) => lost.has(c.zone))).toBe(false);
    // Totals and agents are separate questions: losing one does not skip the other.
    expect(new Set(seen.agentZones)).toEqual(new Set(families));
    expect(r.overview.agent_zones_read).toBe(families.length);
  });

  it("shows no number, not a zero, for a product whose zone could not be asked", async () => {
    cloudflare({ failAgentsFor: "visayes.app" });
    const r = await fetchOverview(env, 7, tick());
    if (!r.ok) throw new Error("overview failed");
    const row = r.overview.stats.sources.find((s) => s.source === "visaphoto" && s.platform === "web");
    expect(row?.ai_requests).toBeUndefined();
    expect(r.overview.agent_failures).toEqual([{ zone: "visayes.app", unavailable: "Cloudflare answered HTTP 500" }]);
  });

  it("asks about agents once per ten minutes, not once per window or tool", async () => {
    const seen = cloudflare({});
    const at = tick();
    await fetchOverview(env, 7, at);
    const first = seen.agentZones.length;
    await fetchOverview(env, 30, at + 60_000);
    expect(first).toBe(families.length);
    expect(seen.agentZones.length).toBe(first);
  });
});

describe("isReporting", () => {
  it("counts a server-side counter by its events, a web site by its page views", () => {
    expect(isReporting({ platform: "server", page_views: 0, events: 35 })).toBe(true);
    expect(isReporting({ platform: "web", page_views: 0, events: 35 })).toBe(false);
    expect(isReporting({ platform: "web", page_views: 4, events: 4 })).toBe(true);
    expect(isReporting({ platform: "ios", page_views: 0, events: 99 })).toBe(false);
  });
});
