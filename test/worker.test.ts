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
  // DASHBOARD_KEY comes from .dev.vars via the wrangler config the pool reads.
  const stats = (query: string) =>
    SELF.fetch(`https://analytics.example/v1/stats${query}&k=${env.DASHBOARD_KEY}`);

  it("answers past retention with an empty set flagged as such, not a shortened one", async () => {
    const res = await stats("?days=999");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window_days: number; beyond_retention: boolean };
    expect(body.beyond_retention).toBe(true);
    expect(body.window_days).toBe(999);
  });

  it("refuses a window that is not a number at all", async () => {
    const res = await stats("?days=lots");
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: "bad_window" });
  });
});

describe("the read side is not public", () => {
  it("hides the dashboard behind the key, as a 404 rather than a 401", async () => {
    // 404 on purpose: an unauthenticated visitor should not learn a dashboard exists here.
    expect((await SELF.fetch("https://analytics.example/")).status).toBe(404);
  });

  it("serves the dashboard with the key", async () => {
    const res = await SELF.fetch(`https://analytics.example/?k=${env.DASHBOARD_KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("no-store");
  });

  it("refuses /v1/* without the key", async () => {
    expect((await SELF.fetch("https://analytics.example/v1/stats")).status).toBe(401);
    expect((await SELF.fetch("https://analytics.example/v1/overview")).status).toBe(401);
  });

  it("accepts a bearer token as well, for scripts", async () => {
    // Окно за пределом хранения выбрано намеренно: обработчик отвечает на него, не сходив в
    // SQL API, поэтому проверка не требует ни сети, ни настоящего токена Cloudflare. Важно
    // здесь одно — что это НЕ 401: значит ключ в заголовке принят наравне с ключом в адресе.
    const res = await SELF.fetch("https://analytics.example/v1/stats?days=999", {
      headers: { authorization: `Bearer ${env.DASHBOARD_KEY}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json() as { beyond_retention?: boolean }).beyond_retention).toBe(true);
  });

  it("leaves ingest and the snippet open — a beacon cannot carry a secret", async () => {
    expect((await post(batch(pageView))).status).toBe(204);
    expect((await SELF.fetch("https://analytics.example/sda.js")).status).toBe(200);
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

describe("the private side lives under its own prefix", () => {
  it("serves the dashboard at /dashboard so Access can be scoped to it", async () => {
    const res = await SELF.fetch(`https://analytics.example/dashboard?k=${env.DASHBOARD_KEY}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
  });

  it("keeps the old address working, because it is in bookmarks and docs", async () => {
    const res = await SELF.fetch(`https://analytics.example/?k=${env.DASHBOARD_KEY}`, { redirect: "manual" });
    expect(res.status).toBe(302);
    // The window and the key survive the hop, or the redirect logs you out.
    expect(res.headers.get("location")).toBe(`/dashboard?k=${env.DASHBOARD_KEY}`);
  });

  it("still refuses the dashboard without the key", async () => {
    expect((await SELF.fetch("https://analytics.example/dashboard")).status).toBe(404);
  });

  it("guards the pages under /dashboard too — Hono's /dashboard matches that path alone", async () => {
    expect((await SELF.fetch("https://analytics.example/dashboard/me")).status).toBe(404);
  });

  it("lists an opt-out link for every live site and none for a retired one", async () => {
    const res = await SELF.fetch(`https://analytics.example/dashboard/me?k=${env.DASHBOARD_KEY}`);
    expect(res.status).toBe(200);
    const html = await res.text();
    expect(html).toContain('href="https://airsignal.app/?sda=off"');
    expect(html).toContain('href="https://airsignal.app/?sda=on"');
    expect(html).not.toContain("editor.superduperai.co");
  });

  // The reason the move happened at all: an Access application on the bare hostname would
  // cover these two, and every counter on every site would get a login page instead of a 204.
  it("leaves ingest and the snippet outside the protected prefix", async () => {
    const beacon = await SELF.fetch("https://analytics.example/e", {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({
        events: [{ source: "carettafriends", platform: "web", name: "page_viewed" }],
      }),
    });
    expect(beacon.status).toBe(204);
    expect((await SELF.fetch("https://analytics.example/sda.js")).status).toBe(200);
  });
});

describe("the second door: Cloudflare Access", () => {
  const post = (jwt: string) =>
    SELF.fetch("https://analytics.example/dashboard", {
      headers: { "cf-access-jwt-assertion": jwt },
    });

  it("refuses a forged assertion — the header alone is not an identity", async () => {
    // Three dot-separated blobs, valid base64url, nonsense signature. Believing this is exactly
    // the bug the verification exists to prevent.
    const fake = `${btoa('{"alg":"RS256","kid":"x"}')}.${btoa('{"email":"a@b.co","exp":9999999999}')}.AAAA`;
    expect((await post(fake.replace(/=/g, ""))).status).toBe(404);
  });

  it("refuses junk in the header rather than throwing", async () => {
    expect((await post("not-a-jwt")).status).toBe(404);
    expect((await post("")).status).toBe(404);
  });

  it("still opens for the shared key, so Access cannot lock the owner out", async () => {
    const res = await SELF.fetch(`https://analytics.example/dashboard?k=${env.DASHBOARD_KEY}`);
    expect(res.status).toBe(200);
  });
});
