/**
 * YouTube: чужие числа, и вся ценность в том, что они сопоставлены с нашими по метке. Проверяется
 * то, где это сопоставление ломается молча: разбор описаний, раскладка ответа API по строкам,
 * окно перечитывания и форма запроса токена. Без сети и без ключей.
 */
import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import schemaSql from "../db/schema.sql?raw";
import wranglerConfig from "../wrangler.jsonc?raw";
import {
  accessToken,
  channelRows,
  chooseKind,
  extractCampaigns,
  parseDuration,
  refreshRequest,
  uploadsPlaylist,
  videoDayRows,
  type VideoMeta,
} from "../src/youtube/api";
import { readTotals } from "../src/stores/db";
import {
  formatVideoRow,
  parseYoutubeVisits,
  scannerVisits,
  summarizeRetention,
  withoutScanners,
  type VideoTotal,
} from "../src/youtube/read";
import { planWindow, syncYoutube, YT_CRON, YT_RESTATE_DAYS } from "../src/youtube/sync";
import { runYoutubeTool } from "../src/youtube/tool";

const SECRETS = { YT_CLIENT_ID: "cid", YT_CLIENT_SECRET: "csecret", YT_REFRESH_TOKEN: "rtoken" };

describe("метка в описании ролика", () => {
  it("берёт utm_campaign из размеченной ссылки", () => {
    expect(
      extractCampaigns(
        "Сайт: https://life2film.com/?utm_source=youtube&utm_campaign=youtube-bulat-01",
      ),
    ).toEqual(["youtube-bulat-01"]);
  });

  it("не находит ничего там, где ссылки не размечены — это и есть вывод", () => {
    expect(
      extractCampaigns("https://life2film.com\nhttps://youtu.be/Td9OugGWUgc\nhttps://restream.io/"),
    ).toEqual([]);
    expect(extractCampaigns("")).toEqual([]);
    expect(extractCampaigns("utm_campaign=bare-text-is-not-a-link")).toEqual([]);
  });

  it("собирает несколько меток по порядку и без повторов", () => {
    const d = [
      "App: https://apps.apple.com/app/id1?ct=x",
      "Site https://airsignal.app/crew?utm_campaign=youtube-crew-01.",
      "Again https://airsignal.app/?utm_campaign=youtube-crew-01&utm_medium=video",
      "Blog (https://rustman.org/posts/a/?utm_campaign=youtube-post-02)",
    ].join("\n");
    expect(extractCampaigns(d)).toEqual(["youtube-crew-01", "youtube-post-02"]);
  });

  it("переживает &amp; и процентное кодирование", () => {
    expect(
      extractCampaigns("https://a.example/?utm_source=yt&amp;utm_campaign=youtube%2Dnest%2D01"),
    ).toEqual(["youtube-nest-01"]);
  });

  it("пустая метка не метка", () => {
    expect(extractCampaigns("https://a.example/?utm_campaign=&utm_source=yt")).toEqual([]);
  });
});

