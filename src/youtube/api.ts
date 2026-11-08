/**
 * YouTube: что канал и ролики сделали за сутки, чужими словами.
 *
 * Два API, и они не взаимозаменяемы. Data API v3 знает, ЧТО лежит на канале (название, дата,
 * длительность, описание). Analytics API v2 знает, ЧТО С ЭТИМ СДЕЛАЛИ ЛЮДИ (просмотры, минуты,
 * подписки). Join между ними один — `video_id`.
 *
 * ЧЕГО В API НЕТ. Показы миниатюры и CTR (`videoThumbnailImpressions*`) отвечают HTTP 400 для
 * этого канала: их отдаёт только Studio. Выдумывать их из просмотров нельзя, поэтому их здесь
 * нет вовсе, и в `docs/metrics.md` это написано словами.
 *
 * Ходит крон в воркере, а не ноутбук: канал должен продолжать считаться, пока Mac спит.
 * Ключи не лежат в коде — `YT_CLIENT_ID`, `YT_CLIENT_SECRET`, `YT_REFRESH_TOKEN`.
 */
import type { StoreRow } from "../stores/schema";

const TOKEN_URL = "https://oauth2.googleapis.com/token";
const DATA = "https://www.googleapis.com/youtube/v3";
const ANALYTICS = "https://youtubeanalytics.googleapis.com/v2/reports";

export type YoutubeEnv = {
  YT_CLIENT_ID?: string;
  YT_CLIENT_SECRET?: string;
  YT_REFRESH_TOKEN?: string;
};

/** `fetch` подменяется в тестах: сеть в них запрещена, а форму запроса проверить надо. */
export type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * Запрос обновления токена. Отдельной функцией ради теста: ошибка в форме этого запроса не
 * падает громко, Google отвечает 400 `invalid_grant`, и выглядит это как «токен протух».
 */
export function refreshRequest(env: Required<YoutubeEnv>): { url: string; init: RequestInit } {
  return {
    url: TOKEN_URL,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: env.YT_CLIENT_ID,
        client_secret: env.YT_CLIENT_SECRET,
        refresh_token: env.YT_REFRESH_TOKEN,
        grant_type: "refresh_token",
      }).toString(),
    },
  };
}

export function isConfigured<T extends YoutubeEnv>(env: T): env is T & Required<YoutubeEnv> {
  return Boolean(env.YT_CLIENT_ID && env.YT_CLIENT_SECRET && env.YT_REFRESH_TOKEN);
}

/**
 * Access token из refresh token. Не кэшируется: крон ходит раз в сутки, MCP — по запросу, а
 * токен живёт час. Тело ответа Google в ошибку НЕ попадает целиком — только код: в нём
 * бывают подробности, которым место не в логе.
 */
export async function accessToken(env: Required<YoutubeEnv>, doFetch: Fetcher = fetch): Promise<string> {
  const { url, init } = refreshRequest(env);
  const res = await doFetch(url, init);
  if (!res.ok) {
    let reason = "";
    try {
      reason = String(((await res.json()) as { error?: unknown }).error ?? "");
    } catch {
      /* тело не JSON — достаточно статуса */
    }
    throw new Error(`youtube token refresh: HTTP ${res.status} ${reason}`.trim());
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) throw new Error("youtube token refresh: no access_token in the answer");
  return body.access_token;
}

