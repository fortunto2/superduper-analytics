/**
 * Who reads these sites that is not a person.
 *
 * A site now has two audiences and they arrive through different doors:
 *
 *   1. AGENTS READING THE SITE — GPTBot, ClaudeBot, PerplexityBot and the rest. They fetch
 *      HTML and do NOT run JavaScript, so `/sda.js` never executes and our own pipeline is
 *      blind to them by construction. Only Cloudflare's edge sees them, and it classifies
 *      them: `verifiedBotCategory` separates "AI Crawler" from "Search Engine Crawler",
 *      "Search Engine Optimization" and "Monitoring & Analytics".
 *
 *   2. PEOPLE ARRIVING FROM AN AI ANSWER — somebody asked a question, got a link, clicked it.
 *      That is a real browser with `chatgpt.com` or `perplexity.ai` as its referrer, and we
 *      already record it in `referrer_host`. See stats.ts — it needs no new collection at all.
 *
 * The second is the one that pays. The first says whether you are in the index at all.
 *
 * Agents ARE named, but not by the dimension you would reach for: `userAgentBrowser` is
 * "Unknown" for every one of them. The raw `userAgent` dimension carries the real string, and
 * `verifiedBotCategory` filters it down to the ones Cloudflare has verified by IP — which is
 * what stops any script from calling itself ClaudeBot and appearing here.
 *
 * ONE LIMIT, from the Free plan and stated rather than hidden: this dataset accepts a window
 * of at most ONE DAY. There is no weekly agent view.
 */
import { AI_AGENTS } from "./agents.generated";
import { type Zone, type ZoneFailure, type ZonesEnv } from "./zones";

const GRAPHQL = "https://api.cloudflare.com/client/v4/graphql";

/** The Free plan refuses anything wider. */
export const AGENT_WINDOW_HOURS = 24;

/**
 * Cloudflare splits AI traffic three ways, and the split is the interesting part:
 *
 *   AI Crawler   — building an index or a training set. Your content is being read.
 *   AI Search    — answering a search query right now.
 *   AI Assistant — a person asked a question and the assistant is fetching this page to
 *                  answer it. This is demand, not scraping, and it is the one that pays.
 *
 * All three are AI traffic; only the first is a crawler. Counting just "AI Crawler" as "AI"
 * would drop exactly the requests that represent a human being interested.
 */
export const AI_CATEGORIES = ["AI Crawler", "AI Search", "AI Assistant"] as const;

export type AgentTraffic = {
  zone: string;
  /** Cloudflare's `verifiedBotCategory`, blank category dropped — it means "not verified". */
  categories: { category: string; requests: number }[];
  ai_requests: number;
  /** Named AI agents, most active first. */
  agents: { agent: string; operator: string; category: string; requests: number }[];
  /** What the AI crawlers actually read, most-read first. */
  ai_paths: { path: string; requests: number }[];
  /**
   * Requests per hostname — which is what makes agents a PER-PRODUCT number instead of a
   * per-zone one. Six products share the superduperai.co zone, but each sits on its own
   * subdomain, so Cloudflare can tell them apart even though the zone cannot.
   */
  by_host: { host: string; requests: number }[];
};

/** The list, lower-cased once rather than on every comparison of every lookup. */
const AGENTS_LOWER = AI_AGENTS.map(([token, operator]) => [token.toLowerCase(), token, operator] as const);

/**
 * Named from the generated list of agents from ai.robots.txt, refreshed by `make agents`.
 * Only reached for requests Cloudflare has already verified as an AI crawler, so this names a
 * known caller rather than trusting one: a script claiming to be ClaudeBot never gets here.
 *
 * The list is ordered longest token first, so "Claude-SearchBot" is not swallowed by a
 * shorter match.
 */
