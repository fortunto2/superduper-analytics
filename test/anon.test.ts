import { describe, expect, it } from "vitest";
import { deriveAnon, utcDay } from "../src/anon";
import { ingest } from "../src/ingest";

const SALT = "a-long-random-salt";
const NOON = Date.parse("2026-06-15T12:00:00.000Z");
const LATER_SAME_DAY = Date.parse("2026-06-15T23:59:59.000Z");
const NEXT_DAY = Date.parse("2026-06-16T00:00:01.000Z");
const UA = "Mozilla/5.0 (Macintosh) Safari/605.1.15";

describe("deriveAnon", () => {
  it("is stable for the same visitor within a UTC day", async () => {
    const a = await deriveAnon(SALT, NOON, "203.0.113.7", UA);
    const b = await deriveAnon(SALT, LATER_SAME_DAY, "203.0.113.7", UA);
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{16}$/);
  });

  it("rotates at midnight UTC, which is what stops it being a tracking id", async () => {
    expect(await deriveAnon(SALT, NOON, "203.0.113.7", UA)).not.toBe(
      await deriveAnon(SALT, NEXT_DAY, "203.0.113.7", UA),
    );
  });

  it("differs by IP and by user agent", async () => {
    const base = await deriveAnon(SALT, NOON, "203.0.113.7", UA);
    expect(await deriveAnon(SALT, NOON, "203.0.113.8", UA)).not.toBe(base);
    expect(await deriveAnon(SALT, NOON, "203.0.113.7", "Firefox/1")).not.toBe(base);
  });

  it("changes completely when the salt is rotated — the panic button works", async () => {
    expect(await deriveAnon("other-salt", NOON, "203.0.113.7", UA)).not.toBe(
      await deriveAnon(SALT, NOON, "203.0.113.7", UA),
    );
  });

  it.each([
    ["no salt", undefined, "203.0.113.7"],
    ["empty salt", "", "203.0.113.7"],
    ["no IP", SALT, undefined],
  ])("returns nothing rather than a guessable hash when there is %s", async (_l, salt, ip) => {
    expect(await deriveAnon(salt, NOON, ip, UA)).toBeUndefined();
  });

  it("uses UTC for the day boundary, not the visitor's timezone", () => {
    expect(utcDay(Date.parse("2026-06-15T23:30:00.000Z"))).toBe("2026-06-15");
    expect(utcDay(Date.parse("2026-06-16T00:30:00.000Z"))).toBe("2026-06-16");
  });
});

describe("who owns the anon id", () => {
  const edge = { now: NOON, anon: "edge0000edge0000" };
  const run = (event: Record<string, unknown>) => {
    const result = ingest({ events: [event] }, edge);
    if (!result.ok) throw new Error(JSON.stringify(result.body));
    return result.events[0]?.anon;
  };

  it("overrides whatever a web page claims — a browser cannot pick its own identity", () => {
    expect(
      run({ source: "books", platform: "web", name: "page_viewed", anon: "i-am-a-thousand" }),
    ).toBe("edge0000edge0000");
  });

  it("keeps an app's install-scoped id, which the edge cannot derive", () => {
    expect(
      run({ source: "photosweep", platform: "ios", name: "app_launched", anon: "INSTALL-UUID" }),
    ).toBe("INSTALL-UUID");
  });

  it("falls back to the edge id for an app that sends none", () => {
    expect(run({ source: "photosweep", platform: "ios", name: "app_launched" })).toBe(
      "edge0000edge0000",
    );
  });
});

describe("a client that admits to being automated", () => {
  const run = (event: Record<string, unknown>) => {
    const result = ingest({ events: [event] }, { now: NOON, userAgent: UA });
    if (!result.ok) throw new Error(JSON.stringify(result.body));
    return result.events[0]?.ua_kind;
  };

  it("is a bot even behind a perfectly ordinary browser user agent", () => {
    expect(run({ source: "books", platform: "web", name: "page_viewed", auto: true })).toBe("bot");
  });

  it("is a bot on any platform, not just web", () => {
    expect(run({ source: "photosweep", platform: "ios", name: "app_launched", auto: true })).toBe(
      "bot",
    );
  });

  it("is left alone when it says nothing", () => {
    expect(run({ source: "books", platform: "web", name: "page_viewed" })).toBe("browser");
  });
});
