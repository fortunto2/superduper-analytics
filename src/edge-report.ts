/**
 * The words the MCP tools say about Cloudflare's side. Pure: no fetch, no env — the overview
 * has already decided what was read and what was not, and this only has to say it without
 * turning a failed read into a finding.
 *
 * Kept out of mcp.ts so it can be tested on its own. Every false green this project has shipped
 * about the edge lived in prose like this, inside a handler too long to test.
 */
import type { AgentFailure, AgentTraffic } from "./agents";
import type { Coverage } from "./overview";
import type { ZoneFailure } from "./zones";

export type ToolReport = { text: string; isError: boolean };

/** One format for every list of unread zones, so the two tools never disagree on it. */
export function failureLines(failures: ZoneFailure[]): string[] {
  return failures.map((f) => `- ${f.zone}: ${f.unavailable}`);
}

const why = (c: string) =>
  c === "AI Assistant" ? "answering someone" : c === "AI Search" ? "search result" : "indexing";

/**
 * Three answers, and only one of them is good news:
 *   nothing could be read      → NOT CHECKED, an error, the reasons
 *   some zones read, no agents → "none on the N zones read", plus which were not read
 *   agents found               → the agents, plus which zones were not read
 */
export function formatAgentTraffic(input: {
  agents: AgentTraffic[];
  failures: AgentFailure[];
  read: number;
}): ToolReport {
  const { agents, failures, read } = input;
  const notRead =
    failures.length > 0
      ? [`NOT READ — ${failures.length} zone(s) could not be asked:`, ...failureLines(failures)]
      : [];

  if (read === 0) {
    return {
      isError: true,
      text: [
        'NOT CHECKED — no zone could be read, so "no agents" is not a finding here.',
        "",
        ...failureLines(failures),
      ].join("\n"),
    };
  }

  if (agents.length === 0) {
    const scope =
      failures.length === 0
        ? `all ${read} registered zone(s) were read`
        : `${read} zone(s) read; the rest could not be asked`;
    return {
      isError: false,
      text: [
        `No verified AI agent traffic in the last 24 hours (${scope}).`,
        ...(notRead.length > 0 ? ["", ...notRead] : []),
      ].join("\n"),
    };
  }

  // Каждая зона отдельным блоком: складывать их в один список значило бы потерять ответ на
  // вопрос «кто читает ЭТОТ сайт», ради которого сюда и смотрят.
  const total = agents.reduce((sum, z) => sum + z.ai_requests, 0);
  const blocks = agents.map((z) =>
    [
      `## ${z.zone} — ${z.ai_requests} requests`,
      ...z.agents.map(
        (a) => `- ${a.agent}${a.operator ? ` (${a.operator})` : ""} — ${why(a.category)} — ${a.requests}`,
      ),
      ...(z.ai_paths.length > 0
        ? [`They read: ${z.ai_paths.slice(0, 6).map((p) => `${p.path} (${p.requests})`).join(", ")}`]
        : []),
    ].join("\n"),
  );

  return {
    isError: false,
    text: [
      `Last 24 hours — ${total} requests from verified AI agents on ${agents.length} of ` +
        `${read} zone(s) read.`,
      ...blocks,
      ...(notRead.length > 0 ? [notRead.join("\n")] : []),
      "Verified by Cloudflare against each operator's own IP ranges, so a script cannot " +
        "appear here by calling itself ClaudeBot. 24 hours is the widest window this " +
        "dataset allows on the free plan.",
    ].join("\n\n"),
  };
}

export function formatCoverage(input: {
  days: number;
  coverage: Coverage[];
  failures: ZoneFailure[];
}): ToolReport {
  const { days, coverage, failures } = input;
  const rows = coverage.map(
    (c) =>
      `- ${c.zone} — edge ${c.edge_page_views} (all traffic), ours ` +
      `${c.our_page_views} (browsers) — ${c.our_page_views > 0 ? "reporting" : "NO COUNTER"}` +
      ` — covers ${c.sites.join(", ")}`,
  );
  const unavailable = rows.length === 0;
  return {
    isError: unavailable,
    text: [
      `Last ${days} day(s), by domain.`,
      "",
      ...(unavailable ? ["Cloudflare edge data unavailable:", ...failureLines(failures)] : rows),
      ...(!unavailable && failures.length > 0
        ? ["", "NOT READ — missing from the rows above, not empty:", ...failureLines(failures)]
        : []),
      "",
      "The two figures are different populations and their ratio means nothing — on one " +
        "measured domain 86% of edge traffic was curl and unidentified scrapers against " +
        "~12% real browsers. Read each row as installed or not installed.",
    ].join("\n"),
  };
}
