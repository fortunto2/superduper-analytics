/**
 * Чтение YouTube из D1 и сборка ответов для MCP.
 *
 * Тексты собираются здесь, а не в `mcp.ts`: форматирование и арифметика проверяются без
 * протокола, и `mcp.ts` не растёт ещё на двести строк.
 */
import { CHANNELS } from "../registry.generated";
import { dayBefore } from "../stores/schema";
import type { CampaignTotal } from "../stats";

export type ChannelTotals = Record<string, number>;

export type VideoTotal = {
  video_id: string;
  title: string;
  published: string;
  kind: string;
  duration_s: number;
  privacy: string;
  campaigns: string[];
  views: number;
  minutes: number;
  /** Взвешено на просмотры: среднее средних без весов — не среднее. */
  avg_view_s: number;
  avg_view_pct: number;
  subs_gained: number;
  likes: number;
  comments: number;
};

/** Последние сутки, по которым YouTube уже что-то отдал. Окно кончается ими, а не сегодня. */
export async function readThrough(db: D1Database, source: string): Promise<string | undefined> {
  const row = await db
    .prepare(`SELECT MAX(day) AS d FROM store_daily WHERE provider = 'youtube' AND source = ?`)
    .bind(source)
    .first<{ d: string | null }>();
  return row?.d ?? undefined;
}

/** `days` суток, кончающихся `through` включительно. */
export const windowTo = (through: string, days: number): { from: string; to: string } => ({
  from: dayBefore(through, Math.max(1, days) - 1),
  to: through,
});

export async function readChannelTotals(
  db: D1Database,
  source: string,
  from: string,
  to: string,
): Promise<ChannelTotals> {
  const { results } = await db
    .prepare(
      `SELECT metric, SUM(value) AS v FROM store_daily
       WHERE provider = 'youtube' AND source = ? AND day BETWEEN ? AND ? GROUP BY metric`,
    )
    .bind(source, from, to)
    .all<{ metric: string; v: number }>();
  return Object.fromEntries(results.map((r) => [r.metric, r.v]));
}

export async function readVideoTotals(
  db: D1Database,
  source: string,
  from: string,
  to: string,
  limit: number,
): Promise<{ videos: VideoTotal[]; total: number; withViews: number }> {
  const { results } = await db
    .prepare(
      `SELECT v.video_id, v.title, v.published, v.kind, v.duration_s, v.privacy, v.campaigns,
              SUM(d.views) AS views, SUM(d.minutes) AS minutes,
              SUM(d.avg_view_s * d.views) AS s_w, SUM(d.avg_view_pct * d.views) AS p_w,
              SUM(d.subs_gained) AS subs, SUM(d.likes) AS likes, SUM(d.comments) AS comments
       FROM youtube_videos v
       JOIN youtube_video_daily d ON d.source = v.source AND d.video_id = v.video_id
       WHERE v.source = ? AND d.day BETWEEN ? AND ?
       GROUP BY v.video_id ORDER BY views DESC`,
    )
    .bind(source, from, to)
    .all<Record<string, string | number>>();
  const all = results.map((r) => {
    const views = Number(r.views);
    return {
      video_id: String(r.video_id),
      title: String(r.title),
      published: String(r.published),
      kind: String(r.kind),
      duration_s: Number(r.duration_s),
      privacy: String(r.privacy),
      campaigns: String(r.campaigns).split(",").filter(Boolean),
      views,
      minutes: Number(r.minutes),
      avg_view_s: views > 0 ? Number(r.s_w) / views : 0,
      avg_view_pct: views > 0 ? Number(r.p_w) / views : 0,
      subs_gained: Number(r.subs),
      likes: Number(r.likes),
      comments: Number(r.comments),
    } satisfies VideoTotal;
  });
  return {
    videos: all.slice(0, limit),
    total: all.length,
    withViews: all.filter((v) => v.views > 0).length,
  };
}

/** Ролик по id или по куску названия. Несколько совпадений — не угадываем, возвращаем все. */
export async function findVideos(
  db: D1Database,
  source: string,
  query: string,
): Promise<
  {
    video_id: string;
    title: string;
    published: string;
    kind: string;
    duration_s: number;
    privacy: string;
    campaigns: string;
  }[]
> {
  const { results } = await db
    .prepare(
      `SELECT video_id, title, published, kind, duration_s, privacy, campaigns FROM youtube_videos
       WHERE source = ? AND (video_id = ? OR title LIKE ? ESCAPE '\\') ORDER BY published DESC LIMIT 10`,
    )
    .bind(source, query, `%${query.replace(/[\\%_]/g, "\\$&")}%`)
    .all<{
      video_id: string;
      title: string;
      published: string;
      kind: string;
      duration_s: number;
      privacy: string;
      campaigns: string;
    }>();
  return results;
}