async function getJson(url: string, token: string, doFetch: Fetcher): Promise<unknown> {
  const res = await doFetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    throw new Error(`youtube ${new URL(url).pathname}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  return res.json();
}

// ---------------------------------------------------------------- метаданные (Data API)

export type VideoMeta = {
  video_id: string;
  title: string;
  published: string;
  duration_s: number;
  privacy: string;
  live: boolean;
  description: string;
};

/** `PT1H2M3S` → секунды. Незнакомое → 0, а не NaN: ролик не должен ронять джоб. */
export function parseDuration(iso: string): number {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(iso);
  if (!m) return 0;
  const [d, h, mi, s] = [m[1], m[2], m[3], m[4]].map((x) => Number(x ?? 0));
  return d! * 86400 + h! * 3600 + mi! * 60 + s!;
}

/** Плейлист загрузок канала: `UC…` → `UU…`. Это соглашение API, отдельного вызова не нужно. */
export const uploadsPlaylist = (channelId: string): string => `UU${channelId.slice(2)}`;

export async function fetchVideoMeta(
  token: string,
  channelId: string,
  doFetch: Fetcher = fetch,
): Promise<VideoMeta[]> {
  const ids: string[] = [];
  let page: string | undefined;
  do {
    const q = new URLSearchParams({
      part: "contentDetails",
      playlistId: uploadsPlaylist(channelId),
      maxResults: "50",
    });
    if (page) q.set("pageToken", page);
    const body = (await getJson(`${DATA}/playlistItems?${q}`, token, doFetch)) as {
      items?: { contentDetails?: { videoId?: string } }[];
      nextPageToken?: string;
    };
    for (const item of body.items ?? []) {
      if (item.contentDetails?.videoId) ids.push(item.contentDetails.videoId);
    }
    page = body.nextPageToken;
  } while (page);

  const out: VideoMeta[] = [];
  for (let i = 0; i < ids.length; i += 50) {
    const q = new URLSearchParams({
      part: "snippet,contentDetails,status,liveStreamingDetails",
      id: ids.slice(i, i + 50).join(","),
    });
    const body = (await getJson(`${DATA}/videos?${q}`, token, doFetch)) as {
      items?: {
        id: string;
        snippet?: { title?: string; publishedAt?: string; description?: string };
        contentDetails?: { duration?: string };
        status?: { privacyStatus?: string };
        liveStreamingDetails?: unknown;
      }[];
    };
    for (const v of body.items ?? []) {
      out.push({
        video_id: v.id,
        title: v.snippet?.title ?? "",
        published: v.snippet?.publishedAt ?? "",
        duration_s: parseDuration(v.contentDetails?.duration ?? ""),
        privacy: v.status?.privacyStatus ?? "",
        live: v.liveStreamingDetails !== undefined,
        description: v.snippet?.description ?? "",
      });
    }
  }
  return out;
}

/**
 * `utm_campaign` из ссылок в описании. Сопоставление ролик → кампания держится на этом, а не на
 * имени: метка в адресе доезжает всегда, реферер из приложения YouTube — не всегда.
 *
 * Ссылка может быть в тексте с хвостовой пунктуацией («…?utm_campaign=a.»), в скобках, с `&amp;`
 * из HTML и с процентным кодированием. Порядок первого появления сохраняется, повторы — нет.
 */
export function extractCampaigns(description: string): string[] {
  const found: string[] = [];
  for (const raw of description.match(/https?:\/\/[^\s<>"')\]]+/g) ?? []) {
    const cleaned = raw.replace(/&amp;/g, "&").replace(/[.,;:!?»]+$/, "");
    let value: string | null = null;
    try {
      value = new URL(cleaned).searchParams.get("utm_campaign");
    } catch {
      continue;
    }
    if (value !== null && value !== "" && !found.includes(value)) found.push(value);
  }
  return found;
}

export type Kind = "shorts" | "long" | "live";

/** Тип отчёта YouTube → наш. Незнакомое не угадывается: возвращается `undefined`. */
export function kindOfContentType(t: string): Kind | undefined {
  if (t === "shorts") return "shorts";
  if (t === "videoOnDemand") return "long";
  if (t === "liveStream") return "live";
  return undefined;
}

/**
 * Тип ролика. Первое слово у самой YouTube (`creatorContentType` за всё время), потому что
 * «Shorts» это не только длительность: вертикальный двухминутный ролик — Shorts, а горизонтальный
 * — нет. Для ролика без просмотров отчёта нет, и тогда: был эфир → live, до минуты → shorts.
 */
export function chooseKind(meta: VideoMeta, byViews: Map<Kind, number> | undefined): Kind {
  if (byViews !== undefined && byViews.size > 0) {
    return [...byViews].sort((a, b) => b[1] - a[1])[0]![0];
  }
  if (meta.live) return "live";
  return meta.duration_s > 0 && meta.duration_s <= 60 ? "shorts" : "long";
}

// ---------------------------------------------------------------- отчёты (Analytics API)

type Report = { rows?: (string | number)[][] };

async function report(
  token: string,
  params: Record<string, string>,
  doFetch: Fetcher,
): Promise<(string | number)[][]> {
  const rows: (string | number)[][] = [];
  // Страницы по 10000; startIndex с единицы. Одной страницы хватает на годы, но цикл дешевле
  // однажды молча обрезанной истории.
  for (let start = 1; ; ) {
    const q = new URLSearchParams({
      ids: "channel==MINE",
      maxResults: "10000",
      startIndex: String(start),
      ...params,
    });
    const body = (await getJson(`${ANALYTICS}?${q}`, token, doFetch)) as Report;
    const page = body.rows ?? [];
    rows.push(...page);
    if (page.length < 10000) return rows;
    start += page.length;
  }
}

/** Канал по суткам и типам контента. Один вызов — вся история. */
export async function fetchChannelDays(
  token: string,
  from: string,
  to: string,
  doFetch: Fetcher = fetch,
): Promise<(string | number)[][]> {
  return report(
    token,
    {
      startDate: from,
      endDate: to,
      dimensions: "day,creatorContentType",
      metrics: "views,estimatedMinutesWatched,subscribersGained,subscribersLost",
      sort: "day",
    },
    doFetch,
  );
}

/**
 * Каждый ролик за каждые сутки. `dimensions=day,video` разрешено только с фильтром по роликам
 * (до 500 id), зато отдаёт всё окно одним вызовом: история в 2536 ролико-суток — одна страница.
 */
export async function fetchVideoDays(
  token: string,
  from: string,
  to: string,
  ids: string[],
  doFetch: Fetcher = fetch,
): Promise<(string | number)[][]> {
  const out: (string | number)[][] = [];
  for (let i = 0; i < ids.length; i += 500) {
    out.push(
      ...(await report(
        token,
        {
          startDate: from,
          endDate: to,
          dimensions: "day,video",
          metrics:
            "views,estimatedMinutesWatched,averageViewDuration,averageViewPercentage," +
            "subscribersGained,likes,shares,comments",
          filters: `video==${ids.slice(i, i + 500).join(",")}`,
          sort: "day",
        },
        doFetch,
      )),
    );
  }
  return out;
}

/** Просмотры ролика по типу контента за всё время — основа для `chooseKind`. */
export async function fetchKinds(
  token: string,
  since: string,
  to: string,
  ids: string[],
  doFetch: Fetcher = fetch,
): Promise<Map<string, Map<Kind, number>>> {
  const out = new Map<string, Map<Kind, number>>();
  for (let i = 0; i < ids.length; i += 500) {
    const rows = await report(
      token,
      {
        startDate: since,
        endDate: to,
        dimensions: "video,creatorContentType",
        metrics: "views",
        filters: `video==${ids.slice(i, i + 500).join(",")}`,
      },
      doFetch,
    );
    for (const [video, type, views] of rows) {
      const kind = kindOfContentType(String(type));
      if (kind === undefined) continue;
      const m = out.get(String(video)) ?? new Map<Kind, number>();
      m.set(kind, (m.get(kind) ?? 0) + Number(views));
      out.set(String(video), m);
    }
  }
  return out;
}

/** Кривая удержания: доля зрителей, ещё смотрящих, на каждой из 100 точек ролика. */
export async function fetchRetention(
  token: string,
  videoId: string,
  from: string,
  to: string,
  doFetch: Fetcher = fetch,
): Promise<{ at: number; watching: number; relative: number }[]> {
  const rows = await report(
    token,
    {
      startDate: from,
      endDate: to,
      dimensions: "elapsedVideoTimeRatio",
      metrics: "audienceWatchRatio,relativeRetentionPerformance",
      filters: `video==${videoId}`,
    },
    doFetch,
  );
  return rows.map((r) => ({ at: Number(r[0]), watching: Number(r[1]), relative: Number(r[2]) }));
}

/** Откуда пришли просмотры ролика: подписчики, поиск YouTube, внешние ссылки, Shorts… */
export async function fetchTrafficSources(
  token: string,
  videoId: string,
  from: string,
  to: string,
  doFetch: Fetcher = fetch,
): Promise<{ source: string; views: number; minutes: number }[]> {
  const rows = await report(
    token,
    {
      startDate: from,
      endDate: to,
      dimensions: "insightTrafficSourceType",
      metrics: "views,estimatedMinutesWatched",
      filters: `video==${videoId}`,
      sort: "-views",
    },
    doFetch,
  );
  return rows.map((r) => ({ source: String(r[0]), views: Number(r[1]), minutes: Number(r[2]) }));
}

// ---------------------------------------------------------------- строки для D1

/** Метрики канала в `store_daily`: тип контента — в имени, а не в `campaign` или `country`. */
const CHANNEL_SUFFIX: Record<string, string> = { shorts: "shorts", videoOnDemand: "long", liveStream: "live" };

/**
 * Строки канала для `store_daily`. Нули пишутся: день, в который канал смотрели ноль раз, —
 * факт, а отсутствие строки читается как «данных ещё нет».
 */
export function channelRows(rows: (string | number)[][], source: string): StoreRow[] {
  const out: StoreRow[] = [];
  for (const [day, type, views, minutes, gained, lost] of rows) {
    const suffix = CHANNEL_SUFFIX[String(type)];
    // Незнакомый тип не записывается под выдуманным именем: лучше пропуск, о котором скажет
    // тест на новый тип, чем строка, смысл которой никто не помнит.
    if (suffix === undefined) continue;
    const base = { day: String(day), source, provider: "youtube", campaign: "", country: "" };
    out.push(
      { ...base, metric: `views_${suffix}`, value: Number(views) },
      { ...base, metric: `watch_minutes_${suffix}`, value: Number(minutes) },
      { ...base, metric: `subs_gained_${suffix}`, value: Number(gained) },
      { ...base, metric: `subs_lost_${suffix}`, value: Number(lost) },
    );
  }
  return out;
}

export type VideoDayRow = {
  day: string;
  video_id: string;
  views: number;
  minutes: number;
  avg_view_s: number;
  avg_view_pct: number;
  subs_gained: number;
  likes: number;
  shares: number;
  comments: number;
};

export function videoDayRows(rows: (string | number)[][]): VideoDayRow[] {
  return rows.map((r) => ({
    day: String(r[0]),
    video_id: String(r[1]),
    views: Number(r[2]),
    minutes: Number(r[3]),
    avg_view_s: Number(r[4]),
    avg_view_pct: Number(r[5]),
    subs_gained: Number(r[6]),
    likes: Number(r[7]),
    shares: Number(r[8]),
    comments: Number(r[9]),
  }));
}
