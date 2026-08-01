/**
 * The snippet is a string, so nothing type-checks it. These tests stand in for a compiler:
 * they parse it, run it against a fake DOM, and assert the properties that make it safe to
 * put on thirteen production sites.
 */
import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SNIPPET } from "../src/snippet";

describe("GET /sda.js", () => {
  it("is served as JavaScript that any origin may load", async () => {
    const res = await SELF.fetch("https://analytics.example/sda.js");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("javascript");
    expect(res.headers.get("access-control-allow-origin")).toBe("*");
    expect(res.headers.get("cache-control")).toContain("max-age=");
  });
});

describe("the snippet as shipped", () => {
  it("stays under the 2 KB the brief allows, uncompressed", () => {
    // Uncompressed on purpose: gzip would hide the cost of anything careless added later.
    expect(new TextEncoder().encode(SNIPPET).length).toBeLessThan(2048);
  });

  it("is syntactically valid — it is a string, so nothing else would catch a typo", () => {
    expect(() => new Function(SNIPPET)).not.toThrow();
  });

  it("touches no client-side storage, which is what keeps the consent banner away", () => {
    expect(SNIPPET).not.toMatch(/localStorage|sessionStorage|document\.cookie|indexedDB/);
  });

  it("sends text/plain, so the browser needs no CORS preflight", () => {
    expect(SNIPPET).toContain('type:"text/plain"');
    expect(SNIPPET).not.toMatch(/application\/json/);
  });

  it("never claims an anon id — that is derived at the edge", () => {
    expect(SNIPPET).not.toContain("anon");
  });

  it("flushes on visibilitychange rather than unload, which browsers drop", () => {
    expect(SNIPPET).toContain("visibilitychange");
    expect(SNIPPET).not.toMatch(/addEventListener\("unload"/);
  });
});

describe("the snippet running", () => {
  /** Minimal DOM: enough for the snippet to believe it is on a page. */
  function run(source: string | undefined, opts: { viaCurrentScript?: boolean } = {}) {
    const viaCurrentScript = opts.viaCurrentScript !== false;
    const sent: unknown[] = [];
    const listeners: Record<string, (() => void)[]> = {};
    const scriptEl = { dataset: source === undefined ? {} : { source } };

    const win = {
      addEventListener: (type: string, fn: () => void) => {
        (listeners[type] ??= []).push(fn);
      },
      location: { pathname: "/pricing", host: "example.com" },
      history: { pushState: () => undefined, replaceState: () => undefined },
    } as Record<string, unknown>;

    const doc = {
      currentScript: viaCurrentScript ? scriptEl : null,
      querySelector: (sel: string) => (sel.includes("sda.js") ? scriptEl : null),
      referrer: "https://news.ycombinator.com/item?id=1",
      visibilityState: "visible",
      addEventListener: (type: string, fn: () => void) => {
        (listeners[type] ??= []).push(fn);
      },
    };

    const sandbox = {
      Blob: class {
        constructor(readonly parts: string[]) {}
      },
      navigator: {
        sendBeacon: (_url: string, blob: { parts: string[] }) => {
          sent.push(JSON.parse(blob.parts[0] ?? "{}"));
          return true;
        },
      },
      location: win.location,
      history: win.history,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      console: { warn: () => undefined },
      Date,
      JSON,
      Array,
      fetch: () => undefined,
    };

    // eslint-disable-line no-new-func -- the point of the test is to execute the shipped text
    const factory = new Function(
      ...Object.keys(sandbox),
      "window",
      "document",
      `${SNIPPET}\nreturn window.sda;`,
    );
    const sda = factory(...Object.values(sandbox), win, doc) as (
      name: string,
      props?: unknown,
    ) => void;

    const hide = () => {
      doc.visibilityState = "hidden";
      listeners.visibilitychange?.forEach((fn) => fn());
    };
    return { sda, sent, hide, win };
  }

  it("reports a page view with the source, the path and an external referrer", () => {
    const { sent, hide } = run("superduperai");
    hide();
    const batch = sent[0] as { events: Record<string, unknown>[] };
    expect(batch.events).toHaveLength(1);
    expect(batch.events[0]).toMatchObject({
      source: "superduperai",
      platform: "web",
      name: "page_viewed",
      path: "/pricing",
      referrer: "https://news.ycombinator.com/item?id=1",
    });
  });

  it("exposes sda() for custom events and batches them into one request", () => {
    const { sda, sent, hide } = run("books");
    sda("signup_started", { plan: "pro" });
    sda("checkout_opened");
    hide();
    expect(sent).toHaveLength(1);
    const batch = sent[0] as { events: { name: string }[] };
    expect(batch.events.map((e) => e.name)).toEqual([
      "page_viewed",
      "signup_started",
      "checkout_opened",
    ]);
  });

  it("does nothing at all without data-source, rather than posting a rejected event", () => {
    const { sent, hide } = run(undefined);
    hide();
    expect(sent).toHaveLength(0);
  });

  it("finds its own tag when currentScript is null, as with next/script", () => {
    // next/script builds the element in JavaScript; a snippet that only reads currentScript
    // would silently do nothing on every Next site.
    const { sent, hide } = run("superduperai", { viaCurrentScript: false });
    hide();
    const batch = sent[0] as { events: { source: string }[] };
    expect(batch.events[0]?.source).toBe("superduperai");
  });

  it("sends nothing until the page is hidden, so it never competes with the page", () => {
    const { sda, sent } = run("books");
    sda("signup_started");
    expect(sent).toHaveLength(0);
  });
});
