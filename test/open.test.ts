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

  it("publishes exactly the sites the registry marks, and no others", () => {
    expect(SITES.filter((s) => s.open).map((s) => s.id).sort()).toEqual([
      "life2film",
      "live2play",
      "superduperai",
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
    const body = (await res.json()) as { domains: unknown[]; source: string };
    expect(body.source).toBe("cloudflare-edge");
    expect(Array.isArray(body.domains)).toBe(true);
  });

  it("reports a shared domain once, naming every product on it", async () => {
    // superduperai and live2play are one Cloudflare zone. Two rows would double-count the
    // traffic; one row labelled with either product alone would misattribute it.
    const body = (await (await SELF.fetch("https://analytics.example/open.json")).json()) as {
      domains: { domain: string; covers: { id: string }[] }[];
    };
    const domains = body.domains.map((d) => d.domain);
    expect(new Set(domains).size).toBe(domains.length);
    const shared = body.domains.find((d) => d.domain === "superduperai.co");
    if (shared !== undefined) {
      expect(shared.covers.map((c) => c.id).sort()).toEqual(["live2play", "superduperai"]);
    }
  });

  it("does not open a back door into the keyed aggregate", async () => {
    // /open must never become a way to read what /v1/* refuses to show.
    expect((await SELF.fetch("https://analytics.example/v1/overview")).status).toBe(401);
    expect((await SELF.fetch("https://analytics.example/")).status).toBe(404);
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
