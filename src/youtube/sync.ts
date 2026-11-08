/**
 * Суточный джоб YouTube: канал по типам контента → `store_daily`, ролики → свои таблицы.
 *
 * Дёшево по построению. Analytics API отдаёт целое окно одним вызовом (`day,creatorContentType`
 * для канала, `day,video` для всех роликов сразу), поэтому первый запуск, который забирает
 * ВСЮ историю с 2020 года, стоит столько же подзапросов, сколько обычный: токен, плейлист,
 * `videos.list`, типы, два отчёта. Бэкфилл это не кампания из чанков, а просто первый запуск.
 *
 * Отдельный крон по той же причине, что и у GA4: свои пятьдесят подзапросов, а не остаток от
 * соседей по утреннему слоту.
 */
import { CHANNELS } from "../registry.generated";
import { readSync, writeRows, writeSync } from "../stores/db";
import { dayBefore, utcDay } from "../stores/schema";
import {
  accessToken,
  channelRows,
  chooseKind,
  extractCampaigns,
  fetchChannelDays,
  fetchKinds,
  fetchVideoDays,
  fetchVideoMeta,
  isConfigured,
  videoDayRows,
  type Fetcher,
  type VideoDayRow,
  type VideoMeta,
  type Kind,
  type YoutubeEnv,
} from "./api";

/** Значение должно совпадать со строкой в `wrangler.jsonc`; на совпадение есть тест. */
export const YT_CRON = "40 5 * * *";

/**
 * Сколько суток назад от водяного знака перечитывать. YouTube досчитывает свежие дни, и
 * измеренный лаг на 8 ноября 2026 был трое суток (последний день данных — 5 ноября), так что
 * знак стоит на последнем дне, ГДЕ ДАННЫЕ ЕСТЬ, и пять суток запаса накрывают уточнения.
 */
export const YT_RESTATE_DAYS = 5;

/** Водяные знаки раздельно: два отчёта, и один может отстать от другого. */
export const CHANNEL_PROVIDER = "youtube";
export const VIDEO_PROVIDER = "youtube-videos";

/**
 * Окно запроса. Нет знака — вся история с `since`. Есть — от знака минус запас, и это же
 * лечит пропущенный запуск: окно начинается там, где данные кончились, а не со вчера.
 * Конец — вчера: сегодняшних суток в отчёте нет, а лишний день в запросе ничего не стоит.
 */
export function planWindow(now: number, since: string, through: string | undefined): { from: string; to: string } {
  const to = dayBefore(utcDay(now), 1);
  const from = through === undefined ? since : dayBefore(through, YT_RESTATE_DAYS);
  return { from: from < since ? since : from, to };
}

export type YoutubeSyncResult = {
  provider: "youtube";
  source: string;
  from: string;
  to: string;
  through: string;
  videos: number;
  channel_rows: number;
  video_rows: number;
  notes: string[];
};

const BATCH = 400;

export async function writeVideoDays(db: D1Database, source: string, rows: VideoDayRow[], now: number): Promise<number> {
  const stmt = db.prepare(
    `INSERT INTO youtube_video_daily
       (day, source, video_id, views, minutes, avg_view_s, avg_view_pct, subs_gained, likes, shares, comments, fetched)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (day, source, video_id) DO UPDATE SET
       views = excluded.views, minutes = excluded.minutes, avg_view_s = excluded.avg_view_s,
       avg_view_pct = excluded.avg_view_pct, subs_gained = excluded.subs_gained, likes = excluded.likes,
       shares = excluded.shares, comments = excluded.comments, fetched = excluded.fetched`,
  );
  for (let i = 0; i < rows.length; i += BATCH) {
    await db.batch(
      rows
        .slice(i, i + BATCH)
        .map((r) =>
          stmt.bind(r.day, source, r.video_id, r.views, r.minutes, r.avg_view_s, r.avg_view_pct,
            r.subs_gained, r.likes, r.shares, r.comments, now),
        ),
    );
  }
  return rows.length;
}