describe("разбор ответов API", () => {
  it("длительность ISO 8601 в секунды, мусор в ноль", () => {
    expect(parseDuration("PT23M57S")).toBe(1437);
    expect(parseDuration("PT1H2M3S")).toBe(3723);
    expect(parseDuration("PT45S")).toBe(45);
    expect(parseDuration("P0D")).toBe(0);
    expect(parseDuration("garbage")).toBe(0);
  });

  it("плейлист загрузок выводится из id канала", () => {
    expect(uploadsPlaylist("UCnLgMfncEual0Z19MDlspCw")).toBe("UUnLgMfncEual0Z19MDlspCw");
  });

  it("канал: тип контента уходит в имя метрики, а не в campaign или country", () => {
    const rows = channelRows(
      [
        ["2026-11-05", "videoOnDemand", 62, 339, 3, 1],
        ["2026-11-05", "shorts", 10, 4, 0, 0],
        ["2026-11-05", "somethingNew", 99, 99, 9, 9],
      ],
      "rust-starman",
    );
    expect(rows).toHaveLength(8); // новый тип не записывается под выдуманным именем
    expect(
      rows.every((r) => r.provider === "youtube" && r.campaign === "" && r.country === ""),
    ).toBe(true);
    expect(rows.find((r) => r.metric === "views_long")?.value).toBe(62);
    expect(rows.find((r) => r.metric === "watch_minutes_long")?.value).toBe(339);
    expect(rows.find((r) => r.metric === "subs_lost_long")?.value).toBe(1);
    expect(rows.find((r) => r.metric === "views_shorts")?.value).toBe(10);
    // нули записываются: день без просмотров это факт
    expect(rows.find((r) => r.metric === "subs_gained_shorts")?.value).toBe(0);
  });

  it("ролик по суткам: колонки отчёта по порядку", () => {
    expect(videoDayRows([["2026-11-04", "abc", 3, 1, 53, 4.04, 0, 2, 1, 0]])).toEqual([
      {
        day: "2026-11-04",
        video_id: "abc",
        views: 3,
        minutes: 1,
        avg_view_s: 53,
        avg_view_pct: 4.04,
        subs_gained: 0,
        likes: 2,
        shares: 1,
        comments: 0,
      },
    ]);
  });

  const meta = (over: Partial<VideoMeta>): VideoMeta => ({
    video_id: "v",
    title: "t",
    published: "2026-01-01T00:00:00Z",
    duration_s: 600,
    privacy: "public",
    live: false,
    description: "",
    ...over,
  });

  it("тип ролика: слово YouTube важнее длительности, длительность — запасной путь", () => {
    // двухминутный вертикальный ролик это Shorts, хотя по длительности «обычный»
    expect(
      chooseKind(
        meta({ duration_s: 120 }),
        new Map([
          ["shorts", 900],
          ["long", 5],
        ]),
      ),
    ).toBe("shorts");
    expect(chooseKind(meta({ duration_s: 40 }), undefined)).toBe("shorts");
    expect(chooseKind(meta({ duration_s: 600 }), undefined)).toBe("long");
    expect(chooseKind(meta({ live: true, duration_s: 7000 }), undefined)).toBe("live");
  });
});

describe("окно перечитывания", () => {
  const now = Date.parse("2026-11-08T05:40:00Z");

  it("первый запуск берёт всю историю, конец — вчера", () => {
    expect(planWindow(now, "2020-10-14", undefined)).toEqual({
      from: "2020-10-14",
      to: "2026-11-07",
    });
  });

  it("обычный запуск отступает от водяного знака на запас, а не от вчера", () => {
    expect(YT_RESTATE_DAYS).toBe(5);
    expect(planWindow(now, "2020-10-14", "2026-11-05")).toEqual({
      from: "2026-10-31",
      to: "2026-11-07",
    });
  });

  it("пропущенный запуск лечится сам: окно начинается там, где данные кончились", () => {
    expect(planWindow(now, "2020-10-14", "2026-10-01").from).toBe("2026-09-26");
  });

  it("не уходит раньше создания канала", () => {
    expect(planWindow(now, "2026-11-01", "2026-11-02").from).toBe("2026-11-01");
  });

  it("крон заведён в wrangler.jsonc — иначе джоб не запускается никогда, и молча", () => {
    expect(wranglerConfig).toContain(`"${YT_CRON}"`);
  });
});

describe("токен", () => {
  it("запрос обновления: форма, метод, тип тела", () => {
    const { url, init } = refreshRequest(SECRETS);
    expect(url).toBe("https://oauth2.googleapis.com/token");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["Content-Type"]).toBe(
      "application/x-www-form-urlencoded",
    );
    const body = new URLSearchParams(String(init.body));
    expect(Object.fromEntries(body)).toEqual({
      client_id: "cid",
      client_secret: "csecret",
      refresh_token: "rtoken",
      grant_type: "refresh_token",
    });
  });

  it("возвращает access_token", async () => {
    const fake = async () => new Response(JSON.stringify({ access_token: "at", expires_in: 3599 }));
    expect(await accessToken(SECRETS, fake)).toBe("at");
  });

  it("при отказе в ошибке код, а не тело ответа", async () => {
    const fake = async () =>
      new Response(JSON.stringify({ error: "invalid_grant", error_description: "SECRET-ISH" }), {
        status: 400,
      });
    const err = await accessToken(SECRETS, fake).catch((e: unknown) => String(e));
    expect(err).toContain("400");
    expect(err).toContain("invalid_grant");
    expect(err).not.toContain("SECRET-ISH");
    expect(err).not.toContain("rtoken");
  });
});

