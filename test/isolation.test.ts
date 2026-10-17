import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

/**
 * A guard for the guard in vitest.config.ts. If the pool ever goes back to reading .dev.vars,
 * every other test would silently start calling production again — and still pass.
 */
describe("test isolation", () => {
  it("runs with placeholder credentials, never the real ones", () => {
    expect(env.CF_API_TOKEN).toBe("test-token-not-real");
    expect(env.DASHBOARD_KEY).toBe("test-dashboard-key");
  });

  it("cannot reach the network", async () => {
    const res = await fetch("https://api.cloudflare.com/client/v4/zones");
    expect(res.status).toBe(599);
  });
});
