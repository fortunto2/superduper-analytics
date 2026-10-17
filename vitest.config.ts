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

/**
 * The wrangler config also pulls in .dev.vars — the REAL account id and API token. Until
 * 2026-10-17 that meant `make test` (and `make deploy`, which runs it) sent list_products and
 * /open.json through the production SQL and GraphQL APIs, spending metered quota and asserting
 * against whatever the live account held that minute. The Makefile promises tests need no
 * network and no credentials; these two settings are what keep the promise.
 */
export const TEST_BINDINGS = {
  CF_ACCOUNT_ID: "00000000000000000000000000000000",
  CF_API_TOKEN: "test-token-not-real",
  DASHBOARD_KEY: "test-dashboard-key",
  ANON_SALT: "test-salt",
  INTERNAL_IPS: "203.0.113.7",
};

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: TEST_BINDINGS,
        // Anything a test did not stub with vi.stubGlobal lands here and fails loudly, rather
        // than reaching api.cloudflare.com with whatever token happens to be configured.
        outboundService: (request: Request) =>
          new Response(`tests must not reach the network: ${request.url}`, { status: 599 }),
      },
    }),
  ],
});