describe("кривая удержания", () => {
  const curve = (watching: number[]) =>
    watching.map((w, i) => ({ at: (i + 1) / 100, watching: w, relative: 0.5 }));

  it("процент смотрящих в опорных точках и самый крутой обрыв, первые 3% не в счёт", () => {
    const w = Array.from({ length: 100 }, (_, i) => 1 - i * 0.004); // ровный спуск
    w[39] = w[38]! - 0.2; // обрыв на 39-40%
    for (let i = 40; i < 100; i += 1) w[i] = w[39]! - (i - 39) * 0.004;
    w[0] = 1.2;
    w[1] = 0.8; // ранний провал: случайные нажатия
    const s = summarizeRetention(curve(w));
    expect(s.steepest).toMatchObject({ from: 39, to: 40 });
    expect(s.steepest!.drop).toBeCloseTo(0.2, 1);
    expect(s.at.map((x) => x.pct)).toEqual([10, 25, 50, 75, 100]);
    expect(s.relative).toBeCloseTo(0.5);
  });

  it("пустая кривая не падает", () => {
    expect(summarizeRetention([])).toEqual({ at: [], steepest: undefined, relative: undefined });
  });
});

describe("строка ролика", () => {
  const v: VideoTotal = {
    video_id: "abc",
    title: "Булат в Сиэтле",
    published: "2026-11-05T22:46:04Z",
    kind: "long",
    duration_s: 1437,
    privacy: "public",
    campaigns: [],
    views: 120,
    minutes: 300,
    avg_view_s: 150,
    avg_view_pct: 10.4,
    subs_gained: 2,
    likes: 9,
    comments: 1,
  };

  it("без метки говорит об этом прямо", () => {
    expect(formatVideoRow(v, new Map())).toContain("no tagged link in description");
  });

  it("с меткой подставляет визиты и клики нашего счётчика", () => {
    const line = formatVideoRow(
      { ...v, campaigns: ["youtube-bulat-01"] },
      new Map([["youtube-bulat-01", { visits: 14, store_clicks: 3 }]]),
    );
    expect(line).toContain("14 site visits");
    expect(line).toContain("3 store clicks");
  });

  it("метка без визитов — нули, а не пропуск", () => {
    expect(formatVideoRow({ ...v, campaigns: ["x"] }, new Map())).toContain("0 site visits");
  });
});

describe("сканер ссылок YouTube", () => {
  const C = "youtube-_GzPxIwRMgo";
  const P = "/wiki/oc-lightning-hackathon-brocheck-2026/";
  const row = (ts: string, anon: string, path = P, campaign = C) => ({
    ts,
    source: "rustman",
    utm_campaign: campaign,
    path,
    anon,
    weight: 1,
  });

  it("пачка из разных anon за секунду отбрасывается целиком, одиночный визит через час остаётся", () => {
    const visits = parseYoutubeVisits({
      data: [
        row("2026-11-08 10:50:10.100", "a1"),
        row("2026-11-08 10:50:10.900", "a2"),
        row("2026-11-08 10:50:11.300", "a3"),
        row("2026-11-08 11:55:00.000", "real"),
      ],
    });
    const scanners = scannerVisits(visits);
    expect(scanners.get(C)).toBe(3);
    const index = new Map([[C, { visits: 4, store_clicks: 1 }]]);
    withoutScanners(index, scanners);
    expect(index.get(C)).toEqual({ visits: 1, store_clicks: 1 });
  });

  it("цепочка из 3+ разных кампаний без коллизий тоже сканер (одиночные заходы на / и /api)", () => {
    const visits = parseYoutubeVisits({
      data: [
        row("2026-11-08 10:50:10", "a1", "/", "youtube-a"),
        row("2026-11-08 10:50:11", "a2", "/api", "youtube-b"),
        row("2026-11-08 10:50:13", "a3", "/crew", "youtube-c"),
      ],
    });
    expect([...scannerVisits(visits).values()].reduce((a, b) => a + b, 0)).toBe(3);
  });

  it("один anon, перезагрузивший страницу, и две кампании подряд не считаются сканером", () => {
    const visits = parseYoutubeVisits({
      data: [
        row("2026-11-08 10:00:00", "a1"),
        row("2026-11-08 10:00:01", "a1"),
        row("2026-11-08 10:00:03", "a2", "/other/", "youtube-b"),
      ],
    });
    expect(scannerVisits(visits).size).toBe(0);
  });
});

