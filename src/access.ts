/**
 * Cloudflare Access as the second way in, next to DASHBOARD_KEY.
 *
 * Access puts a signed JWT in `Cf-Access-Jwt-Assertion` once someone has proved who they are.
 * The Worker could simply believe that header — nothing reaches these paths except through
 * Access today, because the hostname has no other route and `workers_dev` is off.
 *
 * It is verified anyway, and the reason is what "today" means. The day somebody adds a
 * workers.dev route, a second custom domain, or a Tunnel that skips Access, an unverified
 * header turns into "anyone who sends one string is the owner" — silently, with nothing in the
 * code to notice. Signature checking costs one cached fetch and removes that whole class of
 * future mistake.
 */

/** Public keys change rarely; refetching them per request would put Access on the hot path. */
const JWKS_TTL_MS = 60 * 60 * 1000;

type CachedKeys = { at: number; keys: Map<string, CryptoKey> };
let cache: CachedKeys | undefined;

function b64urlToBytes(input: string): Uint8Array {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded + "=".repeat((4 - (padded.length % 4)) % 4));
  return Uint8Array.from(binary, (c) => c.charCodeAt(0));
}

async function loadKeys(teamDomain: string): Promise<Map<string, CryptoKey>> {
  const now = Date.now();
  if (cache !== undefined && now - cache.at < JWKS_TTL_MS) return cache.keys;

  const response = await fetch(`https://${teamDomain}/cdn-cgi/access/certs`);
  if (!response.ok) throw new Error(`Access JWKS: ${response.status}`);
  const body = (await response.json()) as { keys?: (JsonWebKey & { kid?: string })[] };

  const keys = new Map<string, CryptoKey>();
  for (const jwk of body.keys ?? []) {
    if (jwk.kid === undefined) continue;
    keys.set(
      jwk.kid,
      await crypto.subtle.importKey(
        "jwk",
        jwk,
        { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
        false,
        ["verify"],
      ),
    );
  }
  cache = { at: now, keys };
  return keys;
}

export type AccessEnv = {
  /** e.g. `life2film.cloudflareaccess.com`. Unset means Access is not in use. */
  ACCESS_TEAM_DOMAIN?: string;
  /**
   * The application's Audience (AUD) tag. Optional but strongly wanted: without it, a token
   * minted for ANY application in the same Access team is accepted here. With one app that is
   * academic; with two it is a hole that opens without anybody editing this file.
   */
  ACCESS_AUD?: string;
};

/**
 * Who Access says this is, or undefined if it does not say. Never throws: a failure to reach
 * the JWKS must fall back to the other door rather than lock the owner out of their own
 * dashboard.
 */
export async function accessIdentity(
  env: AccessEnv,
  jwt: string | undefined,
  now: number,
): Promise<string | undefined> {
  if (env.ACCESS_TEAM_DOMAIN === undefined || jwt === undefined || jwt === "") return undefined;

  const parts = jwt.split(".");
  if (parts.length !== 3) return undefined;

  try {
    const header = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[0]!))) as {
      kid?: string;
      alg?: string;
    };
    if (header.alg !== "RS256" || header.kid === undefined) return undefined;

    const key = (await loadKeys(env.ACCESS_TEAM_DOMAIN)).get(header.kid);
    if (key === undefined) return undefined;

    const ok = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      key,
      b64urlToBytes(parts[2]!),
      new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
    );
    if (!ok) return undefined;

    const claims = JSON.parse(new TextDecoder().decode(b64urlToBytes(parts[1]!))) as {
      email?: string;
      exp?: number;
      aud?: string | string[];
    };

    // An expired token is a token, and a signature stays valid long after the session ends.
    if (typeof claims.exp !== "number" || claims.exp * 1000 <= now) return undefined;

    if (env.ACCESS_AUD !== undefined && env.ACCESS_AUD !== "") {
      const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
      if (!aud.includes(env.ACCESS_AUD)) return undefined;
    }

    return claims.email ?? "access";
  } catch {
    return undefined;
  }
}
