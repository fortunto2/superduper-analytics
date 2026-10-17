/**
 * The AI-agent list, taken from a maintained public source rather than from memory.
 *
 * https://github.com/ai-robots-txt/ai.robots.txt is the community list behind most
 * `robots.txt` AI blocks. It carries ~160 agents with the operator behind each one, which is
 * also how Cloudflare's own dashboard groups them — Anthropic, OpenAI, Google, Meta.
 *
 * Fetched at BUILD time and committed, exactly like the source registry: the Worker never
 * makes this call, a clean checkout builds offline, and updating the list is a visible diff
 * that can be reviewed rather than a silent change in behaviour one morning.
 *
 * A hand-written list was here first. It had eighteen entries and no way to learn about the
 * nineteenth.
 */
import { z } from "zod/v4";

const SOURCE = "https://raw.githubusercontent.com/ai-robots-txt/ai.robots.txt/main/robots.json";

/** Only the two fields that are used; the source carries description and frequency too. */
const RobotsFile = z.record(
  z.string(),
  z.object({
    operator: z.string().optional(),
    function: z.string().optional(),
  }),
);

export type AgentEntry = { token: string; operator: string };

/**
 * The source writes operators as free prose with markdown links — "[Anthropic](https://…)",
 * or a whole sentence explaining what a company does. A dashboard column wants the name, so
 * take the first link text or the first clause and stop there.
 */
export function cleanOperator(raw: string): string {
  const linked = /\[([^\]]+)\]\([^)]*\)/.exec(raw);
  const text = (linked === null ? raw : linked[1]) ?? "";
  return text
    .replace(/Unclear at this time\.?/i, "")
    .split(/[,;.]| to | for | that /)[0]!
    .trim()
    .slice(0, 40);
}

export async function fetchAgents(): Promise<AgentEntry[]> {
  const response = await fetch(SOURCE);
  if (!response.ok) throw new Error(`${SOURCE} answered ${response.status}`);
  const parsed = RobotsFile.parse(await response.json());

  return Object.entries(parsed)
    .map(([token, meta]) => ({
      token,
      operator: cleanOperator(meta.operator ?? ""),
    }))
    // Longest first: "Claude-SearchBot" must win over "Claude", or every specific agent
    // collapses into whichever shorter token happens to match first.
    .sort((a, b) => b.token.length - a.token.length || a.token.localeCompare(b.token));
}

export function renderAgents(entries: AgentEntry[]): string {
  const rows = entries
    .map((e) => `  [${JSON.stringify(e.token)}, ${JSON.stringify(e.operator)}],`)
    .join("\n");
  return `// GENERATED FILE — DO NOT EDIT.
// Source: ${SOURCE}
// Refresh with \`make agents\`. Committed so the Worker never fetches it and a clean checkout
// builds offline; updating it is a reviewable diff rather than a silent behaviour change.
//
// Ordered longest token first, so "Claude-SearchBot" matches before "ClaudeBot" would.

/** [user-agent token, operator] — matched case-insensitively as a substring. */
export const AI_AGENTS: readonly (readonly [string, string])[] = [
${rows}
];
`;
}
