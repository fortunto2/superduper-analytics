/**
 * Cloudflare's own edge analytics, over the GraphQL API. Read-only, free, and already counting
 * every registered site — no ingestion, no storage, no snippet required.
 *
 * WHY THIS IS LOAD-BEARING RATHER THAN A NICETY
 *
 * Analytics Engine samples, and it starts early — sampling was already active at 259 events.
 * `_sample_interval` lets weighted sums recover event COUNTS exactly, but a sampled-away row
 * takes its `anon` id with it, and no weighting recovers a distinct value that was never
 * stored. So the hot store cannot answer "how many people": `count(DISTINCT anon)` there is a
 * lower bound that drifts further from the truth the more traffic there is.
 *
 * The edge counts uniques BEFORE any of that. The division of labour:
 *   our events  → what happened (weighted counts, exact)
 *   zone data   → how many people, and how much traffic really arrived
 *
 * NEVER ADD THE TWO TOGETHER. The edge counts HTTP requests including bots, assets and API
 * calls; we count what a snippet chose to report. Their ratio is meaningful; their sum is not.
 *
 * Everything here degrades to `undefined` rather than throwing: the dashboard must still
 * render its own numbers when Cloudflare's side is unavailable.
 */

const API = "https://api.cloudflare.com/client/v4";

export type Zone = { tag: string; name: string };

export type ZoneDay = { date: string; requests: number; pageViews: number; uniques: number };

export type ZoneTotals = Zone & {
  pageViews: number;
  uniques: number;
  requests: number;
  days: ZoneDay[];
};

export type ZonesEnv = { CF_API_TOKEN?: string };

/**
 * Zones in as few requests as the API allows, identified by `zoneTag`.
 *
 * TEN IS A HARD CEILING, and finding out cost this project a month of blind edge data.
 * `zoneTag_in` with eleven zones is refused outright — `too many zones requested`, code
 * `quota`, no partial result — and `fetchZoneTotals` caught that with `return []`. The
 * account crossed ten on 5 August 2026 when visayes.app was added, and from that morning
 * every edge number in this Worker was empty: coverage said "Cloudflare edge data
 * unavailable", and `agent_traffic` reported "no verified AI agent traffic" for sites
 * Cloudflare was logging hundreds of crawler hits for. One zone too many turned a whole
 * subsystem off without a single error anywhere.
 *
 * So the list is chunked. Ten zones per request against a subrequest limit of fifty leaves
 * room for five hundred zones before this needs thinking about again.
 */
export const MAX_ZONES_PER_QUERY = 10;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const QUERY = `query($ids:[string!],$since:Date!,$until:Date!){
  viewer{zones(filter:{zoneTag_in:$ids}){
    zoneTag
    httpRequests1dGroups(limit:90,filter:{date_geq:$since,date_leq:$until},orderBy:[date_ASC]){
      dimensions{date} sum{requests pageViews} uniq{uniques}
    }
  }}
}`;

/** `YYYY-MM-DD`, which is what the GraphQL Date scalar wants. */
export function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * A site belongs to a zone when its host is the zone or sits under it. Longest match wins, so
 * a site is never attributed to a shorter zone that happens to be a suffix of another.
 */
export function zoneForHost(host: string, zones: Zone[]): Zone | undefined {
  return zones
    .filter((z) => host === z.name || host.endsWith(`.${z.name}`))
    .sort((a, b) => b.name.length - a.name.length)[0];
}

/**
 * Why a zone list can be empty, in words.
 *
 * `listZones` and `fetchZoneTotals` both degrade to `[]` so the dashboard still renders its own
 * numbers when Cloudflare is unreachable — the right call for a page, the wrong one for a
 * verdict. Downstream, an empty zone list makes every zone-derived answer empty too, and
 * `agent_traffic` reported "no verified AI agent traffic" when what had actually happened was
 * that it had no zones to ask about. This says which.
 *
 * Called only on the empty path, so it costs nothing on a healthy run.
 */