export async function readVideoSeries(
  db: D1Database,
  source: string,
  videoId: string,
  from: string,
  to: string,
): Promise<{ day: string; views: number; minutes: number; subs_gained: number }[]> {
  const { results } = await db
    .prepare(
      `SELECT day, views, minutes, subs_gained FROM youtube_video_daily
       WHERE source = ? AND video_id = ? AND day BETWEEN ? AND ? ORDER BY day`,
    )
    .bind(source, videoId, from, to)
    .all<{ day: string; views: number; minutes: number; subs_gained: number }>();
  return results;
}

/**
 * Что принесли кампании из описаний: визиты и клики в стор из НАШЕГО счётчика, сложенные по
 * метке через все сайты. Окно у счётчика скользящее («последние N суток от сейчас»), а у YouTube
 * кончается лагом, поэтому числа идут за окно от начала YouTube-окна до сегодня.
 */
export function campaignIndex(
  list: CampaignTotal[],
): Map<string, { visits: number; store_clicks: number }> {
  const out = new Map<string, { visits: number; store_clicks: number }>();
  for (const c of list) {
    const cur = out.get(c.utm_campaign) ?? { visits: 0, store_clicks: 0 };
    cur.visits += c.page_views;
    cur.store_clicks += c.store_clicks;
    out.set(c.utm_campaign, cur);
  }
  return out;
}

export type RawVisit = {
  ts: number;
  source: string;
  utm_campaign: string;
  path: string;
  anon: string;
  weight: number;
};