export function agentName(userAgent: string): { agent: string; operator: string } {
  const ua = userAgent.toLowerCase();
  for (const [lower, token, operator] of AGENTS_LOWER) {
    if (ua.includes(lower)) return { agent: token, operator };
  }
  // Verified as an AI crawler but absent from the public list — named by its browser token so
  // it can be recognised and reported upstream, rather than silently dropped.
  const version = /(?:Chrome|Firefox|Safari)\/[\d.]+/.exec(userAgent);
  return { agent: version === null ? "unlisted agent" : `unlisted (${version[0]})`, operator: "" };
}

const QUERY = `query($zone:String!,$since:Time!,$until:Time!,$ai:[string!]){viewer{zones(filter:{zoneTag:$zone}){
  byCategory: httpRequestsAdaptiveGroups(limit:20,filter:{datetime_geq:$since,datetime_leq:$until},orderBy:[count_DESC]){
    count dimensions{verifiedBotCategory}
  }
  agents: httpRequestsAdaptiveGroups(limit:60,filter:{datetime_geq:$since,datetime_leq:$until,verifiedBotCategory_in:$ai},orderBy:[count_DESC]){
    count dimensions{userAgent verifiedBotCategory}
  }
  aiPaths: httpRequestsAdaptiveGroups(limit:12,filter:{datetime_geq:$since,datetime_leq:$until,verifiedBotCategory_in:$ai},orderBy:[count_DESC]){
    count dimensions{clientRequestPath}
  }
  byHost: httpRequestsAdaptiveGroups(limit:30,filter:{datetime_geq:$since,datetime_leq:$until,verifiedBotCategory_in:$ai},orderBy:[count_DESC]){
    count dimensions{clientRequestHTTPHost}
  }
}}}`;

type Group = { count?: number; dimensions?: Record<string, string> };

/**
 * Why a failure is a value here rather than an `undefined`.
 *
 * Every path out of this function used to be `return undefined`: no token, a refused request,
 * a GraphQL error, an empty node. The caller then filtered undefined away and the MCP tool
 * printed "No verified AI agent traffic in the last 24 hours" — a sentence about the agents
 * that was really a sentence about the query. Measured on 6 Sep 2026: Cloudflare held 198
 * AI Crawler, 7 AI Assistant and 4 AI Search requests for visayes.app on that very window,
 * and the tool reported none. The reason has to survive the return.
 */
export type AgentFailure = ZoneFailure;
export type AgentResult = AgentTraffic | AgentFailure;

export function isAgentFailure(result: AgentResult): result is AgentFailure {
  return "unavailable" in result;
}

/**
 * One zone per call — the dataset takes a single zoneTag, unlike the daily one. Callers should
 * ask only for zones they will show, since each is a subrequest.
 *
 * Never rejects. A thrown fetch or a non-JSON body used to escape as an exception while an
 * HTTP error came back as a value, so every caller grew its own catch and each one turned
 * the failure into something different — a value in one place, a silent zero in another.
 */
export async function fetchAgentTraffic(
  env: ZonesEnv,
  zone: Zone,
  now: number,
): Promise<AgentResult> {
  const failed = (unavailable: string): AgentFailure => ({ zone: zone.name, unavailable });
  if (env.CF_API_TOKEN === undefined) return failed("CF_API_TOKEN is not set on this Worker");
  try {
    return await readAgentTraffic(env, zone, now, failed);
  } catch (err) {
    return failed(err instanceof Error ? err.message : String(err));
  }
}