export async function zoneAccessProblem(env: ZonesEnv): Promise<string> {
  if (env.CF_API_TOKEN === undefined) return "CF_API_TOKEN is not set on this Worker";

  const response = await fetch(`${API}/zones?per_page=50&status=active`, {
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  if (!response.ok) return `GET /zones answered HTTP ${response.status}`;

  const body = (await response.json()) as {
    success?: boolean;
    errors?: { message?: string }[];
    result?: unknown[];
  };
  if (body.success !== true) {
    return body.errors?.[0]?.message ?? "GET /zones returned success:false without a message";
  }
  const count = (body.result ?? []).length;
  if (count === 0) return "the token can see no active zones — check its zone resources";

  // Listing zones and reading their analytics are two different permissions, and a token with
  // only the first passes every check above while returning nothing useful. That is exactly
  // what happened here: `GET /zones` answered with eleven zones and the analytics query came
  // back empty, so the code concluded the sites had no traffic. Probe the one that matters.
  const first = (body.result as { id?: string }[])[0]?.id ?? "";
  const probe = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: { ids: [first], since: isoDay(Date.now() - 86_400_000), until: isoDay(Date.now()) },
    }),
  });
  if (!probe.ok) return `${count} zone(s) visible, but the analytics query answered HTTP ${probe.status}`;
  const probeBody = (await probe.json()) as {
    errors?: { message?: string }[];
    data?: { viewer?: { zones?: unknown[] } };
  };
  if (probeBody.errors?.length) {
    return `${count} zone(s) visible, but analytics is refused: ${probeBody.errors[0]?.message ?? "no message"}`;
  }
  if ((probeBody.data?.viewer?.zones ?? []).length === 0) {
    return (
      `${count} zone(s) visible, but the analytics query returns no zone — the token most ` +
      "likely lacks Zone Analytics:Read (listing zones is a different permission)"
    );
  }
  return `${count} zone(s) are visible and readable, but none matched a registered site's host`;
}


export async function listZones(env: ZonesEnv): Promise<Zone[]> {
  if (env.CF_API_TOKEN === undefined) return [];
  const response = await fetch(`${API}/zones?per_page=50&status=active`, {
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
  });
  if (!response.ok) return [];
  const body = (await response.json()) as {
    success?: boolean;
    result?: { id?: string; name?: string }[];
  };
  if (body.success !== true) return [];
  return (body.result ?? [])
    .filter((z): z is { id: string; name: string } => Boolean(z.id) && Boolean(z.name))
    .map((z) => ({ tag: z.id, name: z.name }));
}

export async function fetchZoneTotals(
  env: ZonesEnv,
  zones: Zone[],
  days: number,
  now: number,
): Promise<ZoneTotals[]> {
  if (env.CF_API_TOKEN === undefined || zones.length === 0) return [];

  // Chunked because eleven zones in one filter is refused outright — see MAX_ZONES_PER_QUERY.
  const batches = await Promise.all(
    chunk(zones, MAX_ZONES_PER_QUERY).map((batch) => fetchZoneBatch(env, batch, days, now)),
  );
  return batches.flat();
}

async function fetchZoneBatch(
  env: ZonesEnv,
  zones: Zone[],
  days: number,
  now: number,
): Promise<ZoneTotals[]> {
  const response = await fetch(`${API}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
    body: JSON.stringify({
      query: QUERY,
      variables: {
        ids: zones.map((z) => z.tag),
        since: isoDay(now - days * 86_400_000),
        until: isoDay(now),
      },
    }),
  });
  if (!response.ok) return [];

  const reply = (await response.json()) as {
    // A GraphQL error arrives with HTTP 200, so the status check above proves nothing alone.
    errors?: unknown[];
    data?: {
      viewer?: {
        zones?: {
          zoneTag?: string;
          httpRequests1dGroups?: {
            dimensions?: { date?: string };
            sum?: { requests?: number; pageViews?: number };
            uniq?: { uniques?: number };
          }[];
        }[];
      };
    };
  };
  if (Array.isArray(reply.errors) && reply.errors.length > 0) return [];

  const byTag = new Map(zones.map((z) => [z.tag, z]));
  const out: ZoneTotals[] = [];

  for (const node of reply.data?.viewer?.zones ?? []) {
    const zone = node.zoneTag === undefined ? undefined : byTag.get(node.zoneTag);
    if (zone === undefined) continue;
    const rows: ZoneDay[] = (node.httpRequests1dGroups ?? []).map((g) => ({
      date: g.dimensions?.date ?? "",
      requests: g.sum?.requests ?? 0,
      pageViews: g.sum?.pageViews ?? 0,
      uniques: g.uniq?.uniques ?? 0,
    }));
    const total = (pick: (d: ZoneDay) => number) => rows.reduce((s, d) => s + pick(d), 0);
    out.push({
      ...zone,
      pageViews: total((d) => d.pageViews),
      uniques: total((d) => d.uniques),
      requests: total((d) => d.requests),
      days: rows,
    });
  }
  return out;
}
