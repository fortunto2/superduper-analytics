/**
 * The registry file contract — node-side only. The Worker never sees YAML: `gen` turns this
 * into src/registry.generated.ts, and that is what ships.
 *
 * Ids are validated with the SAME `SourceId` schema events are, so a source that would be
 * rejected at ingest cannot be registered in the first place.
 */
import { readFileSync } from "node:fs";
import { parse } from "yaml";
import { z } from "zod/v4";
import { Platform, SourceId } from "../src/schema";

const Site = z.object({
  id: SourceId,
  url: z.url(),
});

const App = z.object({
  id: SourceId,
  platform: Platform,
  bundle_id: z.string().min(1),
  /** App Store Connect numeric id, quoted in YAML so it stays a string. */
  app_id: z.string().regex(/^\d+$/, "App Store Connect id is digits"),
  /** Optional cross-reference: the same product also has a site with this id. */
  site: SourceId.optional(),
});

export const RegistryFile = z.object({
  sites: z.array(Site).min(1),
  apps: z.array(App),
});

export type RegistryFile = z.infer<typeof RegistryFile>;

/**
 * Throws with the offending lines listed rather than a zod stack trace: this runs in a
 * pre-commit hook, where the message IS the product.
 */
export function readRegistry(path: string): RegistryFile {
  const parsed = RegistryFile.safeParse(parse(readFileSync(path, "utf8")));
  if (parsed.success) return parsed.data;
  const issues = parsed.error.issues.map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`);
  throw new Error(`${path} does not match the registry schema:\n${issues.join("\n")}`);
}

/**
 * Every id that may appear as `source` on an event. Sites and apps share ids on purpose
 * (live2play is both a landing page and an App Store listing — one funnel, one id), so this
 * is a deduplicated union. Sorted, so the generated file is stable across runs.
 */
export function sourceIdsOf(registry: RegistryFile): string[] {
  const ids = new Set<string>();
  for (const site of registry.sites) ids.add(site.id);
  for (const app of registry.apps) ids.add(app.id);
  return [...ids].sort();
}

/**
 * Problems that zod cannot express, because they are about the file as a whole.
 * Returns human-readable lines; empty means the registry is sound.
 */
export function checkRegistry(registry: RegistryFile): string[] {
  const problems: string[] = [];

  for (const [list, entries] of [
    ["sites", registry.sites],
    ["apps", registry.apps],
  ] as const) {
    const seen = new Set<string>();
    for (const entry of entries) {
      if (seen.has(entry.id)) problems.push(`${list}: duplicate id "${entry.id}"`);
      seen.add(entry.id);
    }
  }

  const siteIds = new Set(registry.sites.map((s) => s.id));
  for (const app of registry.apps) {
    if (app.site !== undefined && !siteIds.has(app.site)) {
      problems.push(`apps: "${app.id}" points at site "${app.site}", which does not exist`);
    }
  }

  return problems;
}

/** Sites with their hostname, so the Worker can line a site up against its Cloudflare zone. */
export function sitesOf(registry: RegistryFile): { id: string; host: string }[] {
  return registry.sites
    .map((site) => ({ id: site.id, host: new URL(site.url).host }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/** The exact contents of src/registry.generated.ts. Compared byte-for-byte by `check`. */
export function renderGenerated(registry: RegistryFile): string {
  const ids = sourceIdsOf(registry)
    .map((id) => `  ${JSON.stringify(id)},`)
    .join("\n");
  const sites = sitesOf(registry)
    .map((s) => `  { id: ${JSON.stringify(s.id)}, host: ${JSON.stringify(s.host)} },`)
    .join("\n");
  return `// GENERATED FILE — DO NOT EDIT.
// Source of truth is registry/sources.yaml. Regenerate with \`make gen\`; \`make check\` fails
// if this file has drifted from the registry.
//
// Committed on purpose: these are public identifiers, and a clean checkout must build without
// running a generator first.

/** Every id that may appear as \`source\` on an event — sites and apps, deduplicated. */
export const SOURCE_IDS = [
${ids}
] as const;

/** Sites only, with the hostname used to match a site against its Cloudflare zone. */
export const SITES = [
${sites}
] as const;
`;
}