/** Подставной YouTube: по пути запроса отдаёт заготовленный ответ и считает вызовы. */
function fakeYoutube() {
  const calls: string[] = [];
  const fetcher = async (input: string) => {
    const url = new URL(input);
    calls.push(
      url.pathname +
        (url.searchParams.get("dimensions") ? `?${url.searchParams.get("dimensions")}` : ""),
    );
    const json = (o: unknown) => new Response(JSON.stringify(o));
    if (url.host === "oauth2.googleapis.com") return json({ access_token: "at" });
    if (url.pathname.endsWith("/playlistItems")) {
      return json({
        items: [{ contentDetails: { videoId: "vid1" } }, { contentDetails: { videoId: "vid2" } }],
      });
    }
    if (url.pathname.endsWith("/videos")) {
      return json({
        items: [
          {
            id: "vid1",
            snippet: {
              title: "Film one",
              publishedAt: "2026-11-01T00:00:00Z",
              description: "https://airsignal.app/?utm_campaign=youtube-film-01",
            },
            contentDetails: { duration: "PT10M" },
            status: { privacyStatus: "public" },
          },
          {
            id: "vid2",
            snippet: {
              title: "Short two",
              publishedAt: "2026-11-02T00:00:00Z",
              description: "no links",
            },
            contentDetails: { duration: "PT30S" },
            status: { privacyStatus: "unlisted" },
          },
        ],
      });
    }
    const dims = url.searchParams.get("dimensions");
    if (dims === "video,creatorContentType")
      return json({
        rows: [
          ["vid1", "videoOnDemand", 50],
          ["vid2", "shorts", 70],
        ],
      });
    if (dims === "day,creatorContentType") {
      return json({
        rows: [
          ["2026-11-04", "videoOnDemand", 40, 100, 2, 0],
          ["2026-11-05", "shorts", 70, 20, 1, 1],
        ],
      });
    }
    if (dims === "day,video") {
      return json({
        rows: [
          ["2026-11-04", "vid1", 40, 100, 150, 25, 2, 3, 0, 1],
          ["2026-11-05", "vid2", 70, 20, 17, 55, 1, 5, 2, 0],
        ],
      });
    }
    if (dims === "elapsedVideoTimeRatio") {
      return json({
        rows: Array.from({ length: 100 }, (_, i) => [(i + 1) / 100, 1 - i * 0.005, 0.5]),
      });
    }
    if (dims === "insightTrafficSourceType")
      return json({
        rows: [
          ["YT_SEARCH", 30, 60],
          ["SUBSCRIBER", 10, 40],
        ],
      });
    return new Response("unexpected " + input, { status: 500 });
  };
  return { fetcher, calls };
}

