/**
 * Tests run inside workerd, not Node — the same runtime the Worker deploys to. That is the
 * only way `request.cf`, the AE binding and Hono's edge behaviour mean anything in a test.
 *
 * `wrangler.configPath` makes the bindings come from the real config: a binding renamed in
 * wrangler.jsonc breaks the tests instead of silently drifting from production.
 *
 * AI-NOTE: on @cloudflare/vitest-pool-workers 0.20 (the vitest 4 line) the old
 * `defineWorkersConfig` from "@cloudflare/vitest-pool-workers/config" is GONE — that subpath
 * no longer exists and `test.poolOptions` is ignored. It is a plain vite plugin now. Most
 * docs and answers still show the old form; they are for 0.5–0.8.
 */
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.jsonc" } })],
});
