import { describe, expect, it } from "vitest";
import { ingest, type EdgeContext } from "../src/ingest";
import { MAX_EVENTS_PER_REQUEST, MAX_FREEFORM_BYTES } from "../src/schema";

const NOW = Date.parse("2026-06-15T12:00:00.000Z");
const SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Safari/605.1.15";

const edge = (over: Partial<EdgeContext> = {}): EdgeContext => ({
  now: NOW,
  country: "DE",
  userAgent: SAFARI,
  ...over,
});

const pageView = (over: Record<string, unknown> = {}) => ({
  source: "superduperai",
  platform: "web",
  name: "page_viewed",
  ...over,
});

/** Narrows to the success branch and fails loudly with the reason if it is not one. */
function accepted(result: ReturnType<typeof ingest>) {
  if (!result.ok) throw new Error(`expected acceptance, got ${result.status} ${JSON.stringify(result.body)}`);
  return result.events;
}

describe("acceptance", () => {
  it("accepts a valid batch and returns one enriched event per input", () => {
    const events = accepted(
      ingest({ events: [pageView(), pageView({ name: "signup_started" })] }, edge()),
    );
    expect(events).toHaveLength(2);
    expect(events[0]).toMatchObject({
      source: "superduperai",
      platform: "web",
      name: "page_viewed",
      country: "DE",
      ua_kind: "browser",
      ts: NOW,
    });
  });

  it("accepts an app source that is not a site", () => {
    const events = accepted(
      ingest(
        { events: [{ source: "photosweep", platform: "ios", name: "app_launched" }] },
        edge({ userAgent: "PhotoSweep/1.4 CFNetwork" }),
      ),
    );
    expect(events[0]?.ua_kind).toBe("app");
  });

  it("accepts the same id as both a site and an app — platform tells them apart", () => {
    const web = accepted(ingest({ events: [pageView({ source: "live2play" })] }, edge()));
    const app = accepted(
      ingest({ events: [{ source: "live2play", platform: "ios", name: "app_launched" }] }, edge()),
    );
    expect(web[0]?.platform).toBe("web");
    expect(app[0]?.platform).toBe("ios");
  });
});

describe("the registry is the only way in", () => {
  it("refuses an unregistered source with 403", () => {
    const result = ingest({ events: [pageView({ source: "not-registered" })] }, edge());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.body).toEqual({ error: "unknown_source", source: "not-registered" });
  });

  it("refuses the whole batch when a single event is unregistered", () => {
    const result = ingest(
      { events: [pageView(), pageView({ source: "not-registered" }), pageView()] },
      edge(),
    );
    expect(result.ok).toBe(false);
  });
});

describe("schema rejection", () => {
  it.each([
    ["not an object", 42],
    ["no events key", {}],
    ["empty batch", { events: [] }],
    ["missing name", { events: [{ source: "superduperai", platform: "web" }] }],
    ["unknown platform", { events: [pageView({ platform: "toaster" })] }],
    ["SHOUTING event name", { events: [pageView({ name: "PageViewed" })] }],
    ["uppercase source id", { events: [pageView({ source: "SuperDuperAI" })] }],
  ])("refuses %s with 400", (_label, body) => {
    const result = ingest(body, edge());
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(400);
    expect(result.body.error).toBe("invalid_batch");
  });

  it("names where the batch went wrong", () => {
    const result = ingest({ events: [pageView({ name: "PageViewed" })] }, edge());
    if (result.ok) throw new Error("expected rejection");
    expect(result.body.issues).toEqual([{ path: "events.0.name", message: expect.any(String) }]);
  });

  it("refuses more events than one Worker invocation may write", () => {
    const events = Array.from({ length: MAX_EVENTS_PER_REQUEST + 1 }, () => pageView());
    expect(ingest({ events }, edge()).ok).toBe(false);
    expect(ingest({ events: events.slice(1) }, edge()).ok).toBe(true);
  });
});

