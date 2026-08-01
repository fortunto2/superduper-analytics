/**
 * The HTTP contract, exercised through a real request into workerd — status codes, the empty
 * 204 body, and the sendBeacon content-type path that the web snippet will depend on.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

const INGEST = "https://analytics.example/e";

const post = (body: string, init: RequestInit = {}) =>
  SELF.fetch(INGEST, { method: "POST", body, ...init });

const batch = (...events: unknown[]) => JSON.stringify({ events });

const pageView = {
  source: "superduperai",
  platform: "web",
  name: "page_viewed",
  path: "/pricing?utm_source=x",
};

describe("POST /e", () => {
  it("answers 204 with an empty body", async () => {
    const res = await post(batch(pageView));
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("accepts a text/plain body — this is what navigator.sendBeacon sends", async () => {
    const res = await post(batch(pageView), { headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(204);
  });

  it("answers 400 on a body that is not JSON", async () => {
    const res = await post("not json");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "invalid_json" });
  });

  it("answers 400 on a body that is JSON but not a batch", async () => {
    const res = await post(batch({ source: "superduperai" }));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "invalid_batch" });
  });

  it("answers 403 for a source that is not in the registry", async () => {
    const res = await post(batch({ ...pageView, source: "not-registered" }));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "unknown_source", source: "not-registered" });
  });

  it("refuses an oversized body before reading it", async () => {
    const res = await post(batch(pageView), {
      headers: { "content-length": String(2_000_000) },
    });
    expect(res.status).toBe(413);
  });

  it("writes one data point per accepted event", async () => {
    const spy = vi.spyOn(env.EVENTS, "writeDataPoint").mockImplementation(() => undefined);
    try {
      const res = await post(batch(pageView, { ...pageView, name: "signup_started" }));
      expect(res.status).toBe(204);
      expect(spy).toHaveBeenCalledTimes(2);
      // The path reached the sink already stripped — ingest ran before the write, not after.
      expect(spy.mock.calls[0]?.[0]?.blobs?.[3]).toBe("/pricing");
    } finally {
      spy.mockRestore();
    }
  });

  it("writes nothing at all when the batch is refused", async () => {
    const spy = vi.spyOn(env.EVENTS, "writeDataPoint").mockImplementation(() => undefined);
    try {
      await post(batch({ ...pageView, source: "not-registered" }, pageView));
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("GET /v1/stats", () => {
  const stats = (query: string) => SELF.fetch(`https://analytics.example/v1/stats${query}`);

  it("refuses a window past the hot store's retention", async () => {
    const res = await stats("?days=999");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "beyond_retention" });
  });

  it("refuses a window that is not a number at all", async () => {
    const res = await stats("?days=lots");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_window" });
  });
});

describe("harness", () => {
  it("gets its bindings from wrangler.jsonc", () => {
    // Guards the vitest config, not the Worker: without this the pool would silently run with
    // no bindings and step 2's sink tests would fail for the wrong reason.
    expect(env.EVENTS).toBeDefined();
  });
});

describe("GET /health", () => {
  it("reports the stage the Worker is at", async () => {
    const res = await SELF.fetch("https://analytics.example/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, stage: "ingest" });
  });
});
