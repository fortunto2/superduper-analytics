/**
 * The analytics, as tools an agent can call. POST /mcp.
 *
 * The dashboard answers "how are my products doing" for a person looking at a screen. This
 * answers the same question for an agent that has been asked to evaluate them — which product
 * is growing, which has a counter that stopped, which is read by AI assistants and which by
 * nobody. That is a different job from rendering a page, and it wants a different interface.
 *
 * WHAT IT REFUSES TO DO
 *
 * Every tool here answers with the same numbers the dashboard shows, bots excluded from people
 * and page views and reported separately. There is no "estimate", no smoothing and no filling
 * of gaps: when Analytics Engine sampled, the payload says so and the people figure is labelled
 * a lower bound. An agent asked to compare products must be able to tell a small number from an
 * unreliable one, and that is only possible if the server never rounds the difference away.
 *
 * AUTH
 *
 * The same DASHBOARD_KEY as the rest of the read side, as a bearer token — the MCP convention.
 * These are business numbers; an unauthenticated MCP server would publish them to anyone who
 * guessed the URL. /open.json remains the deliberately public subset.
 *
 * TRANSPORT
 *
 * Streamable HTTP, stateless, answering application/json. The spec permits a plain JSON reply
 * instead of opening an SSE stream, and with no session state a stream would carry nothing.
 */
import { SITES, SOURCE_IDS } from "./registry.generated";
import { fetchOverview, type OverviewEnv } from "./overview";
import { RETENTION_DAYS } from "./schema";

const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26"];
const LATEST = SUPPORTED_VERSIONS[0]!;
const SERVER = { name: "superduper-analytics", title: "superduper analytics", version: "1.0.0" };

type JsonRpc = { jsonrpc: string; id?: unknown; method?: string; params?: Record<string, unknown> };

export type McpEnv = OverviewEnv & { DASHBOARD_KEY?: string };

const DAYS_PROPERTY = {
  type: "integer",
  minimum: 1,
  maximum: RETENTION_DAYS,
  description: `Window in days, 1..${RETENTION_DAYS}. The hot store keeps no more than that.`,
};

const TOOLS = [
  {
    name: "list_products",
    title: "List every registered product",
    description:
      "Every site and app that may report events, from the git registry. Says which have a " +
      "counter installed and which do not — a product with no counter is invisible to every " +
      "other tool here, so check this before concluding that something has no traffic.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "traffic",
    title: "Traffic per product",
    description:
      "People, page views and bot volume for every product over a window. People and page " +
      "views exclude anything classified as a bot; bot volume is reported separately rather " +
      "than dropped. People is a LOWER BOUND when sampling was active — the payload says when.",
    inputSchema: { type: "object", properties: { days: DAYS_PROPERTY } },
  },
  {
    name: "campaigns",
    title: "What each campaign brought",
    description:
      "Visits, engaged visits and store-button clicks for every campaign tag seen in the " +
      "window — one row per utm_campaign. This is OUR half of the funnel and it stops at the " +
      "store click; installs and revenue live in App Store Connect and join back by the same " +
      "tag, never by an identifier. A row whose visits are zero while bots are not is a link " +
      "that got scraped rather than clicked, not a broken tag. Empty until something is tagged.",
    inputSchema: { type: "object", properties: { days: DAYS_PROPERTY } },
  },
  {
    name: "content",
    title: "Where visitors came from and what they read",
    description:
      "Three breakdowns for a window: referrer hosts (where visits came from), paths (what was " +
      "read) and countries, all bot-filtered. Country comes from Cloudflare's edge, never the " +
      "browser, and stops at country: a city would identify people on a site this size. Direct visits carry no referrer and are absent from the " +
      "first list by definition — their absence is not a gap. Only the referrer HOST is kept, " +
      "never the full URL, so search queries and other sites' tokens never enter the store.",
    inputSchema: { type: "object", properties: { days: DAYS_PROPERTY } },
  },
  {
    name: "agent_traffic",
    title: "Which AI agents read the sites",
    description:
      "Named AI agents that fetched the busiest zone in the last 24 hours, with the operator " +
      "behind each and why it came. The distinction matters: an AI Assistant fetch means a " +
      "person asked a question right now, an AI Crawler is building an index. These never " +
      "appear in `traffic` — agents do not run JavaScript, so the counter never sees them.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "counter_coverage",
    title: "Which counters are actually reporting",
    description:
      "Cloudflare's edge traffic beside our own, per domain. Answers 'is this product quiet or " +
      "is its counter broken', which no single number can. The two columns are different " +
      "populations — the edge counts scrapers, we count browsers — so never divide one by the " +
      "other; read it as installed or not.",
    inputSchema: { type: "object", properties: { days: DAYS_PROPERTY } },
  },
];

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type, authorization, mcp-protocol-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const json = (body: unknown, status = 200, version = LATEST): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", "MCP-Protocol-Version": version, ...cors },
  });

const rpcError = (id: unknown, code: number, message: string, version: string): Response =>
  json({ jsonrpc: "2.0", id: id ?? null, error: { code, message } }, 200, version);

