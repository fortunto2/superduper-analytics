/**
 * Who is allowed to report events. The list is generated from registry/sources.yaml at build
 * time — the Worker never parses YAML, and nothing at runtime can add a source. Registration
 * flows one way: git → generator → here.
 */
import { SOURCE_IDS } from "./registry.generated";

/** Built once per isolate, not per request. */
const KNOWN = new Set<string>(SOURCE_IDS);

export function isKnownSource(id: string): boolean {
  return KNOWN.has(id);
}
