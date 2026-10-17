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
 * Nothing here throws, and nothing here fails silently. The dashboard must still render its
 * own numbers when Cloudflare is unavailable, so failures come back as values — but as values
 * with a REASON attached to the zone they cost. An empty list used to mean both "no zones"
 * and "the request failed", and every verdict built on it inherited the ambiguity.
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

/** A zone that could not be read, and why. The reason is the diagnosis; keep it verbatim. */
export type ZoneFailure = { zone: string; unavailable: string };

function reasonOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

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
 * So the list is chunked. The batches are not what runs out first: one overview spends a
 * subrequest per registered zone on the agent query as well (agents.ts), plus seven SQL reads,
 * so the Workers ceiling of fifty arrives at roughly three dozen registered zones. Think again
 * before the registry gets there.
 */
export const MAX_ZONES_PER_QUERY = 10;

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

const QUERY = `query($ids:[string!],$since:Date!,$until:Date!,$limit:uint64!){
  viewer{zones(filter:{zoneTag_in:$ids}){
    zoneTag
    httpRequests1dGroups(limit:$limit,filter:{date_geq:$since,date_leq:$until},orderBy:[date_ASC]){
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

/** How many pages of zones to read at most — 50 per page, so far beyond any real account. */
const MAX_ZONE_PAGES = 20;

/**
 * Every active zone the token can see, or the reason it could not say.
 *
 * Paged: `/zones` returns at most fifty per page, and reading only the first page would make
 * the fifty-first zone vanish from coverage and from agents with nothing marking the loss.
 */
export async function listZones(env: ZonesEnv): Promise<{ zones: Zone[]; problem?: string }> {
  if (env.CF_API_TOKEN === undefined) return { zones: [], problem: "CF_API_TOKEN is not set on this Worker" };
  const zones: Zone[] = [];
  try {
    for (let page = 1; page <= MAX_ZONE_PAGES; page++) {
      const response = await fetch(`${API}/zones?per_page=50&status=active&page=${page}`, {
        headers: { Authorization: `Bearer ${env.CF_API_TOKEN}` },
      });
      if (!response.ok) return { zones: [], problem: `GET /zones answered HTTP ${response.status}` };
      const body = (await response.json()) as {
        success?: boolean;
        errors?: { message?: string }[];
        result?: { id?: string; name?: string }[];
        result_info?: { total_pages?: number };
      };
      if (body.success !== true) {
        return { zones: [], problem: body.errors?.[0]?.message ?? "GET /zones returned success:false" };
      }
      for (const z of body.result ?? []) {
        if (z.id && z.name) zones.push({ tag: z.id, name: z.name });
      }
      if (page >= (body.result_info?.total_pages ?? 1)) break;
    }
  } catch (err) {
    return { zones: [], problem: `GET /zones failed: ${reasonOf(err)}` };
  }
  if (zones.length === 0) {
    return { zones, problem: "the token can see no active zones — check its zone resources" };
  }
  return { zones };
}

/**
 * Daily totals for these zones, and a named failure for every zone that did not come back.
 *
 * A batch that fails — refused, thrown, garbled — costs exactly its own zones and says so;
 * the other batches stand. This is what "half an answer beats none, as long as nobody calls it
 * whole" requires: the half that is missing has to be visible to whoever prints the verdict.
 */
export async function fetchZoneTotals(
  env: ZonesEnv,
  zones: Zone[],
  days: number,
  now: number,
): Promise<{ totals: ZoneTotals[]; failures: ZoneFailure[] }> {
  if (zones.length === 0) return { totals: [], failures: [] };
  if (env.CF_API_TOKEN === undefined) {
    return {
      totals: [],
      failures: zones.map((z) => ({ zone: z.name, unavailable: "CF_API_TOKEN is not set on this Worker" })),
    };
  }

  // Chunked because eleven zones in one filter is refused outright — see MAX_ZONES_PER_QUERY.
  const batches = await Promise.all(
    chunk(zones, MAX_ZONES_PER_QUERY).map((batch) => fetchZoneBatch(env, batch, days, now)),
  );
  return {
    totals: batches.flatMap((b) => b.totals),
    failures: batches.flatMap((b) => b.failures),
  };
}

async function fetchZoneBatch(
  env: ZonesEnv,
  zones: Zone[],
  days: number,
  now: number,
): Promise<{ totals: ZoneTotals[]; failures: ZoneFailure[] }> {
  const lost = (unavailable: string) => ({
    totals: [],
    failures: zones.map((z) => ({ zone: z.name, unavailable })),
  });

  let reply: {
    // A GraphQL error arrives with HTTP 200, so the status check proves nothing alone.
    errors?: { message?: string }[];
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
  try {
    const response = await fetch(`${API}/graphql`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.CF_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({
        query: QUERY,
        variables: {
          ids: zones.map((z) => z.tag),
          // Exactly `days` dates, today included. One more is not harmless: Cloudflare refuses
          // any range wider than 52w1d, so a 365-day window spanning 366 dates was refused
          // outright and the one-year button never had edge data.
          since: isoDay(now - (days - 1) * 86_400_000),
          until: isoDay(now),
          // One row per day in the window. A fixed 90 used to cut the one-year view down to its
          // OLDEST ninety days while a young zone returned all of its own — two windows in one
          // table, with nothing saying so.
          limit: days,
        },
      }),
    });
    if (!response.ok) return lost(`daily analytics answered HTTP ${response.status}`);
    reply = (await response.json()) as typeof reply;
  } catch (err) {
    return lost(`daily analytics failed: ${reasonOf(err)}`);
  }
  if (Array.isArray(reply.errors) && reply.errors.length > 0) {
    return lost(`daily analytics refused: ${reply.errors[0]?.message ?? "GraphQL error without a message"}`);
  }

  const byTag = new Map(zones.map((z) => [z.tag, z]));
  const totals: ZoneTotals[] = [];

  for (const node of reply.data?.viewer?.zones ?? []) {
    const zone = node.zoneTag === undefined ? undefined : byTag.get(node.zoneTag);
    if (zone === undefined) continue;
    byTag.delete(zone.tag);
    const rows: ZoneDay[] = (node.httpRequests1dGroups ?? []).map((g) => ({
      date: g.dimensions?.date ?? "",
      requests: g.sum?.requests ?? 0,
      pageViews: g.sum?.pageViews ?? 0,
      uniques: g.uniq?.uniques ?? 0,
    }));
    const total = (pick: (d: ZoneDay) => number) => rows.reduce((s, d) => s + pick(d), 0);
    totals.push({
      ...zone,
      pageViews: total((d) => d.pageViews),
      uniques: total((d) => d.uniques),
      requests: total((d) => d.requests),
      days: rows,
    });
  }

  // A zone the token may LIST but not READ comes back as no node at all, with no error —
  // listing zones and reading their analytics are separate permissions.
  const failures = [...byTag.values()].map((z) => ({
    zone: z.name,
    unavailable: "no data returned for this zone — the token may lack Zone Analytics:Read for it",
  }));
  return { totals, failures };
}