const toolText = (id: unknown, text: string, version: string, isError = false): Response =>
  json({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text }], isError } }, 200, version);

const windowDays = (args: Record<string, unknown>): number => {
  const asked = Number(args.days ?? 7);
  if (!Number.isInteger(asked) || asked < 1) return 7;
  return Math.min(asked, RETENTION_DAYS);
};

export async function handleMcp(request: Request, env: McpEnv, now: number): Promise<Response> {
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (request.method !== "POST") {
    // A GET is where a stateful server opens its SSE stream. This one has no session state.
    return json({ error: "POST-only; this MCP server is stateless and opens no stream." }, 405);
  }

  const asked = request.headers.get("mcp-protocol-version");
  const version = asked ?? "2025-03-26";
  if (!SUPPORTED_VERSIONS.includes(version)) {
    return json({ error: `Unsupported MCP-Protocol-Version: ${version}` }, 400);
  }

  const expected = env.DASHBOARD_KEY;
  const given = request.headers.get("authorization")?.replace(/^Bearer /i, "");
  if (expected === undefined || expected === "" || given !== expected) {
    // 401 with WWW-Authenticate is what an MCP client expects when it must present a token.
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json", "WWW-Authenticate": "Bearer", ...cors },
    });
  }

  let message: JsonRpc;
  try {
    message = (await request.json()) as JsonRpc;
  } catch {
    return rpcError(null, -32700, "Parse error", version);
  }

  const { id, method, params } = message;
  if (id === undefined) return new Response(null, { status: 202 });

  switch (method) {
    case "initialize":
      return json(
        {
          jsonrpc: "2.0",
          id,
          result: {
            protocolVersion: SUPPORTED_VERSIONS.includes(String(params?.protocolVersion))
              ? String(params?.protocolVersion)
              : LATEST,
            capabilities: { tools: { listChanged: false } },
            serverInfo: SERVER,
            instructions:
              "Analytics for a portfolio of sites and iOS apps, one event schema for both. " +
              "Start with list_products to see what exists and what is instrumented — a " +
              "product with no counter reports zero traffic for reasons that have nothing to " +
              "do with how it is doing. Bots are excluded from people and page views and " +
              "reported separately; when sampling is active the people figure is a lower " +
              "bound and says so. Nothing here is estimated or smoothed.",
          },
        },
        200,
        version,
      );

    case "ping":
      return json({ jsonrpc: "2.0", id, result: {} }, 200, version);

    case "tools/list":
      return json({ jsonrpc: "2.0", id, result: { tools: TOOLS } }, 200, version);

    case "tools/call": {
      const name = String(params?.name ?? "");
      const args = (params?.arguments ?? {}) as Record<string, unknown>;

      // Validated before any work: an unknown tool must not cost a metered SQL query, and it
      // must not be reported as a tool failure when it is a client mistake.
      if (!TOOLS.some(t => t.name === name)) {
        return rpcError(id, -32602, `Unknown tool: ${name}`, version);
      }

      if (name === "list_products") {
        const result = await fetchOverview(env, 7, now);
        const reporting = new Set(
          result.ok
            ? result.overview.stats.sources.filter(r => r.page_views > 0).map(r => r.source)
            : [],
        );
        const lines = [
          `${SOURCE_IDS.length} registered sources — ${SITES.length} sites ` +
            `(${SITES.filter(s => s.retired).length} retired), ` +
            `${SOURCE_IDS.length - SITES.length} app-only.`,
          "",
          ...SITES.map(s => {
            // A retired site says so instead of "NOT INSTALLED": the second reads as a task
            // somebody forgot, and a reader who acts on it goes looking for a dead repository.
            const state = s.retired
              ? "RETIRED — switched off, kept for the history under this id"
              : `counter ${reporting.has(s.id) ? "reporting" : "NOT INSTALLED"}`;
            return `- ${s.id} — ${s.url} — ${state}`;
          }),
          "",
          "App-only sources (iOS, reporting through the Swift snippet when it ships):",
          ...SOURCE_IDS.filter(id => !SITES.some(s => s.id === id)).map(id => `- ${id}`),
        ];
        return toolText(id, lines.join("\n"), version);
      }

      const days = windowDays(args);
      const result = await fetchOverview(env, days, now);
      if (!result.ok) {
        return toolText(id, `Could not read the store: ${JSON.stringify(result.body)}`, version, true);
      }
      const { stats, coverage, agents, sites_reporting, sites_total } = result.overview;

      if (name === "traffic") {
        const rows = stats.sources.map(
          r =>
            `- ${r.source} (${r.platform}) — people ${r.people_seen}${r.max_sample > 1 ? "+" : ""}, ` +
            `page views ${r.page_views}, engaged ${r.engaged}, bot events ${r.bot_events}`,
        );
        const text = [
          `Last ${days} day(s). People ${stats.total_people}, page views ${stats.total_page_views}, ` +
            `engaged ${stats.total_engaged}, bot events ${stats.total_bot_events} of ` +
            `${stats.total_events} received.`,
          stats.sampling_active
            ? "Sampling was ACTIVE: people is a lower bound, because a dropped row takes its " +
              "anonymous id with it and no weighting recovers one. Event counts stay exact."
            : "No sampling in this window; counts are exact.",
          `Counters live on ${sites_reporting} of ${sites_total} registered sites.`,
          "",
          ...(rows.length > 0 ? rows : ["No events at all in this window."]),
          "",
          "Engaged = a page view that saw a scroll, click or keypress. It is the hardest signal " +
            "here to fake, and the best proxy for a person rather than a script.",
        ];
        return toolText(id, text.join("\n"), version);
      }

      if (name === "campaigns") {
        const list = stats.campaigns ?? [];
        if (list.length === 0) {
          return toolText(
            id,
            `No campaign tags in the last ${days} day(s). Nothing is broken — a visit is only ` +
              "counted here when its link carried a utm_campaign tag, so this stays empty until " +
              "the first tagged link is published.",
            version,
          );
        }
        const rows = list.map(c => {
          const channel = [c.utm_source, c.utm_medium].filter(Boolean).join(" / ") || "unknown";
          return (
            `- ${c.utm_campaign} (${channel}) on ${c.source} — visits ${c.page_views}, ` +
            `engaged ${c.engaged}, store clicks ${c.store_clicks}, bots ${c.bot_views}`
          );
        });
        return toolText(
          id,
          [
            `Last ${days} day(s), ${list.length} campaign tag(s).`,
            "",
            ...rows,
            "",
            "Store clicks are the last step we can see. What follows — product page views, " +
              "installs, purchases — is attributed by Apple to the same tag, aggregate only.",
          ].join("\n"),
          version,
        );
      }

      if (name === "content") {
        const top = (rows: { source: string; key: string; page_views: number; engaged: number }[]) =>
          rows.slice(0, 15).map(r => `- ${r.key} (${r.source}) — ${r.page_views} views, ${r.engaged} engaged`);
        const refs = stats.referrers ?? [];
        const pages = stats.pages ?? [];
        return toolText(
          id,
          [
            `Last ${days} day(s).`,
            "",
            "## Where they came from",
            ...(refs.length > 0
              ? top(refs)
              : ["Nothing — every visit in this window was direct or the referrer was withheld."]),
            "",
            "## What they read",
            ...(pages.length > 0 ? top(pages) : ["No page views in this window."]),
            "",
            "## Where in the world",
            ...((stats.countries ?? []).length > 0
              ? top(stats.countries ?? [])
              : ["No country data — the edge did not report one."]),
          ].join("\n"),
          version,
        );
      }

      if (name === "counter_coverage") {
        const rows = coverage.map(
          c =>
            `- ${c.zone} — edge ${c.edge_page_views} (all traffic), ours ` +
            `${c.our_page_views} (browsers) — ${c.our_page_views > 0 ? "reporting" : "NO COUNTER"}` +
            ` — covers ${c.sites.join(", ")}`,
        );
        return toolText(
          id,
          [
            `Last ${days} day(s), by domain.`,
            "",
            ...(rows.length > 0 ? rows : ["Cloudflare edge data unavailable."]),
            "",
            "The two figures are different populations and their ratio means nothing — on one " +
              "measured domain 86% of edge traffic was curl and unidentified scrapers against " +
              "~12% real browsers. Read each row as installed or not installed.",
          ].join("\n"),
          version,
        );
      }

      if (name === "agent_traffic") {
        if (agents === undefined || agents.length === 0) {
          return toolText(id, "No verified AI agent traffic in the last 24 hours.", version);
        }
        const why = (c: string) =>
          c === "AI Assistant" ? "answering someone" : c === "AI Search" ? "search result" : "indexing";

        // Каждая зона отдельным блоком: складывать их в один список значило бы потерять
        // ответ на вопрос «кто читает ЭТОТ сайт», ради которого сюда и смотрят.
        const total = agents.reduce((sum, z) => sum + z.ai_requests, 0);
        const blocks = agents.map(z =>
          [
            `## ${z.zone} — ${z.ai_requests} requests`,
            ...z.agents.map(
              a => `- ${a.agent}${a.operator ? ` (${a.operator})` : ""} — ${why(a.category)} — ${a.requests}`,
            ),
            z.ai_paths.length > 0
              ? `They read: ${z.ai_paths.slice(0, 6).map(p => `${p.path} (${p.requests})`).join(", ")}`
              : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );

        return toolText(
          id,
          [
            `Last 24 hours — ${total} requests from verified AI agents across ` +
              `${agents.length} zone(s).`,
            "",
            ...blocks,
            "",
            "Verified by Cloudflare against each operator's own IP ranges, so a script cannot " +
              "appear here by calling itself ClaudeBot. 24 hours is the widest window this " +
              "dataset allows on the free plan.",
          ].join("\n\n"),
          version,
        );
      }

      return rpcError(id, -32603, `Tool declared but not implemented: ${name}`, version);
    }

    default:
      return rpcError(id, -32601, `Method not found: ${String(method)}`, version);
  }
}