describe("джоб целиком, без сети", () => {
  beforeEach(async () => {
    for (const t of ["store_daily", "store_sync", "youtube_video_daily", "youtube_videos"]) {
      await env.STORES.exec(`DROP TABLE IF EXISTS ${t}`);
    }
    const bare = schemaSql.replace(/--[^\n]*/g, "");
    for (const statement of bare.split(";")) {
      const sql = statement.trim();
      if (sql !== "") await env.STORES.exec(`${sql.replace(/\s+/g, " ")};`);
    }
  });
  const now = Date.parse("2026-11-08T05:40:00Z");
  const e = () => ({ ...SECRETS, STORES: env.STORES });

  it("без секретов говорит об этом и ничего не пишет", async () => {
    const [r] = await syncYoutube({ STORES: env.STORES }, now);
    expect(r!.notes[0]).toContain("not configured");
    expect(
      (await env.STORES.prepare("SELECT COUNT(*) AS n FROM store_daily").first<{ n: number }>())!.n,
    ).toBe(0);
  });

  it("пишет канал, ролики и метаданные; повтор не удваивает; водяной знак на последнем дне с данными", async () => {
    const y = fakeYoutube();
    const [r] = await syncYoutube(e(), now, undefined, y.fetcher);
    expect(r).toMatchObject({
      videos: 2,
      channel_rows: 8,
      video_rows: 2,
      through: "2026-11-05",
      from: "2020-10-14",
    });
    await syncYoutube(e(), now, undefined, y.fetcher);

    const count = async (t: string) =>
      (await env.STORES.prepare(`SELECT COUNT(*) AS n FROM ${t}`).first<{ n: number }>())!.n;
    expect(await count("store_daily")).toBe(8);
    expect(await count("youtube_video_daily")).toBe(2);
    expect(await count("youtube_videos")).toBe(2);

    const kinds = await env.STORES.prepare(
      "SELECT video_id, kind, campaigns, privacy FROM youtube_videos ORDER BY video_id",
    ).all();
    expect(kinds.results).toEqual([
      { video_id: "vid1", kind: "long", campaigns: "youtube-film-01", privacy: "public" },
      { video_id: "vid2", kind: "shorts", campaigns: "", privacy: "unlisted" },
    ]);

    // второй запуск идёт от водяного знака, а не с 2020 года
    const second = await syncYoutube(e(), now, undefined, y.fetcher);
    expect(second[0]!.from).toBe("2026-10-31");
  });

  it("строки канала не попадают в таблицу «что сообщают магазины»", async () => {
    await syncYoutube(e(), now, undefined, fakeYoutube().fetcher);
    expect(await readTotals(env.STORES, "2020-01-01", "2026-12-31")).toEqual([]);
  });

  it("ошибка API не двигает водяной знак", async () => {
    const [r] = await syncYoutube(
      e(),
      now,
      undefined,
      async () => new Response("no", { status: 500 }),
    );
    expect(r!.notes[0]).toContain("500");
    expect(
      (await env.STORES.prepare("SELECT COUNT(*) AS n FROM store_sync").first<{ n: number }>())!.n,
    ).toBe(0);
  });

  it("инструмент youtube: канал, рейтинг и честное «нет метки»", async () => {
    const y = fakeYoutube();
    await syncYoutube(e(), now, undefined, y.fetcher);
    const out = await runYoutubeTool("youtube", { days: 28 }, e() as never, now, y.fetcher);
    expect(out.text).toContain("YouTube reports up to 2026-11-05");
    expect(out.text).toContain("Film one");
    expect(out.text).toContain("no tagged link in description");
    expect(out.text).toContain("Impressions and CTR are not available");
  });

  it("инструмент youtube_video: ряд по дням, удержание и источники", async () => {
    const y = fakeYoutube();
    await syncYoutube(e(), now, undefined, y.fetcher);
    const out = await runYoutubeTool(
      "youtube_video",
      { video: "film one" },
      e() as never,
      now,
      y.fetcher,
    );
    expect(out.text).toContain("11-04 40");
    expect(out.text).toContain("Retention");
    expect(out.text).toContain("YT_SEARCH: 30 (75%)");
    // SUBSCRIBER is "browse features" (home page too); a bare label reads as subscribers.
    expect(out.text).toContain(
      "SUBSCRIBER (browse features: home page and subscriptions feed, not only subscribers): 10 (25%)",
    );
  });

  it("youtube_video: два совпадения не угадываются", async () => {
    const y = fakeYoutube();
    await syncYoutube(e(), now, undefined, y.fetcher);
    const out = await runYoutubeTool("youtube_video", { video: "o" }, e() as never, now, y.fetcher);
    expect(out.text).toContain("matches 2 videos");
  });
});
