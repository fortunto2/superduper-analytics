/**
 * The open page publishes real numbers to the open internet, so the tests that matter are the
 * ones about what must NOT appear on it.
 */
import { SELF } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OPEN_PAGE, buildOpenReport } from "../src/open";
import { SITES } from "../src/registry.generated";

/**
 * Spelled out rather than derived from the registry on purpose: publishing a product must be
 * two deliberate edits, so a stray `public: true` cannot reach the open internet on the
 * strength of one. Adding a name here is the second half of that decision.
 */
const PUBLISHED = ["agentboard", "airsignal", "life2film", "live2play", "superduperai", "visaphoto"];

describe("what may be published", () => {
  it("is opt-in: most registered sites are not public", () => {
    const open = SITES.filter((s) => s.open);
    expect(open.length).toBeGreaterThan(0);
    expect(open.length).toBeLessThan(SITES.length);
  });

  it("publishes exactly the sites the registry marks, and no others", () => {
    expect(SITES.filter((s) => s.open).map((s) => s.id).sort()).toEqual(PUBLISHED);
  });
});

describe("the public routes", () => {
  it("serves /open without a key", async () => {
    const res = await SELF.fetch("https://analytics.example/open");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("public");
  });

  it("serves /open.json without a key, readable from any origin", async () => {
    const res = await SELF.fetch("https://analytics.example/open.json");
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    const body = (await res.json()) as { products: unknown[]; source: string };
    // Named, so a reader never has to guess whose arithmetic produced the numbers.
    expect(body.source).toBe("own-counter");
    expect(Array.isArray(body.products)).toBe(true);
  });

  it("publishes a row per PRODUCT, which the edge could never do", async () => {
    // superduperai and live2play share one Cloudflare zone, so an edge-based page had to
    // publish the domain and list both under it. Our own counter knows which is which, and
    // "a row is a product" is what a reader expects from a page called Open numbers.
    const body = (await (await SELF.fetch("https://analytics.example/open.json")).json()) as {
      products: { id: string }[];
    };
    const ids = body.products.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    // Only those flagged `public: true` may ever appear here.
    for (const id of ids) expect(PUBLISHED).toContain(id);
  });

  it("marks people as a floor whenever the window was sampled", async () => {
    const body = (await (await SELF.fetch("https://analytics.example/open.json")).json()) as {
      sampled: boolean;
    };
    // The flag must exist either way: a page that silently drops it publishes a lower bound
    // as if it were a count.
    expect(typeof body.sampled).toBe("boolean");
  });

  it("does not open a back door into the keyed aggregate", async () => {
    // /open must never become a way to read what /v1/* refuses to show.
    expect((await SELF.fetch("https://analytics.example/v1/overview")).status).toBe(401);
    expect((await SELF.fetch("https://analytics.example/dashboard")).status).toBe(404);
  });

  it("never names a private source anywhere in the page", async () => {
    const body = await (await SELF.fetch("https://analytics.example/open.json")).text();
    for (const site of SITES.filter((s) => !s.open)) {
      expect(body).not.toContain(`"${site.id}"`);
    }
  });
});

describe("the page itself", () => {
  it("states where the numbers come from, so nobody reads them as our own counter", () => {
    expect(OPEN_PAGE).toContain("Cloudflare");
    expect(OPEN_PAGE).toContain("public: true");
  });

  it("carries no analytics of its own — publishing numbers must not collect any", () => {
    expect(OPEN_PAGE).not.toContain("sda.js");
    expect(OPEN_PAGE).not.toMatch(/googletagmanager|gtag/);
  });
});

describe("the page's own script", () => {
  /** Everything between the last <script> and </script> — what the browser actually parses. */
  const inlineScript = (html: string) =>
    html.slice(html.lastIndexOf("<script>") + 8, html.lastIndexOf("</script>"));

  it("parses — it is a string, so nothing else would catch a typo", () => {
    // This test exists because a regex written as /^https?:\/\// inside the template literal
    // shipped as /^https?:/// — the backslashes collapse before a browser sees them — and took
    // the whole public page down with "missing ) after argument list". Nothing caught it: the
    // types were fine, the tests were fine, and the page 200s while rendering nothing.
    expect(() => new Function(inlineScript(OPEN_PAGE))).not.toThrow();
  });

  it("contains no backslashes at all, which is the only rule that makes that safe", () => {
    // Cheaper and stricter than reasoning about which escapes survive: forbid them outright.
    expect(inlineScript(OPEN_PAGE)).not.toContain("\\");
  });
});

/**
 * A zone that could not be read must never be published as "0 AI agents". On a page whose
 * whole claim is that the numbers are not massaged, a zero is a statement of fact.
 */
describe("buildOpenReport with Cloudflare partly down", () => {
  afterEach(() => vi.unstubAllGlobals());
  const env = { DATASET: "superduper_events", CF_ACCOUNT_ID: "acc", CF_API_TOKEN: "tok" };
  const sql = () =>
    new Response(JSON.stringify({ data: [
      { source: "visaphoto", platform: "web", events: 9, page_views: 5, engaged: 4, people_raw: 3 },
      { source: "life2film", platform: "web", events: 9, page_views: 4, engaged: 2, people_raw: 2 },
      { source: "rustman", platform: "web", events: 9, page_views: 9, engaged: 1, people_raw: 2 },
    ] }));

  it("publishes only public products, and no agent number when the zone list failed", async () => {
    vi.stubGlobal("fetch", vi.fn(async (url: string) =>
      url.includes("/analytics_engine/sql") ? sql() : new Response("denied", { status: 403 })));
    const report = await buildOpenReport(env, 7, Date.UTC(2026, 9, 17, 3));
    const ids = report.products.map((p) => p.id);
    expect(ids).toContain("visaphoto");
    expect(ids).not.toContain("rustman");
    for (const p of report.products) expect(p.ai_requests).toBeNull();
    expect(report.ai_agents).toBeUndefined();
  });

  it("marks the agent total as a floor and blanks the product whose zone failed", async () => {
    const zones = [{ id: "v", name: "visayes.app" }, { id: "l", name: "life2film.com" }];
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      if (url.includes("/analytics_engine/sql")) return sql();
      if (url.includes("/zones")) {
        return new Response(JSON.stringify({ success: true, result: zones, result_info: { total_pages: 1 } }));
      }
      const tag = JSON.parse(String(init?.body)).variables.zone;
      if (tag === "v") return new Response("nope", { status: 500 });
      return new Response(JSON.stringify({ data: { viewer: { zones: [{
        byCategory: [{ count: 4, dimensions: { verifiedBotCategory: "AI Crawler" } }],
        agents: [{ count: 4, dimensions: { userAgent: "GPTBot/1.1", verifiedBotCategory: "AI Crawler" } }],
        aiPaths: [],
        byHost: [{ count: 4, dimensions: { clientRequestHTTPHost: "life2film.com" } }],
      }] } } }));
    }));
    const report = await buildOpenReport(env, 7, Date.UTC(2026, 9, 17, 5));
    const byId = Object.fromEntries(report.products.map((p) => [p.id, p.ai_requests]));
    expect(byId.visaphoto).toBeNull();
    expect(byId.life2film).toBe(4);
    expect(report.ai_agents?.incomplete).toBe(true);
    expect(report.ai_agents?.requests).toBe(4);
  });
});
