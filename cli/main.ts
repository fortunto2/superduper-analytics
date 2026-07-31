/**
 * CLI — STUB. Mirrors the core pipeline so it can be exercised without a Worker, a network
 * or credentials. This is what makes `make integration` meaningful in CI and on a plane.
 *
 * Commands to implement:
 *
 *   replay --fixtures <dir>
 *     Read newline-delimited JSON events, run them through the SAME validation and
 *     enrichment the Worker uses, print what would be written to each sink. Exit non-zero on
 *     any rejected event. Deterministic: no clock, no randomness — pass a fixed `now`.
 *
 *   sync --registry registry/sources.yaml
 *     Read the registry and apply it: allowed origins, per-app write keys (as Worker
 *     secrets, never printed or committed), Iceberg partition values. Must be idempotent —
 *     running it twice changes nothing the second time.
 *
 *   check --registry registry/sources.yaml
 *     Validate the registry alone: ids unique and permanent-looking, urls parseable, every
 *     `app.site` pointing at a real site. Cheap enough to run as a pre-commit hook.
 *
 * Keep the pipeline logic in src/ and import it here. If logic starts living in the CLI, the
 * Worker and the CLI will drift and `make integration` stops proving anything.
 */

const [command] = process.argv.slice(2);

switch (command) {
  case "replay":
  case "sync":
  case "check":
    console.error(`"${command}" is not implemented yet — see the header of cli/main.ts`);
    process.exit(1);
    break;
  default:
    console.error("usage: main.ts <replay|sync|check> [flags]");
    process.exit(2);
}
