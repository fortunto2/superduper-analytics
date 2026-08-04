/**
 * Who is allowed to report events. The list is generated from registry/sources.yaml at build
 * time — the Worker never parses YAML, and nothing at runtime can add a source. Registration
 * flows one way: git → generator → here.
 */
import { SITES, SOURCE_IDS } from "./registry.generated";

/** Built once per isolate, not per request. */
const KNOWN = new Set<string>(SOURCE_IDS);

export function isKnownSource(id: string): boolean {
  return KNOWN.has(id);
}

/** Where each site actually lives. Built once per isolate, like the set above. */
const HOSTS = new Map<string, string>(SITES.map((s) => [s.id, s.host]));

/**
 * Is this event coming from where the registry says the source lives?
 *
 * The point is to stop counting ourselves building the thing. A beacon is a cross-origin POST,
 * so the browser attaches `Origin` at no cost to us, and anything that is not the registered
 * host is a local server, a preview deploy, or somebody else's copy of the tag — none of which
 * are visitors.
 *
 * FAILS OPEN, deliberately, in three places: no Origin (mobile apps, some privacy modes), a
 * source with no registered site (app-only ids), or an unparseable value. Dropping a real
 * visitor to be tidy is the worse error — the whole point of this project is that the numbers
 * are not quietly wrong.
 *
 * `www.` is accepted for the bare host and the other way round, because which one a site
 * redirects to is a hosting detail that changes without anybody thinking about analytics.
 */
export function isRegisteredOrigin(sourceId: string, origin: string | undefined): boolean {
  const expected = HOSTS.get(sourceId);
  if (expected === undefined || origin === undefined || origin === "" || origin === "null") {
    return true;
  }
  let host: string;
  try {
    host = new URL(origin).host.toLowerCase();
  } catch {
    return true;
  }
  const bare = (h: string) => (h.startsWith("www.") ? h.slice(4) : h);
  return bare(host) === bare(expected.toLowerCase());
}