describe("free-form props and metrics", () => {
  const fill = (count: number, value: (i: number) => unknown) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${String(i).padStart(3, "0")}`, value(i)]));

  it("serializes props with keys sorted, so an identical set is an identical row", () => {
    const events = accepted(
      ingest({ events: [pageView({ props: { tier: "pro", currency: "eur", period: "year" } })] }, edge()),
    );
    expect(events[0]?.props_json).toBe('{"currency":"eur","period":"year","tier":"pro"}');
  });

  it("serializes metrics the same way", () => {
    const events = accepted(
      ingest({ events: [pageView({ metrics: { price_usd: 29.99, seats: 3 } })] }, edge()),
    );
    expect(events[0]?.metrics_json).toBe('{"price_usd":29.99,"seats":3}');
  });

  it("leaves an absent or empty object unset rather than storing an empty JSON blob", () => {
    const events = accepted(
      ingest({ events: [pageView(), pageView({ props: {}, metrics: {} })] }, edge()),
    );
    for (const event of events) {
      expect(event.props_json).toBeUndefined();
      expect(event.metrics_json).toBeUndefined();
    }
  });

  it("refuses an event whose free-form data would overflow the 16 KB blob limit", () => {
    // Each value is capped at 200 chars by the schema, so overflowing takes many keys.
    const over = ingest({ events: [pageView({ props: fill(100, () => "x".repeat(200)) })] }, edge());
    if (over.ok) throw new Error("expected rejection");
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({ error: "event_too_large", limit: MAX_FREEFORM_BYTES });
    expect(Number(over.body.got)).toBeGreaterThan(MAX_FREEFORM_BYTES);
  });

  it("accepts free-form data that fits", () => {
    expect(ingest({ events: [pageView({ props: fill(20, () => "x".repeat(200)) })] }, edge()).ok).toBe(
      true,
    );
  });
});

describe("strip before storing", () => {
  it.each([
    ["/pricing?utm_source=x&token=secret", "/pricing"],
    ["/pricing#section", "/pricing"],
    ["/pricing?a=1#b", "/pricing"],
    ["/pricing", "/pricing"],
  ])("reduces %s to %s", (input, expected) => {
    expect(accepted(ingest({ events: [pageView({ path: input })] }, edge()))[0]?.path).toBe(
      expected,
    );
  });

  it("drops a path that is nothing but a query string", () => {
    expect(accepted(ingest({ events: [pageView({ path: "?a=1" })] }, edge()))[0]?.path).toBeUndefined();
  });

  it.each([
    ["https://news.ycombinator.com/item?id=123", "news.ycombinator.com"],
    ["https://google.com/", "google.com"],
    ["not a url", undefined],
    ["", undefined],
  ])("reduces referrer %s to host %s", (input, expected) => {
    const events = accepted(ingest({ events: [pageView({ referrer: input })] }, edge()));
    expect(events[0]?.referrer_host).toBe(expected);
  });
});

describe("trust the edge, not the client", () => {
  it("stamps country from the edge, and a client cannot supply one", () => {
    const events = accepted(
      ingest({ events: [pageView({ country: "US" })] }, edge({ country: "PT" })),
    );
    expect(events[0]?.country).toBe("PT");
  });

  it("leaves country unset when the edge does not know it", () => {
    expect(
      accepted(ingest({ events: [pageView()] }, edge({ country: undefined })))[0]?.country,
    ).toBeUndefined();
  });

  it.each([
    ["browser UA on web", "web", SAFARI, "browser"],
    ["crawler UA on web", "web", "Mozilla/5.0 (compatible; Googlebot/2.1)", "bot"],
    ["link preview fetcher", "web", "facebookexternalhit/1.1", "bot"],
    ["no UA at all on web", "web", undefined, "bot"],
    ["ios regardless of UA", "ios", SAFARI, "app"],
  ])("classifies %s as %s", (_label, platform, userAgent, expected) => {
    const events = accepted(
      ingest(
        { events: [{ source: "live2play", platform, name: "page_viewed" }] },
        edge({ userAgent }),
      ),
    );
    expect(events[0]?.ua_kind).toBe(expected);
  });
});

describe("clock", () => {
  const tsOf = (ts: number | undefined) =>
    accepted(ingest({ events: [pageView(ts === undefined ? {} : { ts })] }, edge()))[0]?.ts;

  it("uses server time when the client sends none", () => {
    expect(tsOf(undefined)).toBe(NOW);
  });

  it("keeps a client timestamp from an offline buffer — that is why mobile batches at all", () => {
    const twoDaysAgo = NOW - 2 * 24 * 60 * 60 * 1000;
    expect(tsOf(twoDaysAgo)).toBe(twoDaysAgo);
  });

  it("distrusts a clock further behind than any plausible offline buffer", () => {
    expect(tsOf(NOW - 30 * 24 * 60 * 60 * 1000)).toBe(NOW);
  });

  it("distrusts a clock ahead of the edge", () => {
    expect(tsOf(NOW + 60 * 60 * 1000)).toBe(NOW);
  });
});

describe("the campaign that produced a visit", () => {
  it("keeps the three allowlisted tags and puts them in their own fields", () => {
    const result = ingest(
      {
        events: [
          {
            source: "carettafriends",
            platform: "web",
            name: "page_viewed",
            path: "/?utm_source=youtube",
            utm: { source: "youtube", medium: "shorts", campaign: "nest-01" },
          },
        ],
      },
      { now: 1781524800000 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0]).toMatchObject({
      utm_source: "youtube",
      utm_medium: "shorts",
      utm_campaign: "nest-01",
      // The query string is still stripped from the path — the tags arrive as fields, never
      // by keeping the URL that also carries reset tokens and email addresses.
      path: "/",
    });
  });

  it("leaves the fields unset when there was no campaign", () => {
    const result = ingest(
      {
        events: [{ source: "carettafriends", platform: "web", name: "page_viewed" }],
      },
      { now: 1781524800000 },
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.events[0]?.utm_campaign).toBeUndefined();
  });
});

/**
 * Проверка приёма руками естественно тянется к строке из нулей — так и случилось на facealarm
 * 2026-08-21. По форме это валидный UUID v4, и он занял место настоящей установки в подсчёте
 * `DISTINCT anon`, на котором стоит весь ретеншен. Событие при этом ценно и должно доехать.
 */
describe("заглушки вместо идентификатора", () => {
  const launch = (anon: string | undefined) => ({
    source: "facealarm",
    platform: "ios",
    name: "app_launched",
    ...(anon === undefined ? {} : { anon }),
  });

  it("отбрасывает нулевой UUID v4, оставляя само событие", () => {
    const [event] = accepted(ingest({ events: [launch("00000000-0000-4000-8000-000000000000")] }, edge()));
    expect(event?.name).toBe("app_launched");
    expect(event?.anon).toBeUndefined();
  });

  it("отбрасывает и nil UUID, у которого нулевые даже версия с вариантом", () => {
    const [event] = accepted(ingest({ events: [launch("00000000-0000-0000-0000-000000000000")] }, edge()));
    expect(event?.anon).toBeUndefined();
  });

  it("отбрасывает словесные заглушки независимо от регистра и пробелов", () => {
    for (const value of ["null", "UNDEFINED", " unknown ", "none", "nil", "n/a", "-", "   "]) {
      const [event] = accepted(ingest({ events: [launch(value)] }, edge()));
      expect(event?.anon, value).toBeUndefined();
    }
  });

  it("настоящий install-scoped UUID проходит нетронутым", () => {
    const real = "6095D7E8-1070-4034-9623-808989E265E5";
    const [event] = accepted(ingest({ events: [launch(real)] }, edge()));
    expect(event?.anon).toBe(real);
  });

  it("UUID с одним ненулевым разрядом — не заглушка", () => {
    const almost = "00000000-0000-4000-8000-000000000001";
    const [event] = accepted(ingest({ events: [launch(almost)] }, edge()));
    expect(event?.anon).toBe(almost);
  });

  it("заглушка ведёт себя ровно как отсутствие поля: тот же откат к краю", () => {
    const derived = "a1b2c3d4e5f60718";
    const withPlaceholder = accepted(
      ingest({ events: [launch("00000000-0000-4000-8000-000000000000")] }, edge({ anon: derived })),
    );
    const withoutField = accepted(ingest({ events: [launch(undefined)] }, edge({ anon: derived })));
    expect(withPlaceholder[0]?.anon).toBe(withoutField[0]?.anon);
  });

  it("на вебе выведенный на краю идентификатор побеждает заглушку, как и любую присылку", () => {
    const derived = "a1b2c3d4e5f60718";
    const [event] = accepted(
      ingest(
        { events: [{ source: "superduperai", platform: "web", name: "page_viewed", anon: "null" }] },
        edge({ anon: derived }),
      ),
    );
    expect(event?.anon).toBe(derived);
  });
});
