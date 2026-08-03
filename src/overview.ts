/**
 * What the dashboard reads: our events and Cloudflare's edge counts, assembled but never
 * summed. Kept out of stats.ts because that file must stay about one store.
 *
 * The coverage rows are the point of this file. Edge page views against our `page_viewed`
 * events tells "this site has no visitors" apart from "this site has no counter" — which is
 * the only honest way to know whether the rollout is finished.
 */
import { fetchAgentTraffic, type AgentTraffic } from "./agents";
import { SITES } from "./registry.generated";
import { fetchStats, type Stats, type StatsEnv } from "./stats";
import { fetchZoneTotals, listZones, zoneForHost, type ZonesEnv } from "./zones";

export type Coverage = {
  zone: string;
  /** Registry ids whose host sits in this zone — several sites share one zone. */
  sites: string[];
  edge_page_views: number;
  edge_uniques: number;
  our_page_views: number;
  /** our / edge, or null when the edge saw nothing and the ratio would be meaningless. */
  ratio: number | null;
};

/**
 * Регистрируемый домен: books.superduperai.co и superduperai.co — одна семья.
 * Наивно, по двум последним меткам — этого хватает для .com/.co/.net/.org/.app,
 * а списка публичных суффиксов ради группировки в таблице тащить не стоит.
 */
export function domainFamily(host: string): string {
  const parts = host.split(".");
  return parts.length <= 2 ? host : parts.slice(-2).join(".");
}

export type Overview = {
  stats: Stats;
  coverage: Coverage[];
  /** False when the Cloudflare side could not be read; the page says so rather than guessing. */
  edge_available: boolean;
  /** AI agents reading the busiest published zone. Last 24h only — the Free plan's ceiling. */
  agents?: AgentTraffic;
  /** Registered sites, and how many actually reported. Counted per SITE, never per zone —
   *  six properties share the superduperai.co zone, so a zone count would claim six installs
   *  where there is one. */
  sites_total: number;
  sites_reporting: number;
};

export type OverviewEnv = StatsEnv & ZonesEnv;

export async function fetchOverview(
  env: OverviewEnv,
  days: number,
  now: number,
): Promise<{ ok: true; overview: Overview } | { ok: false; status: number; body: unknown }> {
  const stats = await fetchStats(env, days);
  if (!stats.ok) return stats;

  // The edge side is best-effort: a dashboard that shows nothing because Cloudflare's GraphQL
  // hiccuped is worse than one that shows our own numbers and admits the other half is missing.
  let coverage: Coverage[] = [];
  let edgeAvailable = false;
  try {
    const zones = await listZones(env);
    const totals = await fetchZoneTotals(env, zones, days, now);
    edgeAvailable = totals.length > 0;

    // Grouped by ZONE, not by site: every *.superduperai.co property shares one zone, and
    // showing that zone's traffic against each of them would count it six times over.
    coverage = totals
      .map((zone) => {
        const sites = SITES.filter((s) => zoneForHost(s.host, zones)?.tag === zone.tag);
        const ours = sites.reduce(
          (sum, site) =>
            sum +
            stats.stats.sources
              .filter((row) => row.source === site.id && row.platform === "web")
              .reduce((s, row) => s + row.page_views, 0),
          0,
        );
        return {
          zone: zone.name,
          sites: sites.map((s) => s.id),
          edge_page_views: zone.pageViews,
          edge_uniques: zone.uniques,
          our_page_views: ours,
          ratio: zone.pageViews > 0 ? ours / zone.pageViews : null,
        };
      })
      // Zones with no registered site are other properties on the account, not this project's.
      .filter((row) => row.sites.length > 0)
      .sort((a, b) => b.edge_page_views - a.edge_page_views);
  } catch {
    edgeAvailable = false;
  }

  const reporting = new Set(
    stats.stats.sources
      .filter((row) => row.platform === "web" && row.page_views > 0)
      .map((row) => row.source),
  );

  // One zone only: each call is a subrequest and the answer is per-zone anyway. The busiest
  // one is the one worth a slot on the page; the rest are a click away in Cloudflare.
  let agents: AgentTraffic | undefined;
  try {
    const busiest = coverage[0];
    if (busiest !== undefined) {
      const zones = await listZones(env);
      const zone = zones.find((z) => z.name === busiest.zone);
      if (zone !== undefined) agents = await fetchAgentTraffic(env, zone, now);
    }
  } catch {
    agents = undefined;
  }

  // Подклеиваем к каждому источнику его домен, чтобы поддомены одного продукта стояли
  // рядом, а не разлетались по таблице по числу событий. У приложений хоста нет — им
  // достаётся домен одноимённого сайта, если он есть, иначе собственный id.
  const hostOf = new Map<string, string>(SITES.map(s => [s.id, domainFamily(s.host)]));
  stats.stats.sources = stats.stats.sources
    .map(row => ({ ...row, domain: hostOf.get(row.source) ?? row.source }))
    .sort(
      (a, b) =>
        a.domain.localeCompare(b.domain) ||
        a.source.localeCompare(b.source) ||
        b.events - a.events,
    );

  return {
    ok: true,
    overview: {
      stats: stats.stats,
      coverage,
      agents,
      edge_available: edgeAvailable,
      sites_total: SITES.length,
      sites_reporting: SITES.filter((s) => reporting.has(s.id)).length,
    },
  };
}
