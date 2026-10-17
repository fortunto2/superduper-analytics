import { describe, expect, it } from "vitest";
import { formatAgentTraffic, formatCoverage } from "../src/edge-report";
import type { AgentTraffic } from "../src/agents";

const zoneWith = (zone: string, requests: number): AgentTraffic => ({
  zone,
  categories: [{ category: "AI Crawler", requests }],
  ai_requests: requests,
  agents: [{ agent: "GPTBot", operator: "OpenAI", category: "AI Crawler", requests }],
  ai_paths: [{ path: "/", requests }],
  by_host: [{ host: zone, requests }],
});

/**
 * The tool's whole job is to tell "nobody came" from "nobody was asked". Every case below is a
 * way the previous version said one when the truth was the other.
 */
describe("formatAgentTraffic", () => {
  it("is an error, not a finding, when no zone could be read", () => {
    const r = formatAgentTraffic({
      agents: [],
      failures: [{ zone: "(all zones)", unavailable: "GET /zones failed: Network connection lost." }],
      read: 0,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("NOT CHECKED");
    expect(r.text).toContain("Network connection lost.");
    expect(r.text).not.toContain("every registered zone was read");
  });

  it("keeps the zones that WERE read when only some failed", () => {
    const r = formatAgentTraffic({
      agents: [],
      failures: [{ zone: "you2idea.com", unavailable: "Cloudflare answered HTTP 429" }],
      read: 9,
    });
    expect(r.isError).toBe(false);
    expect(r.text).toContain("9 zone(s) read");
    expect(r.text).toContain("you2idea.com");
    expect(r.text).toContain("HTTP 429");
  });

  it("says 'every zone' only when nothing failed", () => {
    const r = formatAgentTraffic({ agents: [], failures: [], read: 10 });
    expect(r.text).toContain("all 10 registered zone(s) were read");
  });

  it("lists failures the same way whether or not agents were found", () => {
    const failure = { zone: "life2film.com", unavailable: "Cloudflare answered HTTP 500" };
    const withAgents = formatAgentTraffic({ agents: [zoneWith("visayes.app", 7)], failures: [failure], read: 9 });
    const without = formatAgentTraffic({ agents: [], failures: [failure], read: 9 });
    const line = "- life2film.com: Cloudflare answered HTTP 500";
    expect(withAgents.text).toContain(line);
    expect(without.text).toContain(line);
    expect(withAgents.text).toContain("7 requests");
    // no run of blank lines left by an empty spacer
    expect(withAgents.text).not.toMatch(/\n{3,}/);
  });
});

describe("formatCoverage", () => {
  it("names the zones whose totals failed instead of leaving them out", () => {
    const r = formatCoverage({
      days: 7,
      coverage: [{ zone: "visayes.app", sites: ["visaphoto"], edge_page_views: 900, edge_uniques: 300, our_page_views: 500, ratio: 0.5 }],
      failures: [{ zone: "life2film.com", unavailable: "daily analytics answered HTTP 500" }],
    });
    expect(r.text).toContain("visayes.app");
    expect(r.text).toContain("- life2film.com: daily analytics answered HTTP 500");
    expect(r.isError).toBe(false);
  });

  it("is an error with the reason when the edge could not be read at all", () => {
    const r = formatCoverage({
      days: 7,
      coverage: [],
      failures: [{ zone: "(all zones)", unavailable: "GET /zones answered HTTP 403" }],
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("HTTP 403");
  });
});
