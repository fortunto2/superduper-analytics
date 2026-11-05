import { describe, expect, it } from "vitest";
import { truthFindings, truthSummary, type TruthInput } from "../src/truth";

const clean: TruthInput = {
  today: "2026-11-04",
  search: [
    { site: "superduperai", clicks: 35, impressions: 1166 },
    { site: "life2film", clicks: 99, impressions: 3882 },
  ],
  syncs: [{ provider: "appstore-downloads", source: "life2film", through: "2026-11-03", ran: "2026-11-04", note: "" }],
  pages: [
    { source: "life2film", provider: "own", views: 600 },
    { source: "life2film", provider: "ga4", views: 640 },
  ],
  people: [...Array(14).keys()].map((i) => ({ source: "rustman", day: `2026-10-${String(15 + i).padStart(2, "0")}`, people: 20 })),
};

const rules = (input: TruthInput) => truthFindings(input).map((f) => f.rule);

describe("does the data lie", () => {
  it("finds nothing in data that is fine — a sensor that always fires is ignored", () => {
    expect(truthFindings(clean)).toEqual([]);
  });

  it("calls equal search totals on two sites a copy (4 Nov 2026: four sites at 35/1166)", () => {
    const input = { ...clean, search: [...clean.search, { site: "live2play", clicks: 35, impressions: 1166 }] };
    expect(truthFindings(input)).toMatchObject([{ rule: "search-copy", subject: "live2play, superduperai" }]);
  });

  it("does not call two nearly dead sites a copy", () => {
    const input = { ...clean, search: [{ site: "a", clicks: 0, impressions: 2 }, { site: "b", clicks: 0, impressions: 2 }] };
    expect(rules(input)).toEqual([]);
  });

  it("reports an error note once per distinct note, not once per source", () => {
    const note = "driveandblock: Error: ASC /apps/6759738953/analyticsReportRequests?limit=50: 403 FORBIDDEN_ERROR";
    const input = {
      ...clean,
      syncs: ["life2film", "starlapse", "facealarm"].map((source) => ({
        provider: "appstore-downloads", source, through: "2026-11-03", ran: "2026-11-04", note,
      })),
    };
    expect(rules(input)).toEqual(["sync-error"]);
  });

  it("ignores notes from runs that are not current — those are history, not state", () => {
    const input = {
      ...clean,
      syncs: [{ provider: "appstore-analytics", source: "photosweep", through: "2026-08-23", ran: "2026-09-27", note: "403 FORBIDDEN" }],
    };
    expect(rules(input)).toEqual([]);
  });

  it("calls a sync stuck when it ran today and its data did not move (live2play, Oct 2026)", () => {
    const input = {
      ...clean,
      syncs: [{ provider: "appstore-analytics", source: "live2play", through: "2026-10-08", ran: "2026-11-04", note: "" }],
    };
    expect(truthFindings(input)).toMatchObject([{ rule: "sync-stuck", subject: "appstore-analytics live2play" }]);
  });

  it("flags our counter and GA4 apart by more than a factor of two, and only then", () => {
    const at = (own: number, ga4: number) => rules({
      ...clean,
      pages: [{ source: "s", provider: "own", views: own }, { source: "s", provider: "ga4", views: ga4 }],
    });
    expect(at(260, 100)).toEqual(["two-counters"]);
    expect(at(40, 100)).toEqual(["two-counters"]);
    expect(at(190, 100)).toEqual([]);
    // A site without GA4 is not a gap: there is nothing to compare against.
    expect(at(500, 0)).toEqual([]);
  });

  it("calls a burst of people a spike until someone looks (Lightpanda on airsignal.app)", () => {
    const input = { ...clean, people: [...clean.people, { source: "rustman", day: "2026-11-03", people: 400 }] };
    expect(truthFindings(input)).toMatchObject([{ rule: "spike", subject: "rustman 2026-11-03" }]);
  });

  it("does not call a small site's good day a spike", () => {
    const quiet = clean.people.map((p) => ({ ...p, people: 1 }));
    expect(rules({ ...clean, people: [...quiet, { source: "rustman", day: "2026-11-03", people: 8 }] })).toEqual([]);
  });

  it("ends on a line with a number for every rule, which is what the harness stamps", () => {
    expect(truthSummary(clean, [])).toBe(
      "truth: 3 sites read, 0 search copies, 0 sync errors, 0 stuck syncs, 0 counter gaps, 0 spikes",
    );
  });
});
