/**
 * The blob and double positions ARE the wire format. Every query ever written against this
 * dataset refers to blob1..blobN by number, so these tests pin the positions themselves —
 * a reordering that keeps all the same values must still fail here.
 */
import { env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { ingest } from "../src/ingest";
import { toDataPoint, writeEvents } from "../src/sinks/analytics-engine";
import {
  BLOB_SLOTS,
  DOUBLE_SLOTS,
  MAX_BLOBS,
  MAX_DOUBLES,
  type EnrichedEvent,
} from "../src/schema";

const full: EnrichedEvent = {
  source: "superduperai",
  platform: "web",
  name: "purchase_completed",
  path: "/pricing",
  referrer_host: "news.ycombinator.com",
  country: "DE",
  version: "1.4.2",
  anon: "d41d8cd98f00b204",
  ua_kind: "browser",
  ts: 1781524800000,
  props_json: '{"tier":"pro"}',
  metrics_json: '{"price_usd":29.99}',
};

describe("positions", () => {
  it("puts every field in the slot its number promises", () => {
    // Written out by hand rather than derived from BLOB_SLOTS: a test that maps the same
    // array the implementation maps would pass no matter how the array was reordered.
    expect(toDataPoint(full).blobs).toEqual([
      "superduperai", // blob1  source
      "web", // blob2  platform
      "purchase_completed", // blob3  name
      "/pricing", // blob4  path
      "news.ycombinator.com", // blob5  referrer_host
      "DE", // blob6  country
      "1.4.2", // blob7  version
      "d41d8cd98f00b204", // blob8  anon
      "browser", // blob9  ua_kind
      '{"tier":"pro"}', // blob10 props_json
      '{"price_usd":29.99}', // blob11 metrics_json
    ]);
  });

  it("puts the event time in double1", () => {
    expect(toDataPoint(full).doubles).toEqual([1781524800000]);
  });

  it("indexes by source, and by exactly one thing", () => {
    expect(toDataPoint(full).indexes).toEqual(["superduperai"]);
  });

  it("holds an absent field as null so nothing after it shifts left", () => {
    const sparse: EnrichedEvent = {
      source: "photosweep",
      platform: "ios",
      name: "app_launched",
      ua_kind: "app",
      ts: 1781524800000,
    };
    const blobs = toDataPoint(sparse).blobs;
    expect(blobs).toHaveLength(BLOB_SLOTS.length);
    expect(blobs?.[8]).toBe("app"); // ua_kind is still blob9, not blob4
    expect(blobs?.slice(3, 8)).toEqual([null, null, null, null, null]);
  });
});

describe("Analytics Engine limits", () => {
  it("never asks for more slots than a data point has", () => {
    expect(BLOB_SLOTS.length).toBeLessThanOrEqual(MAX_BLOBS);
    expect(DOUBLE_SLOTS.length).toBeLessThanOrEqual(MAX_DOUBLES);
  });

  it("sends exactly one index, and one short enough to be accepted", () => {
    const indexes = toDataPoint(full).indexes ?? [];
    expect(indexes).toHaveLength(1);
    expect(new TextEncoder().encode(String(indexes[0])).length).toBeLessThanOrEqual(96);
  });

  it("keeps the blobs of a maximal event under the 16 KB budget", () => {
    // The largest event ingest will accept: every capped field at its cap, free-form data at
    // the byte ceiling. If this ever exceeds 16 KB, RESERVED_BLOB_BYTES is a lie.
    const props = Object.fromEntries(
      Array.from({ length: 45 }, (_, i) => [`k${String(i).padStart(38, "0")}`, "v".repeat(200)]),
    );
    const result = ingest(
      {
        events: [
          {
            source: "miralinka-marafon",
            platform: "web",
            name: "a".repeat(64),
            path: "/".padEnd(512, "p"),
            referrer: `https://${"r".repeat(200)}.example.com/`,
            version: "v".repeat(32),
            anon: "a".repeat(64),
            props,
          },
        ],
      },
      { now: 1781524800000, country: "DE", userAgent: "Mozilla/5.0" },
    );
    if (!result.ok) throw new Error(`fixture rejected: ${JSON.stringify(result.body)}`);

    const blobs = toDataPoint(result.events[0]!).blobs ?? [];
    const bytes = blobs.reduce<number>(
      (total, blob) => total + (blob === null ? 0 : new TextEncoder().encode(String(blob)).length),
      0,
    );
    expect(bytes).toBeLessThanOrEqual(16 * 1024);
  });
});

describe("writeEvents", () => {
  it("writes one data point per event to the bound dataset", () => {
    const spy = vi.spyOn(env.EVENTS, "writeDataPoint").mockImplementation(() => undefined);
    try {
      writeEvents(env.EVENTS, [full, { ...full, source: "books" }]);
      expect(spy).toHaveBeenCalledTimes(2);
      expect(spy.mock.calls[1]?.[0]?.indexes).toEqual(["books"]);
    } finally {
      spy.mockRestore();
    }
  });
});
