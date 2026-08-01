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
 * All zones in one request, identified by `zoneTag`. Ten separate queries would also work and
 * would cost ten subrequests against a limit of fifty on the free plan.
 */
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
