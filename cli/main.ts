/**
 * CLI. Mirrors the core pipeline so it can be exercised without a Worker, a network or
 * credentials. This is what makes `make integration` meaningful in CI and on a plane.
 *
 *   gen    --registry <file> --out <file>   registry YAML → src/registry.generated.ts
 *   check  --registry <file>                validate the registry, and that the generated
 *                                           file has not drifted from it
 *   replay --fixtures <dir>                 run NDJSON fixtures through the REAL ingest
 *   sync   --registry <file>                apply the registry to Cloudflare (not implemented)
 *
 * Keep the pipeline logic in src/ and import it here. If logic starts living in the CLI, the
 * Worker and the CLI will drift and `make integration` stops proving anything.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { EdgeContext } from "../src/ingest";
import { MAX_EVENTS_PER_REQUEST } from "../src/schema";
import { checkRegistry, readRegistry, renderGenerated, sourceIdsOf } from "./registry";

const DEFAULT_REGISTRY = "registry/sources.yaml";
const DEFAULT_GENERATED = "src/registry.generated.ts";
const DEFAULT_FIXTURES = "cli/fixtures";

/**
 * A fixed clock and a fixed edge, so a replay is a function of the fixtures alone. The moment
 * this reads a real clock, `make integration` stops being reproducible.
 */
const FIXED_NOW = Date.parse("2026-06-15T12:00:00.000Z");
const FIXED_EDGE: EdgeContext = {
  now: FIXED_NOW,
  country: "DE",
  userAgent:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15",
};

const args = process.argv.slice(2);
const [command] = args;

function flag(name: string, fallback: string): string {
  const at = args.indexOf(`--${name}`);
  if (at === -1) return fallback;
  return args[at + 1] ?? fallback;
}

function fail(message: string): never {
  console.error(message);
  process.exit(1);
}

function gen(): void {
  const registryPath = flag("registry", DEFAULT_REGISTRY);
  const outPath = flag("out", DEFAULT_GENERATED);
  const ids = sourceIdsOf(readRegistry(registryPath));
  writeFileSync(outPath, renderGenerated(ids));
  console.log(`${outPath} — ${ids.length} sources from ${registryPath}`);
}

function check(): void {
  const registryPath = flag("registry", DEFAULT_REGISTRY);
  const outPath = flag("out", DEFAULT_GENERATED);
  const registry = readRegistry(registryPath);
  const problems = checkRegistry(registry);

  const expected = renderGenerated(sourceIdsOf(registry));
  const actual = existsSync(outPath) ? readFileSync(outPath, "utf8") : "";
  if (actual !== expected) problems.push(`${outPath} is stale — run \`make gen\``);

  if (problems.length > 0) {
    fail(`${registryPath} has problems:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
  }
  console.log(
    `${registryPath} ok — ${registry.sites.length} sites, ${registry.apps.length} apps, ` +
      `${sourceIdsOf(registry).length} sources`,
  );
}

/**
 * `ingest` is imported lazily on purpose: it reaches src/registry.generated.ts, which `gen`
 * produces. A generator that cannot run until its own output exists is a trap for a clean
 * checkout, so gen and check must not pull the pipeline in.
 */
async function replay(): Promise<void> {
  const { ingest } = await import("../src/ingest");
  const { toDataPoint } = await import("../src/sinks/analytics-engine");
  const { BLOB_SLOTS, DOUBLE_SLOTS } = await import("../src/schema");
  const dir = flag("fixtures", DEFAULT_FIXTURES);
  if (!existsSync(dir)) fail(`no fixture directory at ${dir}`);

  // The legend goes to stderr so stdout stays a clean stream of data points, diffable against
  // a previous run when the mapping changes.
  console.error(`blobs:   ${BLOB_SLOTS.map((s, i) => `${i + 1}:${s}`).join("  ")}`);
  console.error(`doubles: ${DOUBLE_SLOTS.map((s, i) => `${i + 1}:${s}`).join("  ")}`);

  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".ndjson"))
    .sort();
  if (files.length === 0) fail(`no .ndjson fixtures in ${dir}`);

  let replayed = 0;

  for (const file of files) {
    const path = join(dir, file);
    const events: unknown[] = [];

    readFileSync(path, "utf8")
      .split("\n")
      .forEach((line, index) => {
        const trimmed = line.trim();
        if (trimmed === "" || trimmed.startsWith("#")) return;
        try {
          events.push(JSON.parse(trimmed));
        } catch {
          fail(`${path}:${index + 1}: not valid JSON`);
        }
      });

    // Batched exactly as a client would have to batch them — the 250/invocation ceiling is
    // part of the contract, so the fixtures exercise it rather than sidestep it.
    for (let at = 0; at < events.length; at += MAX_EVENTS_PER_REQUEST) {
      const result = ingest({ events: events.slice(at, at + MAX_EVENTS_PER_REQUEST) }, FIXED_EDGE);
      if (!result.ok) {
        fail(`${path}: batch at line ${at + 1} rejected ${result.status} ${JSON.stringify(result.body)}`);
      }
      // Exactly what writeDataPoint would receive — positions included, which is the part
      // worth proving offline, since a reordering is invisible until queries start lying.
      for (const event of result.events) console.log(JSON.stringify(toDataPoint(event)));
      replayed += result.events.length;
    }
  }

  console.error(`replayed ${replayed} events from ${files.length} fixture file(s), 0 rejected`);
}

// A malformed registry or a missing file must read as one clear line, not a stack trace —
// this runs in pre-commit hooks and in CI, where nobody reads the frames.
try {
  switch (command) {
    case "gen":
      gen();
      break;
    case "check":
      check();
      break;
    case "replay":
      await replay();
      break;
    case "sync":
      fail(
        "`sync` is not implemented yet. It applies the registry to Cloudflare: allowed origins " +
          "for the web ingest and per-app write keys as Worker secrets. It is the only command " +
          "here that needs credentials, which is why it is last.",
      );
      break;
    default:
      console.error("usage: main.ts <gen|check|replay|sync> [flags]");
      process.exit(2);
  }
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
