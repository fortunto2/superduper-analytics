/**
 * Два инструмента MCP про YouTube. Тонкий слой: данные из D1 и живые вызовы Analytics API,
 * тексты собирает `read.ts`.
 */
import { askSql, buildCampaignQuery, parseCampaigns, type StatsEnv } from "../stats";
import { RETENTION_DAYS } from "../schema";
import { daysBetween, utcDay } from "../stores/schema";
import {
  accessToken,
  fetchRetention,
  fetchTrafficSources,
  isConfigured,
  type Fetcher,
  type YoutubeEnv,
} from "./api";
import {
  campaignIndex,
  defaultChannel,
  findVideos,
  formatChannel,
  formatRetention,
  formatVideoRow,
  readChannelTotals,
  readThrough,
  readVideoSeries,
  readVideoTotals,
  windowTo,
} from "./read";

export type YoutubeToolEnv = YoutubeEnv & StatsEnv & { STORES?: D1Database };

const MAX_DAYS = 730;

/**
 * The API's names for traffic sources that read as something else. SUBSCRIBER is the worst:
 * on 8 Nov 2026 it was 61% of a talk's views on a 64-subscriber channel, because it is YouTube's
 * "Browse features" (home page included), not people who subscribed.
 */
export const SOURCE_MEANING: Record<string, string> = {
  SUBSCRIBER: "browse features: home page and subscriptions feed, not only subscribers",
  NO_LINK_OTHER: "direct or unknown",
  YT_OTHER_PAGE: "other YouTube pages",
  SHORTS: "Shorts feed",
  EXT_URL: "links from other sites",
};

export function youtubeDays(args: Record<string, unknown>): number {
  const asked = Number(args.days ?? 28);
  if (!Number.isInteger(asked) || asked < 1) return 28;
  return Math.min(asked, MAX_DAYS);
}

export const YOUTUBE_TOOLS = [
  {
    name: "youtube",
    title: "How the YouTube channel is doing, and what its videos send to the site",
    description:
      "Channel totals by content type (long videos, shorts, live: views, watch hours, subscribers " +
      "gained and lost) and a ranking of videos by views with watch time, average view duration, " +
      "average % viewed, subscribers gained, likes and comments. Each video also carries the " +
      "site visits and store clicks of the utm_campaign tags found in its description, from OUR " +
      "counter; a video with no tagged link says so, which is itself the finding: its viewers " +
      "cannot be followed to the site. The window ends at the last day YouTube has reported " +
      "(it lags 2-3 days), and the output says which. Impressions and click-through rate are " +
      "NOT available: YouTube does not expose them through the API, only in Studio.",
    inputSchema: {
      type: "object",
      properties: {
        days: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DAYS,
          description: "Window in days, default 28.",
        },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 100,
          description: "Videos to list, default 15.",
        },
      },
    },
  },
  {
    name: "youtube_video",
    title: "One YouTube video: daily views, where viewers drop off, where they came from",
    description:
      "One video by id or by a piece of its title: totals and daily views for the window from the " +
      "stored data, plus two LIVE reads from YouTube: the retention curve (share of viewers still " +
      "watching at 10/25/50/75% and the steepest drop) and traffic sources (subscribers, YouTube " +
      "search, suggested, external links, Shorts feed). The live reads need YouTube credentials " +
      "and say so when they are missing.",
    inputSchema: {
      type: "object",
      properties: {
        video: { type: "string", description: "Video id, or a fragment of the title." },
        days: {
          type: "integer",
          minimum: 1,
          maximum: MAX_DAYS,
          description: "Window in days, default 28.",
        },
      },
      required: ["video"],
    },
  },
] as const;

type Out = { text: string; isError?: boolean };

