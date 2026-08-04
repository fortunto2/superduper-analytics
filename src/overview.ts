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
import { readSearch, type SearchTotal } from "./search/sync";
import { readTotals, type StoreTotal } from "./stores/db";
import { dayBefore, utcDay } from "./stores/schema";

/** Сайты, на которые счётчик в принципе можно поставить. */
const LIVE_SITES = SITES.filter((s) => !s.retired);
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
  /**
   * AI-агенты по каждой зоне, где они вообще были. Массив, а не одна зона: общая страница
   * обязана быть общей, а срез продукта берёт отсюда свою. Только последние сутки — потолок
   * бесплатного тарифа у этого датасета.
   */
  agents?: AgentTraffic[];
  /** Registered sites, and how many actually reported. Counted per SITE, never per zone —
   *  six properties share the superduperai.co zone, so a zone count would claim six installs
   *  where there is one. */
  sites_total: number;
  sites_reporting: number;
  /**
   * Что о нас сообщили сами магазины: установки, переустановки, деньги. Отдельным полем, а не
   * подмешано к нашим числам, потому что складывать их нельзя — это разные счётчики с разным
   * определением суток. Пусто, пока ключ App Store Connect не умеет читать отчёты.
   */
  stores?: StoreTotal[];
  /**
   * Search Console: по каким запросам нас показывают и на каком месте.
   *
   * Единственный ОПЕРЕЖАЮЩИЙ показатель на этой странице. Всё остальное отвечает, что уже
   * случилось; этот — сколько раз нас показали и не кликнули, то есть где рост.
   */
  search?: SearchTotal[];
};

export type OverviewEnv = StatsEnv & ZonesEnv & { STORES?: D1Database };

export async function fetchOverview(
  env: OverviewEnv,
  days: number,
  now: number,
): Promise<{ ok: true; overview: Overview } | { ok: false; status: number; body: unknown }> {
  /**
   * Три независимые вещи, и раньше они шли по очереди: наши SQL, D1 и весь край. Итог был
   * суммой, хотя должен быть максимумом — ни одна из них не ждёт результата другой.
   *
   * Самое важное здесь — что цепочка края НЕ ждёт наших чисел. Кажется, что ждёт: покрытие
   * считает «наши просмотры» из stats. Но порядок зон и выбор самой нагруженной определяются
   * только числами края, поэтому и зоны, и агенты стартуют сразу, а stats подмешивается в
   * готовую таблицу арифметикой, которая сети не касается.
   */
  const edge = (async () => {
    const zones = await listZones(env);
    const totals = await fetchZoneTotals(env, zones, days, now);

    // Зоны без зарегистрированного сайта — чужие свойства аккаунта, не этот проект.
    const registered = totals
      .filter((zone) => SITES.some((site) => zoneForHost(site.host, zones)?.tag === zone.tag))
      .sort((a, b) => b.pageViews - a.pageViews);

    // Все зоны, а не самая нагруженная. Раньше страница называлась общей, а показывала агентов
    // одного домена — и получалось, что у остальных их будто нет. Каждая зона это один
    // субзапрос; они идут разом, поэтому стоит это столько же, сколько стоила одна.
    const agents = (
      await Promise.all(
        registered.map((zone) =>
          fetchAgentTraffic(env, zone, now).catch(() => undefined),
        ),
      )
    ).filter((a): a is AgentTraffic => a !== undefined && a.agents.length > 0);

    return { zones, totals: registered, agents };
  })();

  // Окно поиска сдвинуто: консоль отдаёт данные с отставанием в два-три дня, и запрос за
  // «последние 7 дней, считая сегодня» вернул бы три пустых дня и заниженные итоги.
  const searchPromise = (async (): Promise<SearchTotal[]> => {
    if (env.STORES === undefined) return [];
    const to = dayBefore(utcDay(now), 3);
    try {
      return await readSearch(env.STORES, "query", dayBefore(to, Math.max(1, days) - 1), to);
    } catch {
      return [];
    }
  })();

  const storesPromise = (async (): Promise<StoreTotal[]> => {
    if (env.STORES === undefined) return [];
    const to = dayBefore(utcDay(now), 1);
    // Магазины — дополнение к нашим числам, и падение D1 не должно унести весь дашборд.
    try {
      return await readTotals(env.STORES, dayBefore(to, Math.max(1, days) - 1), to);
    } catch {
      return [];
    }
  })();

  // Край — best-effort: дашборд, показавший ничего из-за икоты чужого GraphQL, хуже дашборда,
  // который показал наши числа и честно сказал, что второй половины нет.
  const [stats, stores, search, edgeResult] = await Promise.all([
    fetchStats(env, days),
    storesPromise,
    searchPromise,
    edge.catch(() => null),
  ]);
  if (!stats.ok) return stats;

  const edgeAvailable = edgeResult !== null && edgeResult.totals.length > 0;
  const agents = edgeResult?.agents ?? [];
  const coverage: Coverage[] =
    edgeResult === null
      ? []
      : edgeResult.totals.map((zone) => {
          // Сгруппировано по ЗОНЕ, а не по сайту: все *.superduperai.co делят одну зону, и
          // показать её трафик против каждого значило бы посчитать его шесть раз.
          const sites = SITES.filter(
            (site) => zoneForHost(site.host, edgeResult.zones)?.tag === zone.tag,
          );
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
        });

  const reporting = new Set(
    stats.stats.sources
      .filter((row) => row.platform === "web" && row.page_views > 0)
      .map((row) => row.source),
  );

  // Подклеиваем к каждому источнику его домен, чтобы поддомены одного продукта стояли
  // рядом, а не разлетались по таблице по числу событий. У приложений хоста нет — им
  // достаётся домен одноимённого сайта, если он есть, иначе собственный id.
  const hostOf = new Map<string, string>(SITES.map(s => [s.id, domainFamily(s.host)]));

  // Агенты — по продукту, а не по зоне. Шесть продуктов делят зону superduperai.co, но у
  // каждого свой поддомен, и Cloudflare их различает, хотя зона — нет. Пока это не было
  // запрошено, число агентов приходилось показывать на всю зону сразу, то есть приписывать
  // одному продукту чтение всех соседних.
  const aiByHost = new Map<string, number>();
  for (const zone of edgeResult?.agents ?? []) {
    for (const h of zone.by_host) {
      aiByHost.set(h.host, (aiByHost.get(h.host) ?? 0) + h.requests);
    }
  }
  const fullHost = new Map<string, string>(SITES.map(s => [s.id, s.host.toLowerCase()]));

  stats.stats.sources = stats.stats.sources
    .map(row => ({
      ...row,
      domain: hostOf.get(row.source) ?? row.source,
      // Только у веба: у приложения нет хоста, и приписать ему чтение сайта было бы выдумкой.
      ai_requests:
        row.platform === "web" ? (aiByHost.get(fullHost.get(row.source) ?? "") ?? 0) : undefined,
    }))
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
      // Выключенные сайты не считаются: цель, которой нельзя достичь, делает всю дробь
      // бессмысленной — «9 из 14» звучит как недоделанная работа, хотя четырнадцатый
      // выключен навсегда и счётчику там негде стоять.
      sites_total: LIVE_SITES.length,
      sites_reporting: LIVE_SITES.filter((s) => reporting.has(s.id)).length,
      stores,
      search,
    },
  };
}
