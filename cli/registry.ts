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

/**
 * `public` opts a source into the open-startup page at /open. It defaults to FALSE: a source
 * added tomorrow stays private until someone deliberately publishes it. Opt-in, because the
 * opposite mistake — a product's numbers going public because nobody remembered a flag — is
 * not one you can take back.
 */
const Publishable = { public: z.boolean().default(false) };

const Site = z.object({
  id: SourceId,
  url: z.url(),
  /**
   * What to call this on screen. `id` is permanent because it partitions the archive, so it
   * cannot follow a rename or a move to a new domain — and a dashboard that shows the id ends
   * up presenting `visaphoto` for a product called VisaYes. Optional: the id is a fine name
   * until it is not.
   */
  name: z.string().min(1).optional(),
  /**
   * The site is switched off. It stays in the registry rather than being deleted, because the
   * id partitions the archive: delete the row and the history it labels becomes unanswerable —
   * "what was `editor`?" has no answer anywhere. Retired sources are excluded from coverage,
   * which otherwise counts a target that can never be reached and quietly makes the whole
   * fraction ignorable.
   */
  retired: z.boolean().default(false),
  /**
   * GA4 property this site reports into — the numeric id, not the `G-`/`GT-` tag.
   *
   * Optional and public: it is an identifier, not a credential, and reading it still requires
   * the service account. One property can serve several sites (superduperai and live2play share
   * one), so the daily job filters by this site's hostname rather than trusting the property to
   * be about one site.
   */
  ga_property_id: z
    .string()
    .regex(/^\d+$/, "GA4 property id is digits — the numeric id, not the G- tag")
    .optional(),
  ...Publishable,
});

const App = z.object({
  id: SourceId,
  platform: Platform,
  bundle_id: z.string().min(1),
  /**
   * App Store Connect numeric id, quoted in YAML so it stays a string.
   *
   * Optional because Google Play has no such thing — an Android app is identified by its
   * package name, and the daily store job is App Store Connect only (`platform === "ios"`).
   * While this was required, the first Android entry made `gen` refuse the whole registry,
   * and with it `check` and `test`: one app without an Apple id blocked every other change.
   */
  app_id: z.string().regex(/^\d+$/, "App Store Connect id is digits").optional(),
  /** Optional cross-reference: the same product also has a site with this id. */
  site: SourceId.optional(),
  ...Publishable,
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

  const seenSites = new Set<string>();
  for (const site of registry.sites) {
    if (seenSites.has(site.id)) problems.push(`sites: duplicate id "${site.id}"`);
    seenSites.add(site.id);
  }

  // У приложений ключ — id вместе с платформой. Один продукт на двух магазинах носит ОДИН id
  // намеренно: события различаются полем `platform`, которое колонка, а не источник, и вторая
  // воронка на тот же продукт была бы ошибкой. Пока правило смотрело на один id, первый же
  // Android рядом со своим iOS ронял проверку — а с ней `gen` и `test`.
  const seenApps = new Set<string>();
  for (const app of registry.apps) {
    const key = `${app.id}/${app.platform}`;
    if (seenApps.has(key)) problems.push(`apps: duplicate id "${app.id}" on ${app.platform}`);
    seenApps.add(key);
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
export function sitesOf(
  registry: RegistryFile,
): {
  id: string;
  name: string;
  host: string;
  url: string;
  open: boolean;
  retired: boolean;
  ga: string;
}[] {
  return registry.sites
    .map((site) => ({
      id: site.id,
      name: site.name ?? site.id,
      host: new URL(site.url).host,
      url: site.url,
      open: site.public,
      retired: site.retired,
      // Пустая строка, а не undefined: файл генерируется как литерал, и одно поле, то
      // появляющееся, то исчезающее, читается хуже, чем одно и то же поле пустым
      ga: site.ga_property_id ?? "",
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Apps with the id the store knows them by. The daily store-report job iterates this: without
 * it the job would need its own list of app ids, and a second list is a list that goes stale.
 */
export function appsOf(
  registry: RegistryFile,
): { id: string; platform: string; storeId: string; site: string | null }[] {
  return registry.apps
    .map((app) => ({
      id: app.id,
      platform: app.platform,
      // Пусто у Android: идентификатора App Store у него нет, а суточный джоб отбирает ios
      storeId: app.app_id ?? "",
      site: app.site ?? null,
    }))
    .sort((a, b) => a.id.localeCompare(b.id) || a.platform.localeCompare(b.platform));
}

/** The exact contents of src/registry.generated.ts. Compared byte-for-byte by `check`. */
export function renderGenerated(registry: RegistryFile): string {
  const ids = sourceIdsOf(registry)
    .map((id) => `  ${JSON.stringify(id)},`)
    .join("\n");
  const apps = appsOf(registry)
    .map(
      (a) =>
        `  { id: ${JSON.stringify(a.id)}, platform: ${JSON.stringify(a.platform)}, ` +
        `storeId: ${JSON.stringify(a.storeId)}, site: ${a.site === null ? "null" : JSON.stringify(a.site)} },`,
    )
    .join("\n");
  const sites = sitesOf(registry)
    .map(
      (s) =>
        `  { id: ${JSON.stringify(s.id)}, name: ${JSON.stringify(s.name)}, ` +
        `host: ${JSON.stringify(s.host)}, ` +
        `url: ${JSON.stringify(s.url)}, open: ${String(s.open)}, ` +
        `retired: ${String(s.retired)}, ga: ${JSON.stringify(s.ga)} },`,
    )
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

/** Apps with the id their store knows them by — what the daily store-report job iterates. */
export const APPS = [
${apps}
] as const;
`;
}
