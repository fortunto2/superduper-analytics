import { describe, expect, it } from "vitest";
import { ingest, type EdgeContext } from "../src/ingest";
import { BLOB_BUDGET, MAX_DOUBLES, MAX_EVENTS_PER_REQUEST } from "../src/schema";

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

describe("budgets the sink cannot exceed", () => {
  const fill = (count: number, value: (i: number) => unknown) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`k${i}`, value(i)]));

  it(`refuses more than ${BLOB_BUDGET} props`, () => {
    const over = ingest({ events: [pageView({ props: fill(BLOB_BUDGET + 1, () => "x") })] }, edge());
    if (over.ok) throw new Error("expected rejection");
    expect(over.status).toBe(400);
    expect(over.body).toMatchObject({ error: "too_many_props", limit: BLOB_BUDGET });

    expect(ingest({ events: [pageView({ props: fill(BLOB_BUDGET, () => "x") })] }, edge()).ok).toBe(
      true,
    );
  });

  it(`refuses more than ${MAX_DOUBLES} metrics`, () => {
    const over = ingest(
      { events: [pageView({ metrics: fill(MAX_DOUBLES + 1, (i) => i) })] },
      edge(),
    );
    if (over.ok) throw new Error("expected rejection");
    expect(over.body).toMatchObject({ error: "too_many_metrics", limit: MAX_DOUBLES });
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
