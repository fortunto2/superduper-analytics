/** Mailroom's webhooks → events: signed, mapped, and never carrying the address. */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";

const URL_ = "https://analytics.example/hooks/mailroom";
const SECRET = "whsec_dGVzdC1tYWlscm9vbS1zZWNyZXQ=";

async function signed(payload: unknown, o: { secret?: string; ts?: number; query?: string } = {}) {
  const body = JSON.stringify(payload);
  const id = "msg_1";
  const ts = o.ts ?? Math.floor(Date.now() / 1000);
  const raw = Uint8Array.from(atob((o.secret ?? SECRET).replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`));
  const sig = `v1,${btoa(String.fromCharCode(...new Uint8Array(mac)))}`;
  return SELF.fetch(URL_ + (o.query ?? ""), {
    method: "POST",
    body,
    headers: { "webhook-id": id, "webhook-timestamp": String(ts), "webhook-signature": sig },
  });
}

const clicked = {
  type: "email.clicked",
  created_at: new Date().toISOString(),
  data: {
    email_id: "e-123",
    from: "hello@news.life2film.com",
    to: ["person@gmail.com"],
    subject: "We're back",
    tags: { source: "life2film", campaign: "comeback-2026", wave: "W1", mailroom_id: "x" },
    click: { link: "https://life2film.com/?utm_source=mailroom" },
  },
};

describe("POST /hooks/mailroom", () => {
  it("writes one event with the campaign and wave, and no address or subject", async () => {
    const spy = vi.spyOn(env.EVENTS, "writeDataPoint").mockImplementation(() => undefined);
    const res = await signed(clicked);
    expect(res.status).toBe(204);
    expect(spy).toHaveBeenCalledTimes(1);
    const row = JSON.stringify(spy.mock.calls[0]);
    expect(row).toContain("email_clicked");
    expect(row).toContain("comeback-2026");
    expect(row).toContain("W1");
    expect(row).toContain("life2film.com");
    expect(row).not.toContain("person@gmail.com");
    expect(row).not.toContain("We're back");
    spy.mockRestore();
  });

  it("names the product per email, so any project can send through one Mailroom", async () => {
    const spy = vi.spyOn(env.EVENTS, "writeDataPoint").mockImplementation(() => undefined);
    const other = { ...clicked, data: { ...clicked.data, tags: { source: "facealarm" } } };
    expect((await signed(other)).status).toBe(204);
    expect(JSON.stringify(spy.mock.calls[0])).toContain("facealarm");
    spy.mockRestore();
  });

  it("refuses a bad signature, a stale one, an unknown or missing source", async () => {
    expect((await signed(clicked, { secret: "whsec_d3Jvbmc=" })).status).toBe(401);
    expect((await signed(clicked, { ts: Math.floor(Date.now() / 1000) - 3600 })).status).toBe(401);
    const nosrc = { ...clicked, data: { ...clicked.data, tags: {} } };
    expect((await signed(nosrc)).status).toBe(400);
    expect((await signed(nosrc, { query: "?source=life2film" })).status).toBe(204);
    const unknown = { ...clicked, data: { ...clicked.data, tags: { source: "nope" } } };
    expect((await signed(unknown)).status).toBe(403);
  });

  it("ignores inbox events", async () => {
    expect((await signed({ type: "inbox.message.received", data: { tags: { source: "life2film" } } })).status).toBe(204);
  });
});
