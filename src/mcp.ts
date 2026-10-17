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
import { formatAgentTraffic, formatCoverage } from "./edge-report";
import { SITES, SOURCE_IDS } from "./registry.generated";
import { fetchOverview, isReporting, type OverviewEnv } from "./overview";
import { fetchRetention } from "./retention";
import { fetchNetwork } from "./network";
import { METRIC_SLOTS } from "./registry";
import { fetchMetric } from "./stats";
import { fetchConversion } from "./conversion";
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
    name: "goals",
    title: "What people actually did",
    description:
      "Every event that is not a page view, per product and per placement: downloads, store " +
      "links, signups started. These are what a site exists to produce, and they are single " +
      "digits against hundreds of page views — which is why they get their own list rather " +
      "than a row in the traffic table. Empty means nothing was marked up, or nobody clicked.",
    inputSchema: { type: "object", properties: { days: DAYS_PROPERTY } },
  },
  {
    name: "search",
    title: "Where Google shows us, and at what rank",
    description:
      "Search Console queries for a window: impressions, clicks, CTR and average position per " +
      "product. The ONLY leading indicator here — everything else reports what already " +
      "happened, this says where growth is available. A query ranking in the top twenty with " +
      "impressions and almost no clicks is a title-and-description problem, not a traffic " +
      "problem, and is the cheapest thing to fix. Data lags Google by two to three days.",
    inputSchema: { type: "object", properties: { days: DAYS_PROPERTY } },
  },
  {
    name: "agent_traffic",
    title: "Which AI agents read the sites",
    description:
      "Named AI agents that fetched each registered zone in the last 24 hours, with the " +
      "operator behind each and why it came. The distinction matters: an AI Assistant fetch " +
      "means a person asked a question right now, an AI Crawler is building an index. Zones " +
      "that could not be read are listed as such, never counted as zero. Agents do not run " +
      "JavaScript, so the web snippet never sees them; the one exception is agentboard, which " +
      "counts its own requests server-side and shows up in `traffic` as platform `server`.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "network",
    title: "Which of our own products feed each other",
    description:
      "Traffic between our own sites, plus clicks on install buttons. Answers 'does the network " +
      "feed itself' — whether a reader of one product ever reaches another, which no per-product " +
      "number can show. Site-to-site edges come from the browser's own Referer, so they are " +
      "facts about clicks that happened. Store clicks are INTENT, not installs: whether the app " +
      "was installed is Apple's number, matched by the campaign token. App-to-app is absent and " +
      "will stay absent — an app has no referrer, and linking one launch to another click would " +
      "need the cross-product identifier this project refuses to have.",
    inputSchema: { type: "object", properties: { days: DAYS_PROPERTY } },
  },
  {
    name: "metric",
    title: "Aggregate one number the apps report",
    description:
      "Average, range and total for one metric, split by product and event. Only metrics with " +
      "a slot in registry/sources.yaml can be aggregated — everything else an app sends is " +
      "stored as JSON and readable per row, but not summable: the store's SQL has no JSON " +
      "functions. Currently available: " +
      (METRIC_SLOTS.length > 0 ? METRIC_SLOTS.join(", ") : "none yet") +
      ". Rows where the key was absent are excluded, so a zero means a real zero. Always read " +
      "the event column: the same metric means different things on different events.",
    inputSchema: {
      type: "object",
      properties: {
        name: {
          type: "string",
          description: `Metric name. One of: ${METRIC_SLOTS.join(", ") || "(none registered yet)"}`,
        },
        days: DAYS_PROPERTY,
      },
      required: ["name"],
    },
  },
  {
    name: "retention",
    title: "Do people come back to the apps",
    description:
      "Installs that returned on a later day, per app. THE demand signal in this dataset: " +
      "everything else counts arrivals, this counts the ones who came back on their own. Apps " +
      "only, and that is not a gap to fill later — the web id is derived at the edge and dies " +
      "at midnight UTC, so a web return is invisible by design. An app sends an install-scoped " +
      "UUID that lives until the app is deleted, which is what makes the question answerable " +
      "without any identifier for a person. Installs first seen too recently to have had the " +
      "chance to return are counted separately and kept OUT of the rate, so a burst of new " +
      "users cannot make retention look like it collapsed.",
    inputSchema: { type: "object", properties: { days: DAYS_PROPERTY } },
  },
  {
    name: "conversion",
    title: "Which pages make people act, and which do not",
    description:
      "Goals against page views of the same page — the denominator `goals` does not have. Read " +
      "it for what to fix: a page with traffic and no action is a page whose next step is " +
      "unclear, and it is cheaper to fix than to find more traffic. Counted ON the page, not " +
      "along a path between pages: a journey needs a session, a session needs an id that " +
      "outlives a day, and the web has none here. Pages below the view threshold are dropped, " +
      "because one click on one view is not a 100% conversion rate.",
    inputSchema: {
      type: "object",
      properties: {
        days: DAYS_PROPERTY,
        min_views: {
          type: "integer",
          minimum: 1,
          description: "Drop pages with fewer views than this. Default 10 — below that the rate is noise.",
        },
      },
    },
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
            ? result.overview.stats.sources.filter(isReporting).map(r => r.source)
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

      // Эти два спрашивают хранилище одним запросом каждый. Обзор стоит семи, а чтения
      // метрятся — поэтому они стоят ДО него и никогда его не зовут.
      if (name === "network") {
        const result = await fetchNetwork(env, days);
        if (!result.ok) {
          return toolText(id, `Could not read the store: ${JSON.stringify(result.body)}`, version, true);
        }
        const { edges, store_clicks, known_hosts } = result.network;
        const text = [
          `Last ${days} day(s). ${known_hosts} of our hostnames are recognised as our own.`,
          "",
          "Between our sites:",
          ...(edges.length > 0
            ? edges.map(e => `- ${e.from} → ${e.to} — ${e.views} view(s)`)
            : ["- nothing: no visitor arrived at one of our sites from another."]),
          "",
          "Clicks on install buttons (intent, not installs):",
          ...(store_clicks.length > 0
            ? store_clicks.map(c => `- ${c.source} → ${c.store}${c.placement === "" ? "" : ` (${c.placement})`} — ${c.clicks}`)
            : ["- none in this window."]),
          "",
          "Site-to-site is the browser's own Referer, so it is a click that happened. A store " +
            "click is intent: the install itself is Apple's number, tied to the same campaign " +
            "token. Never add the two — they are counted by different parties.",
        ];
        return toolText(id, text.join("\n"), version);
      }

      if (name === "metric") {
        const metric = typeof args.name === "string" ? args.name : "";
        const result = await fetchMetric(env, metric, days);
        if (!result.ok) {
          return toolText(id, `Could not read the store: ${JSON.stringify(result.body)}`, version, true);
        }
        const { rows, slot } = result.metric;
        const lines = rows.map(
          r =>
            `- ${r.source} · ${r.event} — avg ${r.avg.toFixed(1)}, range ${r.min}..${r.max}, ` +
            `total ${r.total}, over ${r.events} event(s)`,
        );
        const text = [
          `"${metric}" over the last ${days} day(s), from double${slot}.`,
          "",
          ...(lines.length > 0 ? lines : [`No event carried "${metric}" in this window.`]),
          "",
          "Averages are weighted by the sampling interval; an unweighted one would be quietly " +
            "biased. Events that never send this key are excluded rather than counted as zero.",
        ];
        return toolText(id, text.join("\n"), version);
      }

      if (name === "retention") {
        const result = await fetchRetention(env, days, now);
        if (!result.ok) {
          return toolText(id, `Could not read the store: ${JSON.stringify(result.body)}`, version, true);
        }
        const { rows, first_day_seen, truncated } = result.retention;
        const pct = (v: number | null) => (v === null ? "n/a" : `${Math.round(v * 100)}%`);
        const lines = rows.map(
          r =>
            `- ${r.source} (${r.platform}) — ${r.installs} reporting installs since ` +
            `${r.first_report_day}, ${r.returned} of ${r.mature} mature came back on another ` +
            `day (${pct(r.return_rate)}), ${r.active_now} active in the last week, ` +
            `${r.events_per_install.toFixed(1)} events per install, median ` +
            `${r.median_days_active} active day(s)` +
            `, ${r.cohorts.map(c => `D${c.day} ${c.rate === null ? "n/a" : `${Math.round(c.rate * 100)}%`}` +
              ` (${c.returned}/${c.eligible})`).join(", ")}` +
            (r.too_new > 0 ? `, ${r.too_new} too new to ask` : "") +
            (r.max_sample > 1 ? " — SAMPLED, installs is a floor" : ""),
        );
        const text = [
          `Last ${days} day(s), apps only.`,
          first_day_seen !== undefined
            ? `Earliest app event in this window: ${first_day_seen}. A rate covering fewer days ` +
              "than the window asked for is still honest — the window just contains less than it says."
            : "No app events in this window at all.",
          truncated ? "TRUNCATED: hit the row cap, so the rates cover a slice, not everything." : "",
          "",
          ...(lines.length > 0 ? lines : ["No app sent an event with an install id in this window."]),
          "",
          "D1/D3/D7 = came back on exactly that day after the first one, counted only among " +
            "installs old enough to have reached it — which is why the denominators differ and " +
            "why a young counter shows n/a rather than zero. Unlike the overall rate, these do " +
            "not grow with the window, so two products with counters of different ages compare.",
          "Returned = the same install was active on more than one calendar day. Installs first " +
            "seen within the last two days are excluded from the rate: they have not had the " +
            "chance to return, and leaving them in makes a growing app look like a leaking one.",
          "An install here is a device that has REPORTED, not a download. The id is born on the " +
            "first launch of a build that carries the counter, so the week a counter ships, every " +
            "existing user looks brand new and the return rate is understated. Check the date " +
            "after 'since' before reading a low rate as a problem — downloads are Apple's number, " +
            "in `stores`, and the two are never added together.",
          "Web is absent on purpose: its id rotates at midnight, so every visitor would look new.",
        ].filter(line => line !== "");
        return toolText(id, text.join("\n"), version);
      }

      if (name === "conversion") {
        const minViews = typeof args.min_views === "number" ? Math.trunc(args.min_views) : undefined;
        const result = await fetchConversion(env, days, minViews);
        if (!result.ok) {
          return toolText(id, `Could not read the store: ${JSON.stringify(result.body)}`, version, true);
        }
        const { rows, min_views, truncated } = result.conversion;
        const lines = rows.map(r => {
          const goals = r.by_goal.map(g => `${g.name} ${g.count}`).join(", ");
          return (
            `- ${r.source} ${r.path} — ${r.page_views} views, ` +
            `${Math.round(r.conversion * 100)}% acted (${r.goals}), ` +
            `${Math.round(r.engagement * 100)}% engaged` +
            (goals !== "" ? ` — ${goals}` : "")
          );
        });
        const text = [
          `Last ${days} day(s), web pages with at least ${min_views} views, best rate first.`,
          truncated ? "TRUNCATED: hit the row cap, and the cap drops the RAREST rows — which are goals." : "",
          "",
          ...(lines.length > 0 ? lines : ["No page cleared the view threshold in this window."]),
          "",
          "Acted = events on that page that are not a view or an engagement, over its views. It " +
            "can exceed 100%: one visitor may click twice. A page at the bottom with real traffic " +
            "is the cheapest thing on this list to fix.",
          "Engaged is the weaker signal that every page has: a scroll, a click or a keypress.",
        ].filter(line => line !== "");
        return toolText(id, text.join("\n"), version);
      }

      const result = await fetchOverview(env, days, now);
      if (!result.ok) {
        return toolText(id, `Could not read the store: ${JSON.stringify(result.body)}`, version, true);
      }
      const {
        stats, coverage, agents, agent_failures, agent_zones_read, zone_failures,
        sites_reporting, sites_total,
      } = result.overview;

      if (name === "traffic") {
        const rows = stats.sources.map(
          r =>
            `- ${r.source} (${r.platform}) — people ${r.people_seen}${r.max_sample > 1 ? "+" : ""}, ` +
            `page views ${r.page_views}, engaged ${r.engaged}, bot events ${r.bot_events}`,
        );
        const text = [
          `Last ${days} day(s). People-days ${stats.people_days}, page views ${stats.total_page_views}, ` +
            `engaged ${stats.total_engaged}, bot events ${stats.total_bot_events} of ` +
            `${stats.total_events} received.`,
          stats.sampling_active
            ? "Sampling was ACTIVE: people-days is a lower bound, because a dropped row takes its " +
              "anonymous id with it and no weighting recovers one. Event counts stay exact."
            : "No sampling in this window; counts are exact.",
          `Counters live on ${sites_reporting} of ${sites_total} registered sites.`,
          "",
          ...(rows.length > 0 ? rows : ["No events at all in this window."]),
          "",
          "Engaged = a page view that saw a scroll, click or keypress. It is the hardest signal " +
            "here to fake, and the best proxy for a person rather than a script.",
          "People-days are NOT people: the web id rotates at midnight UTC, so a visitor who " +
            "returns on Tuesday is counted again, and the same person on two of our sites counts " +
            "twice. Whether anyone comes back is what `retention` answers, for apps only.",
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

      if (name === "goals") {
        const goals = stats.goals ?? [];
        if (goals.length === 0) {
          return toolText(
            id,
            `No goals in the last ${days} day(s). Either nothing is marked up with ` +
              "data-sda-event, or nobody clicked what is.",
            version,
          );
        }
        return toolText(
          id,
          [
            `Last ${days} day(s), ${goals.length} goal row(s).`,
            "",
            ...goals.map(
              g =>
                `- ${g.name} on ${g.source}${g.placement ? ` (${g.placement})` : ""} — ${g.count}`,
            ),
          ].join("\n"),
          version,
        );
      }

      if (name === "search") {
        const rows = result.overview.search ?? [];
        if (rows.length === 0) {
          return toolText(
            id,
            "No Search Console data in this window. Either the daily job has not run yet or " +
              "Google has nothing for these days — it lags two to three days.",
            version,
          );
        }
        const line = (r: { site: string; key: string; clicks: number; impressions: number; position: number }) => {
          const ctr = r.impressions > 0 ? (r.clicks / r.impressions) * 100 : 0;
          const reach = r.position <= 20 && r.impressions >= 5 && ctr < 2 ? "  <-- ranks but no clicks" : "";
          return `- "${r.key}" (${r.site}) — ${Math.round(r.impressions)} impressions, ` +
            `${Math.round(r.clicks)} clicks, CTR ${ctr.toFixed(1)}%, position ${r.position.toFixed(1)}${reach}`;
        };
        return toolText(
          id,
          [
            `Last ${days} day(s), shifted back three to match Google's lag.`,
            "",
            ...rows.slice(0, 25).map(line),
            "",
            "Position is weighted by impressions. Rows marked as ranking without clicks are " +
              "title and description work, not content work.",
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
        const r = formatCoverage({ days, coverage, failures: zone_failures ?? [] });
        return toolText(id, r.text, version, r.isError);
      }

      if (name === "agent_traffic") {
        const r = formatAgentTraffic({
          agents: agents ?? [],
          failures: agent_failures ?? [],
          read: agent_zones_read ?? 0,
        });
        return toolText(id, r.text, version, r.isError);
      }

      return rpcError(id, -32603, `Tool declared but not implemented: ${name}`, version);
    }

    default:
      return rpcError(id, -32601, `Method not found: ${String(method)}`, version);
  }
}