export async function writeVideoMeta(
  db: D1Database,
  source: string,
  metas: VideoMeta[],
  kinds: Map<string, Map<Kind, number>>,
  now: number,
): Promise<number> {
  const stmt = db.prepare(
    `INSERT INTO youtube_videos (source, video_id, title, published, kind, duration_s, privacy, campaigns, fetched)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (source, video_id) DO UPDATE SET
       title = excluded.title, published = excluded.published, kind = excluded.kind,
       duration_s = excluded.duration_s, privacy = excluded.privacy, campaigns = excluded.campaigns,
       fetched = excluded.fetched`,
  );
  for (let i = 0; i < metas.length; i += BATCH) {
    await db.batch(
      metas
        .slice(i, i + BATCH)
        .map((m) =>
          stmt.bind(source, m.video_id, m.title, m.published, chooseKind(m, kinds.get(m.video_id)),
            m.duration_s, m.privacy, extractCampaigns(m.description).join(","), now),
        ),
    );
  }
  return metas.length;
}

export async function syncYoutube(
  env: YoutubeEnv & { STORES?: D1Database },
  now: number,
  explicitFrom?: string,
  doFetch: Fetcher = fetch,
): Promise<YoutubeSyncResult[]> {
  const results: YoutubeSyncResult[] = [];
  for (const channel of CHANNELS) {
    const result: YoutubeSyncResult = {
      provider: "youtube", source: channel.id, from: "", to: "", through: "",
      videos: 0, channel_rows: 0, video_rows: 0, notes: [],
    };
    results.push(result);
    if (env.STORES === undefined) { result.notes.push("no D1"); continue; }
    if (!isConfigured(env)) {
      result.notes.push("not configured: YT_CLIENT_ID, YT_CLIENT_SECRET, YT_REFRESH_TOKEN");
      continue;
    }
    try {
      const token = await accessToken(env, doFetch);
      const prev = await readSync(env.STORES, CHANNEL_PROVIDER);
      const prevVideos = await readSync(env.STORES, VIDEO_PROVIDER);
      const window = planWindow(now, channel.since, prev.get(channel.id));
      const videoWindow = planWindow(now, channel.since, prevVideos.get(channel.id));
      // Явный ?from= — для ручного добора, и он раньше обоих знаков.
      const from = explicitFrom ?? window.from;
      const videoFrom = explicitFrom ?? videoWindow.from;
      result.from = from;
      result.to = window.to;

      const metas = await fetchVideoMeta(token, channel.channelId, doFetch);
      result.videos = metas.length;
      const ids = metas.map((m) => m.video_id);
      const kinds = await fetchKinds(token, channel.since, window.to, ids, doFetch);
      await writeVideoMeta(env.STORES, channel.id, metas, kinds, now);

      const chRows = await fetchChannelDays(token, from, window.to, doFetch);
      result.channel_rows = await writeRows(env.STORES, channelRows(chRows, channel.id), now);
      const chThrough = chRows.map((r) => String(r[0])).sort().pop();
      if (chThrough !== undefined) {
        result.through = chThrough;
        await writeSync(env.STORES, CHANNEL_PROVIDER, new Map([[channel.id, chThrough]]), now);
      }

      const vRows = videoDayRows(await fetchVideoDays(token, videoFrom, window.to, ids, doFetch));
      result.video_rows = await writeVideoDays(env.STORES, channel.id, vRows, now);
      const vThrough = vRows.map((r) => r.day).sort().pop();
      if (vThrough !== undefined) {
        await writeSync(env.STORES, VIDEO_PROVIDER, new Map([[channel.id, vThrough]]), now);
      }
    } catch (error) {
      // Водяные знаки не сдвинуты: следующий запуск начнёт с того же места.
      result.notes.push(String(error));
    }
  }
  return results;
}
