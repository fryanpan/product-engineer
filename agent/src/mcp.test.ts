import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildMcpServers } from "./mcp";

describe("buildMcpServers", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all MCP-relevant env vars
    delete process.env.LINEAR_APP_TOKEN;
    delete process.env.CONTEXT7_API_KEY;
    delete process.env.NOTION_TOKEN;
    delete process.env.SENTRY_ACCESS_TOKEN;
    delete process.env.ANTHROPIC_API_KEY;
  });

  afterEach(() => {
    process.env = savedEnv;
  });

  it("returns only context7 when no env vars are set", () => {
    const servers = buildMcpServers();

    expect(Object.keys(servers)).toEqual(["context7"]);
    expect(servers.context7).toEqual({
      type: "http",
      url: "https://mcp.context7.com/mcp",
    });
  });

  it("includes linear when LINEAR_APP_TOKEN is set", () => {
    process.env.LINEAR_APP_TOKEN = "lin_test_key";

    const servers = buildMcpServers();

    expect(Object.keys(servers)).toContain("linear");
    expect(Object.keys(servers)).toContain("context7");
    expect(servers.linear).toEqual({
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: "Bearer lin_test_key" },
    });
  });

  it("adds headers to context7 when CONTEXT7_API_KEY is set", () => {
    process.env.CONTEXT7_API_KEY = "c7_test_key";

    const servers = buildMcpServers();

    expect(servers.context7).toEqual({
      type: "http",
      url: "https://mcp.context7.com/mcp",
      headers: { CONTEXT7_API_KEY: "c7_test_key" },
    });
  });

  // Notion and Sentry stdio servers are disabled (npx hangs in containers).
  // These tests are skipped until we pre-install MCP server packages in the Dockerfile.
  it.skip("includes notion when NOTION_TOKEN is set", () => {});
  it.skip("includes sentry when SENTRY_ACCESS_TOKEN is set", () => {});
  it.skip("includes sentry without ANTHROPIC_API_KEY in env", () => {});

  it("includes all HTTP servers when all env vars are set", () => {
    process.env.LINEAR_APP_TOKEN = "lin_key";
    process.env.CONTEXT7_API_KEY = "c7_key";

    const servers = buildMcpServers();

    const keys = Object.keys(servers);
    expect(keys).toContain("linear");
    expect(keys).toContain("context7");
    expect(keys).toHaveLength(2);
  });

  it("produces correct types for http configs", () => {
    process.env.LINEAR_APP_TOKEN = "lin_key";

    const servers = buildMcpServers();

    // HTTP configs must have type: "http" and url
    const linear = servers.linear as { type: string; url: string; headers?: Record<string, string> };
    expect(linear.type).toBe("http");
    expect(typeof linear.url).toBe("string");
    expect(linear.headers).toBeDefined();

    const context7 = servers.context7 as { type: string; url: string };
    expect(context7.type).toBe("http");
    expect(typeof context7.url).toBe("string");
  });

  // Stdio config type tests skipped — Notion/Sentry disabled (npx hangs in containers)
  it.skip("produces correct types for stdio configs", () => {});
});
