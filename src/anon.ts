/**
 * The anonymous id, derived at the edge — never stored on the device.
 *
 * No cookie, no localStorage, no sessionStorage, no fingerprint returned to the client. The
 * browser is given nothing to keep, which is what keeps every privacy page on every property
 * honest and the consent-banner question closed.
 *
 * It is a salted hash of IP + user agent + the UTC date, so:
 *   - it rotates at midnight UTC, making it useless for tracking anyone across days;
 *   - it cannot be reversed to an IP without the salt, which lives only in a Worker secret;
 *   - two people behind one NAT with the same browser collide, and that is accepted — this
 *     answers "roughly how many people today", not "which people".
 */

/** 16 hex characters. Enough that collisions are the NAT case, short enough to stay cheap. */
const ID_LENGTH = 16;

const utf8 = new TextEncoder();

/** UTC, so the rotation point does not move with the visitor's timezone. */
export function utcDay(now: number): string {
  return new Date(now).toISOString().slice(0, 10);
}

/**
 * Returns undefined when there is no salt: a hash with a guessable salt would be reversible
 * by anyone who can hash an IP range, which is worse than having no id at all.
 */
export async function deriveAnon(
  salt: string | undefined,
  now: number,
  ip: string | undefined,
  userAgent: string | undefined,
): Promise<string | undefined> {
  if (salt === undefined || salt === "" || ip === undefined || ip === "") return undefined;

  const material = `${salt}|${utcDay(now)}|${ip}|${userAgent ?? ""}`;
  const digest = await crypto.subtle.digest("SHA-256", utf8.encode(material));
  const bytes = new Uint8Array(digest).slice(0, ID_LENGTH / 2);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}
