/**
 * Mailroom's webhooks (Standard Webhooks / Svix signature) as our events.
 *
 * Email is the one channel that reaches a person by name, so the line is drawn here: the event
 * keeps WHAT happened (delivered, opened, clicked, bounced…), WHICH campaign and wave, and the
 * clicked link's host — never the address, the subject or the body. Mailroom's email id is
 * hashed with the salt into `anon`, so "how many people opened" can be counted without anyone
 * being findable from the row.
 *
 * A click lands on the site with utm_source=mailroom&utm_medium=email&utm_campaign=<campaign>
 * (Mailroom tags links itself), so the web counter carries the campaign the rest of the way:
 * email_clicked here, then page_viewed with the same utm on the site, then app_launched.
 */
import type { Event } from "../schema";

/** Mailroom event type → our event name. Anything else (inbox.*, email.received) is ignored. */
const NAMES: Record<string, string> = {
  "email.sent": "email_sent",
  "email.delivered": "email_delivered",
  "email.delivery_delayed": "email_delayed",
  "email.opened": "email_opened",
  "email.clicked": "email_clicked",
  "email.bounced": "email_bounced",
  "email.complained": "email_complained",
  "email.unsubscribed": "email_unsubscribed",
  "email.suppressed": "email_suppressed",
  "email.failed": "email_failed",
};

/** Tags a send may carry that are safe to keep: campaign plumbing, never the person. */
const KEPT_TAGS = ["wave", "segment", "variant", "lang"] as const;

export interface MailroomPayload {
  type?: string;
  created_at?: string;
  data?: {
    email_id?: string;
    tags?: Record<string, string>;
    broadcast_id?: string;
    click?: { link?: string };
    link?: string;
  };
}

const clip = (s: string, n: number) => s.slice(0, n);

/** One webhook → one event, or null when it is not an email event we count. */
export function mailroomEvent(
  p: MailroomPayload,
  o: { source: string; anon?: string },
): Event | null {
  const name = p.type ? NAMES[p.type] : undefined;
  if (!name) return null;
  const tags = p.data?.tags ?? {};
  const props: Record<string, string> = {};
  for (const k of KEPT_TAGS) if (tags[k]) props[k] = clip(tags[k], 200);
  if (p.data?.broadcast_id) props.broadcast = clip(p.data.broadcast_id, 200);
  const link = p.data?.click?.link ?? p.data?.link;
  if (link) {
    try {
      props.link_host = new URL(link).host;
    } catch {}
  }
  const ts = p.created_at ? Date.parse(p.created_at) : Number.NaN;
  const campaign = tags.campaign ?? tags.utm_campaign;
  return {
    source: o.source,
    platform: "server",
    name,
    ...(o.anon ? { anon: o.anon } : {}),
    ...(Number.isFinite(ts) ? { ts } : {}),
    utm: { source: "mailroom", medium: "email", ...(campaign ? { campaign: clip(campaign, 64) } : {}) },
    ...(Object.keys(props).length ? { props } : {}),
  };
}

const b64 = (bytes: ArrayBuffer) => btoa(String.fromCharCode(...new Uint8Array(bytes)));

/** Webhooks older than this are refused: a replayed body is not a new event. */
const MAX_AGE_S = 5 * 60;

/** Standard Webhooks: v1,base64(HMAC-SHA256(secret, "id.timestamp.body")). */
export async function verifyMailroom(
  secret: string,
  headers: { id?: string | null; timestamp?: string | null; signature?: string | null },
  body: string,
  nowMs: number,
): Promise<boolean> {
  const { id, timestamp, signature } = headers;
  if (!secret || !id || !timestamp || !signature) return false;
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(nowMs / 1000 - ts) > MAX_AGE_S) return false;
  const raw = Uint8Array.from(atob(secret.replace(/^whsec_/, "")), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("raw", raw, { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
  ]);
  const mac = b64(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${id}.${ts}.${body}`)));
  // Several signatures may be sent during a secret rotation, space-separated.
  return signature.split(" ").some((s) => s === `v1,${mac}`);
}