async function readAgentTraffic(
  env: ZonesEnv,
  zone: Zone,
  now: number,
  failed: (unavailable: string) => AgentFailure,
): Promise<AgentResult> {
  const response = await fetch(GRAPHQL, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        zone: zone.tag,
        since: new Date(now - AGENT_WINDOW_HOURS * 3_600_000).toISOString(),
        until: new Date(now).toISOString(),
        ai: AI_CATEGORIES,
      },
    }),
  });
  if (!response.ok) return failed(`Cloudflare answered HTTP ${response.status}`);

  const reply = (await response.json()) as {
    errors?: unknown[];
    data?: { viewer?: { zones?: { byCategory?: Group[]; agents?: Group[]; aiPaths?: Group[]; byHost?: Group[] }[] } };
  };
  if (Array.isArray(reply.errors) && reply.errors.length > 0) {
    const first = reply.errors[0] as { message?: string };
    return failed(first?.message ?? "GraphQL error without a message");
  }

  const node = reply.data?.viewer?.zones?.[0];
  if (node === undefined) return failed("the zone returned no node — check the token's zone scope");

  const categories = (node.byCategory ?? [])
    // An empty category is "Cloudflare did not verify this", i.e. the ordinary web plus every
    // scraper that does not announce itself. Counting it as a category would be a lie.
    .filter((g) => (g.dimensions?.verifiedBotCategory ?? "") !== "")
    .map((g) => ({ category: g.dimensions?.verifiedBotCategory ?? "", requests: g.count ?? 0 }));

  // Several user-agent strings map to one agent — a version bump alone makes a new string —
  // so they are folded by name before being shown.
  const byAgent = new Map<
    string,
    { agent: string; operator: string; category: string; requests: number }
  >();
  for (const group of node.agents ?? []) {
    const raw = group.dimensions?.userAgent;
    if (raw === undefined || raw === "") continue;
    const { agent, operator } = agentName(raw);
    const category = group.dimensions?.verifiedBotCategory ?? "";
    const seen = byAgent.get(agent);
    if (seen === undefined) byAgent.set(agent, { agent, operator, category, requests: group.count ?? 0 });
    else seen.requests += group.count ?? 0;
  }

  return {
    zone: zone.name,
    categories,
    ai_requests: categories
      .filter((c) => (AI_CATEGORIES as readonly string[]).includes(c.category))
      .reduce((sum, c) => sum + c.requests, 0),
    agents: [...byAgent.values()].sort((a, b) => b.requests - a.requests),
    ai_paths: (node.aiPaths ?? []).map((g) => ({
      path: g.dimensions?.clientRequestPath ?? "",
      requests: g.count ?? 0,
    })),
    by_host: (node.byHost ?? [])
      .map((g) => ({ host: (g.dimensions?.clientRequestHTTPHost ?? "").toLowerCase(), requests: g.count ?? 0 }))
      .filter((h) => h.host !== "")
      .sort((a, b) => b.requests - a.requests),
  };
}

/** How long one answer about the last 24 hours is reused. */
const AGENT_CACHE_SECONDS = 600;

/**
 * Agent traffic for several zones, through one shared cache entry.
 *
 * The window is the last 24 hours whatever `days` the caller is looking at, yet every
 * overview used to re-ask it: each of eight MCP tools and each of the dashboard's five window
 * buttons sent one GraphQL query per zone — ten a call — against a quota of 300 per five
 * minutes, and a throttled reply looks exactly like a quiet zone. One cache entry costs two
 * subrequests instead of ten. Only complete answers are cached: a failure must be retried, not
 * remembered for ten minutes.
 */
export async function fetchAgentsForZones(
  env: ZonesEnv,
  zones: Zone[],
  now: number,
): Promise<AgentResult[]> {
  if (zones.length === 0) return [];
  const bucket = Math.floor(now / (AGENT_CACHE_SECONDS * 1000));
  const tags = zones.map((z) => z.tag).sort().join(",");
  const key = new Request(`https://agents.cache.invalid/v1?zones=${tags}&t=${bucket}`);
  const cache = typeof caches === "undefined" ? undefined : caches.default;

  const hit = await cache?.match(key).catch(() => undefined);
  if (hit !== undefined) return (await hit.json()) as AgentResult[];

  const results = await Promise.all(zones.map((zone) => fetchAgentTraffic(env, zone, now)));
  if (cache !== undefined && !results.some(isAgentFailure)) {
    await cache
      .put(key, new Response(JSON.stringify(results), {
        headers: { "cache-control": `max-age=${AGENT_CACHE_SECONDS}` },
      }))
      .catch(() => undefined);
  }
  return results;
}
