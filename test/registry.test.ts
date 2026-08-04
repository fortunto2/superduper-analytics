/**
 * The generated list is checked against registry/sources.yaml by `make check`, which runs in
 * node and can read the file. These tests cover the other half: that the Worker-side lookup
 * behaves, and that the real ids the products use are actually in it.
 */
import { describe, expect, it } from "vitest";
import { SOURCE_IDS } from "../src/registry.generated";
import { isKnownSource, isRegisteredOrigin } from "../src/registry";
import { SourceId } from "../src/schema";

describe("isKnownSource", () => {
  it("knows a site", () => {
    expect(isKnownSource("superduperai")).toBe(true);
  });

  it("knows an app that has no site", () => {
    expect(isKnownSource("photosweep")).toBe(true);
  });

  it("knows an id that is both a site and an app exactly once", () => {
    expect(isKnownSource("live2play")).toBe(true);
    expect(SOURCE_IDS.filter((id) => id === "live2play")).toHaveLength(1);
  });

  it("refuses anything else, including near misses", () => {
    for (const id of ["", "superduper", "superduperai ", "SuperDuperAI", "../superduperai"]) {
      expect(isKnownSource(id)).toBe(false);
    }
  });
});

describe("the generated list", () => {
  it("holds ids that would also pass event validation", () => {
    for (const id of SOURCE_IDS) expect(SourceId.safeParse(id).success).toBe(true);
  });

  it("is sorted and free of duplicates, so regenerating it produces no diff noise", () => {
    expect([...SOURCE_IDS]).toEqual([...new Set(SOURCE_IDS)].sort());
  });
});

describe("counting only what came from where the site actually lives", () => {
  it("accepts the registered host", () => {
    expect(isRegisteredOrigin("carettafriends", "https://app.carettafriends.com")).toBe(true);
  });

  it("rejects a preview deploy and a dev server — the traffic that is us, not visitors", () => {
    expect(isRegisteredOrigin("carettafriends", "https://abc123.caretta-app-site.pages.dev")).toBe(false);
    expect(isRegisteredOrigin("carettafriends", "http://localhost:4321")).toBe(false);
    expect(isRegisteredOrigin("carettafriends", "https://caretta.vercel.app")).toBe(false);
  });

  it("rejects the tag pasted on somebody else's site", () => {
    expect(isRegisteredOrigin("carettafriends", "https://not-ours.example")).toBe(false);
  });

  it("treats www and the bare host as the same place", () => {
    expect(isRegisteredOrigin("miralinka", "https://www.miralinka.com")).toBe(true);
  });

  it("fails OPEN when there is nothing to check against", () => {
    // No Origin at all — a mobile app flush, or a browser mode that withholds it.
    expect(isRegisteredOrigin("carettafriends", undefined)).toBe(true);
    expect(isRegisteredOrigin("carettafriends", "null")).toBe(true);
    // An app-only source has no registered site, so there is no host to compare.
    expect(isRegisteredOrigin("photosweep", "https://anywhere.example")).toBe(true);
    // Garbage in the header must not delete a real visit.
    expect(isRegisteredOrigin("carettafriends", "not a url")).toBe(true);
  });

  it("counts the default port as the same place and any other as a dev server", () => {
    // :443 on https is the site itself — URL drops it, and so should we.
    expect(isRegisteredOrigin("miralinka", "https://miralinka.com:443")).toBe(true);
    // A port somebody is serving a build on is not the site, even on the right hostname.
    expect(isRegisteredOrigin("miralinka", "http://miralinka.com:8080")).toBe(false);
  });
});