/** AE `FORMAT JSON` rows of buildYoutubeVisitsQuery → visits. AE timestamps are UTC without a zone. */
export function parseYoutubeVisits(payload: unknown): RawVisit[] {
  const rows = (payload as { data?: Record<string, unknown>[] } | null)?.data;
  if (!Array.isArray(rows)) return [];
  return rows.map((r) => {
    const raw = String(r.ts ?? "");
    return {
      ts: Date.parse(/Z|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(" ", "T")}Z`),
      source: String(r.source ?? ""),
      utm_campaign: String(r.utm_campaign ?? ""),
      path: String(r.path ?? ""),
      anon: String(r.anon ?? ""),
      weight: Number(r.weight ?? 1),
    };
  });
}

/** Gap that chains visits into one burst. Measured 8 Nov 2026: scanner hits landed 0-2 s apart. */
export const SCANNER_GAP_MS = 5000;
/** A chain touching this many different campaigns is a scanner: a person opens one video's link. */
export const SCANNER_MIN_CAMPAIGNS = 3;

/**
 * YouTube's link scanner renders each new description link with JS, so it looks like a browser.
 * Measured 8 Nov 2026, 10:49-10:52 UTC: 132 visits over 24+ campaigns in four minutes, several
 * anon ids on the same campaign and path within a second, and many lone hits on `/` or `/api`
 * with no collision at all. So the unit is a chain of youtube-tagged visits (any campaign, any
 * path) with gaps up to SCANNER_GAP_MS, and a chain is scanner traffic when it has either
 *  - a collision: the same campaign and path from two different anon ids, or
 *  - at least SCANNER_MIN_CAMPAIGNS different campaigns.
 * Real viewers (a few per video per day) do neither. The whole chain is dropped, first hit
 * included. Returns weighted visits to subtract per campaign.
 */
export function scannerVisits(visits: RawVisit[]): Map<string, number> {
  const out = new Map<string, number>();
  const flush = (chain: RawVisit[]) => {
    const anons = new Map<string, Set<string>>();
    for (const v of chain) {
      const k = `${v.utm_campaign}\u0000${v.path}`;
      const set = anons.get(k) ?? new Set<string>();
      set.add(v.anon);
      anons.set(k, set);
    }
    const collision = [...anons.values()].some((set) => set.size >= 2);
    const campaigns = new Set(chain.map((v) => v.utm_campaign)).size;
    if (!collision && campaigns < SCANNER_MIN_CAMPAIGNS) return;
    for (const v of chain) out.set(v.utm_campaign, (out.get(v.utm_campaign) ?? 0) + v.weight);
  };
  let chain: RawVisit[] = [];
  for (const v of [...visits].sort((x, y) => x.ts - y.ts)) {
    if (chain.length > 0 && v.ts - chain[chain.length - 1]!.ts > SCANNER_GAP_MS) {
      flush(chain);
      chain = [];
    }
    chain.push(v);
  }
  flush(chain);
  return out;
}

/** Visits per campaign minus scanner bursts; store clicks untouched (a scanner clicks nothing). */
export function withoutScanners(
  index: Map<string, { visits: number; store_clicks: number }>,
  scanners: Map<string, number>,
): void {
  for (const [c, n] of scanners) {
    const cur = index.get(c);
    if (cur) cur.visits = Math.max(0, cur.visits - n);
  }
}

const hours = (minutes: number) => `${(minutes / 60).toFixed(1)}h`;
const mmss = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s % 60)).padStart(2, "0")}`;
const int = (n: number) => Math.round(n).toLocaleString("en-US");

/** Метрики канала, сгруппированные по типу контента. */
export function formatChannel(t: ChannelTotals): string[] {
  const types = [
    ["long", "videos"],
    ["shorts", "shorts"],
    ["live", "live"],
  ] as const;
  const lines = types.map(([k, label]) => {
    const views = t[`views_${k}`] ?? 0;
    const gained = t[`subs_gained_${k}`] ?? 0;
    const lost = t[`subs_lost_${k}`] ?? 0;
    return (
      `- ${label}: ${int(views)} views, ${hours(t[`watch_minutes_${k}`] ?? 0)} watched, ` +
      `subscribers +${int(gained)} / -${int(lost)}`
    );
  });
  const sum = (p: string) => types.reduce((a, [k]) => a + (t[`${p}_${k}`] ?? 0), 0);
  lines.push(
    `- all: ${int(sum("views"))} views, ${hours(sum("watch_minutes"))} watched, ` +
      `net subscribers ${sum("subs_gained") - sum("subs_lost") >= 0 ? "+" : ""}${int(sum("subs_gained") - sum("subs_lost"))}`,
  );
  return lines;
}

export function formatVideoRow(
  v: VideoTotal,
  c: Map<string, { visits: number; store_clicks: number }> | undefined,
): string {
  let site: string;
  if (v.campaigns.length === 0) site = "no tagged link in description";
  else if (c === undefined) site = `campaign ${v.campaigns.join(", ")} (site numbers unavailable)`;
  else {
    const hit = v.campaigns.map((n) => c.get(n) ?? { visits: 0, store_clicks: 0 });
    site =
      `campaign ${v.campaigns.join(", ")}: ${int(hit.reduce((a, x) => a + x.visits, 0))} site visits, ` +
      `${int(hit.reduce((a, x) => a + x.store_clicks, 0))} store clicks`;
  }
  return (
    `- ${v.title.slice(0, 70)} [${v.video_id}] ${v.kind}${v.privacy === "public" ? "" : `, ${v.privacy}`} — ` +
    `${int(v.views)} views, ${hours(v.minutes)}, avg ${mmss(v.avg_view_s)} (${v.avg_view_pct.toFixed(0)}% of video), ` +
    `subs +${int(v.subs_gained)}, ${int(v.likes)} likes, ${int(v.comments)} comments; ${site}`
  );
}

export type RetentionPoint = { at: number; watching: number; relative: number };

/**
 * Где аудитория уходит. `watching` это доля зрителей, ещё смотрящих на этой точке, и она бывает
 * выше единицы (пересмотры), так что «падение» считается разностью соседних точек, а не от
 * единицы. Первые 3% пропускаются при поиске обрыва: там отваливаются те, кто нажал случайно, и
 * это почти всегда самый крутой спуск любого ролика, ничего не говорящий о содержании.
 */
export function summarizeRetention(points: RetentionPoint[]): {
  at: { pct: number; watching: number }[];
  steepest: { from: number; to: number; drop: number } | undefined;
  relative: number | undefined;
} {
  const byPct = new Map(points.map((p) => [Math.round(p.at * 100), p]));
  const at = [10, 25, 50, 75, 100].flatMap((pct) => {
    const p = byPct.get(pct);
    return p === undefined ? [] : [{ pct, watching: p.watching }];
  });
  let steepest: { from: number; to: number; drop: number } | undefined;
  const sorted = [...points].sort((a, b) => a.at - b.at);
  for (let i = 1; i < sorted.length; i += 1) {
    if (sorted[i]!.at <= 0.03) continue;
    const drop = sorted[i - 1]!.watching - sorted[i]!.watching;
    if (steepest === undefined || drop > steepest.drop) {
      steepest = {
        from: Math.round(sorted[i - 1]!.at * 100),
        to: Math.round(sorted[i]!.at * 100),
        drop,
      };
    }
  }
  const rel = points.map((p) => p.relative).filter((x) => Number.isFinite(x));
  return {
    at,
    steepest,
    relative: rel.length === 0 ? undefined : rel.reduce((a, b) => a + b, 0) / rel.length,
  };
}

export function formatRetention(points: RetentionPoint[], durationS: number): string[] {
  if (points.length === 0)
    return ["Retention: no curve (too few views for YouTube to publish one)."];
  const s = summarizeRetention(points);
  const lines = [
    "Retention (share of viewers still watching): " +
      s.at.map((x) => `${x.pct}% in → ${(x.watching * 100).toFixed(0)}%`).join(", ") +
      ". Above 100% means rewatching.",
  ];
  if (s.steepest !== undefined) {
    const t = (pct: number) => mmss((durationS * pct) / 100);
    lines.push(
      `Steepest drop: ${(s.steepest.drop * 100).toFixed(1)} points between ${s.steepest.from}% and ` +
        `${s.steepest.to}% of the video (${t(s.steepest.from)}–${t(s.steepest.to)}), first 3% ignored.`,
    );
  }
  if (s.relative !== undefined) {
    lines.push(
      `Versus YouTube's comparison set (videos of similar length): ${s.relative.toFixed(2)} ` +
        "(0.5 = typical, above is better).",
    );
  }
  return lines;
}

export const defaultChannel = () => CHANNELS[0];
