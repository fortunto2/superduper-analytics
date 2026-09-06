/**
 * The open page publishes real numbers to the open internet, so the tests that matter are the
 * ones about what must NOT appear on it.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { OPEN_PAGE } from "../src/open";
import { SITES } from "../src/registry.generated";

describe("what may be published", () => {
  it("is opt-in: most registered sites are not public", () => {
    const open = SITES.filter((s) => s.open);
    expect(open.length).toBeGreaterThan(0);
    expect(open.length).toBeLessThan(SITES.length);
  });

  /**
   * The list is spelled out rather than derived from the registry on purpose: publishing a
   * product must be two deliberate edits, so a stray `public: true` cannot reach the open
   * internet on the strength of one. Adding a name here is the second half of that decision.
   */
  it("publishes exactly the sites the registry marks, and no others", () => {
    expect(SITES.filter((s) => s.open).map((s) => s.id).sort()).toEqual([
      "agentboard",
      "airsignal",
      "life2film",
      "live2play",
      "superduperai",
      "visaphoto",
    ]);
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
    for (const id of ids)
      expect(["superduperai", "live2play", "life2film", "visaphoto", "airsignal", "agentboard"]).toContain(id);
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
