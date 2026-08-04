/**
 * The dashboard is one big string, so nothing type-checks what it does. These tests stand in
 * for a compiler: they parse the script it ships and assert the rules that make a chart
 * readable rather than merely colourful.
 */
import { describe, expect, it } from "vitest";
import { DASHBOARD } from "../src/dashboard";

describe("the dashboard's own script", () => {
  it("parses — it is a string, and a chart is the easiest place to break one", () => {
    const js = DASHBOARD.slice(
      DASHBOARD.lastIndexOf("<script>") + 8,
      DASHBOARD.lastIndexOf("</script>"),
    );
    expect(() => new Function(js)).not.toThrow();
  });

  it("has no backtick anywhere in the page it ships", () => {
    // A backtick inside the template literal ends it mid-file. TypeScript then reports a
    // syntax error hundreds of lines away from the comment that caused it, which is exactly
    // how long it took to find the first time.
    expect(DASHBOARD).not.toContain("`");
  });

  it("draws series from a fixed palette rather than generating colours", () => {
    // A ninth series must fold into "other", never invent a hue: a generated colour lands
    // wherever it lands and the next one collides with it.
    expect(DASHBOARD).toContain("SERIES_CAP=8");
    expect(DASHBOARD).toContain("__other");
  });
});
