/**
 * The MCP server publishes business numbers, so the tests that matter are about who can reach
 * it and whether it says when a figure is unreliable.
 */
import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const post = (body: unknown, headers: Record<string, string> = {}) =>
  SELF.fetch("https://analytics.example/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", "mcp-protocol-version": "2025-11-25", ...headers },
    body: JSON.stringify(body),
  });

const auth = { authorization: `Bearer ${env.DASHBOARD_KEY}` };

describe("who may call it", () => {
  it("refuses without a token, and says how to authenticate", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe("Bearer");
  });

  it("refuses a wrong token", async () => {
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { authorization: "Bearer nope" })).status).toBe(401);
  });

  it("accepts the dashboard key", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "ping" }, auth);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ jsonrpc: "2.0", id: 1, result: {} });
  });
});

describe("the protocol", () => {
  it("echoes back a version the client asked for rather than the newest", async () => {
    const res = await post(
      { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } },
      { ...auth, "mcp-protocol-version": "2025-06-18" },
    );
    const body = (await res.json()) as { result: { protocolVersion: string } };
    expect(body.result.protocolVersion).toBe("2025-06-18");
  });

  it("rejects a version it does not speak", async () => {
    expect((await post({ jsonrpc: "2.0", id: 1, method: "ping" }, { ...auth, "mcp-protocol-version": "1999-01-01" })).status).toBe(400);
  });

  it("answers a notification with 202 and no body", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" }, auth);
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });

  it("opens no stream on GET, and says so", async () => {
    expect((await SELF.fetch("https://analytics.example/mcp")).status).toBe(405);
  });

  it("reports an unknown method as -32601", async () => {
    const body = (await (await post({ jsonrpc: "2.0", id: 3, method: "nope" }, auth)).json()) as {
      error: { code: number };
    };
    expect(body.error.code).toBe(-32601);
  });
});

describe("tools", () => {
  it("offers exactly the six it can back with real data", async () => {
    const body = (await (await post({ jsonrpc: "2.0", id: 4, method: "tools/list" }, auth)).json()) as {
      result: { tools: { name: string }[] };
    };
    expect(body.result.tools.map(t => t.name).sort()).toEqual([
      "agent_traffic",
      "campaigns",
      "content",
      "counter_coverage",
      "list_products",
      "traffic",
    ]);
  });

  it("lists products from the registry without touching the network", async () => {
    const body = (await (
      await post(
        { jsonrpc: "2.0", id: 5, method: "tools/call", params: { name: "list_products" } },
        auth,
      )
    ).json()) as { result: { content: { text: string }[] } };
    const text = body.result.content[0]?.text ?? "";
    expect(text).toContain("superduperai");
    expect(text).toContain("NOT INSTALLED");
  });

  it("rejects an unknown tool rather than answering emptily", async () => {
    const body = (await (
      await post({ jsonrpc: "2.0", id: 6, method: "tools/call", params: { name: "invent" } }, auth)
    ).json()) as { error?: { code: number }; result?: unknown };
    expect(body.error?.code).toBe(-32602);
  });
});
