/**
 * The generated list is checked against registry/sources.yaml by `make check`, which runs in
 * node and can read the file. These tests cover the other half: that the Worker-side lookup
 * behaves, and that the real ids the products use are actually in it.
 */
import { describe, expect, it } from "vitest";
import { SOURCE_IDS } from "../src/registry.generated";
import { isKnownSource } from "../src/registry";
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