export async function runYoutubeTool(
  name: "youtube" | "youtube_video",
  args: Record<string, unknown>,
  env: YoutubeToolEnv,
  now: number,
  doFetch: Fetcher = fetch,
): Promise<Out> {
  const channel = defaultChannel();
  if (channel === undefined || env.STORES === undefined) {
    return {
      text: "No YouTube channel is registered (registry/sources.yaml → channels).",
      isError: true,
    };
  }
  const through = await readThrough(env.STORES, channel.id);
  if (through === undefined) {
    return {
      text: "No YouTube data stored yet. The daily job (05:40 UTC) or POST /v1/youtube/sync fills it.",
      isError: true,
    };
  }
  const days = youtubeDays(args);
  const { from, to } = windowTo(through, days);
  const header =
    `${channel.name}, ${from} .. ${to} (${days} day(s)). YouTube reports up to ${to}; ` +
    `today is ${utcDay(now)}, so the last ${daysBetween(to, utcDay(now)).length - 1} day(s) are not in yet.`;

  if (name === "youtube") {
    const limit = Math.min(Math.max(Number(args.limit ?? 15) || 15, 1), 100);
    const [totals, { videos, total, withViews }] = await Promise.all([
      readChannelTotals(env.STORES, channel.id, from, to),
      readVideoTotals(env.STORES, channel.id, from, to, limit),
    ]);

    // Метки считает НАШ счётчик; он скользящий от «сейчас», поэтому окно берётся от начала
    // YouTube-окна до сегодня. Не удалось прочитать — ролики без цифр сайта, а не без роликов.
    let index: ReturnType<typeof campaignIndex> | undefined;
    const tagged = videos.some((v) => v.campaigns.length > 0);
    if (tagged) {
      const span = Math.min(daysBetween(from, utcDay(now)).length, RETENTION_DAYS);
      try {
        const res = await askSql(env, buildCampaignQuery(env.DATASET, span));
        if (res.ok) index = campaignIndex(parseCampaigns(await res.json()));
      } catch {
        index = undefined;
      }
    }
    const untagged = videos.filter((v) => v.campaigns.length === 0).length;
    return {
      text: [
        header,
        "",
        "Channel:",
        ...formatChannel(totals),
        "",
        `Videos with views in the window: ${withViews} of ${total} known. Top ${videos.length} by views:`,
        ...videos.map((v) => formatVideoRow(v, index)),
        "",
        `${untagged} of these ${videos.length} have no utm_campaign link in the description, so nobody ` +
          "they send to the site can be told apart from direct traffic." +
          (tagged
            ? " Site visits and store clicks are our counter's, summed per tag across all sites, " +
              `over the last ${Math.min(daysBetween(from, utcDay(now)).length, RETENTION_DAYS)} days up to now.`
            : ""),
        "Impressions and CTR are not available through the API (Studio only). Average % viewed " +
          "and average duration are weighted by views across the window.",
      ].join("\n"),
    };
  }

  // youtube_video
  const query = String(args.video ?? "").trim();
  if (query === "")
    return { text: "`video` is required: an id or a fragment of the title.", isError: true };
  const found = await findVideos(env.STORES, channel.id, query);
  if (found.length === 0) return { text: `No video matches "${query}".`, isError: true };
  if (found.length > 1 && found[0]!.video_id !== query) {
    return {
      text: [
        `"${query}" matches ${found.length} videos, say which (pass the id):`,
        ...found.map((v) => `- ${v.video_id} ${v.published.slice(0, 10)} ${v.title}`),
      ].join("\n"),
    };
  }
  const video = found[0]!;
  const series = await readVideoSeries(env.STORES, channel.id, video.video_id, from, to);
  const sum = (f: (r: (typeof series)[number]) => number) => series.reduce((a, r) => a + f(r), 0);
  const lines = [
    header,
    "",
    `${video.title} [${video.video_id}]`,
    `${video.kind}, ${video.privacy}, published ${video.published.slice(0, 10)}, ${Math.round((video.duration_s / 60) * 10) / 10} min; ` +
      (video.campaigns === "" ? "no tagged link in description" : `campaign ${video.campaigns}`),
    `Window: ${Math.round(sum((r) => r.views))} views, ${(sum((r) => r.minutes) / 60).toFixed(1)}h watched, ` +
      `subscribers +${Math.round(sum((r) => r.subs_gained))}.`,
    "",
    "Daily views (days with views only): " +
      (series
        .filter((r) => r.views > 0)
        .map((r) => `${r.day.slice(5)} ${Math.round(r.views)}`)
        .join(", ") || "none"),
    "",
  ];

  if (!isConfigured(env)) {
    lines.push(
      "Live reads (retention, traffic sources) unavailable: YT_* secrets are not set on the Worker.",
    );
    return { text: lines.join("\n") };
  }
  try {
    const token = await accessToken(env, doFetch);
    const [curve, sources] = await Promise.all([
      fetchRetention(token, video.video_id, video.published.slice(0, 10), to, doFetch),
      fetchTrafficSources(token, video.video_id, from, to, doFetch),
    ]);
    lines.push(
      ...formatRetention(curve, video.duration_s),
      "  (retention is over the video's whole life, not the window)",
      "",
    );
    const totalViews = sources.reduce((a, s) => a + s.views, 0);
    lines.push(
      `Traffic sources in the window (${Math.round(totalViews)} views):`,
      ...sources.map(
        (s) =>
          `- ${s.source}${SOURCE_MEANING[s.source] ? ` (${SOURCE_MEANING[s.source]})` : ""}: ${s.views} ` +
          `(${totalViews > 0 ? Math.round((s.views / totalViews) * 100) : 0}%)`,
      ),
    );
  } catch (error) {
    lines.push(`Live reads failed: ${String(error)}`);
  }
  return { text: lines.join("\n") };
}
