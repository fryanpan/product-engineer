import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { buildMcpServers } from "./mcp";

describe("buildMcpServers", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    // Clear all MCP-relevant env vars
    delete process.env.LINEAR_API_KEY;
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

  it("includes linear when LINEAR_API_KEY is set", () => {
    process.env.LINEAR_API_KEY = "lin_test_key";

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

  it("includes notion when NOTION_TOKEN is set", () => {
    process.env.NOTION_TOKEN = "ntn_test_token";

    const servers = buildMcpServers();

    expect(Object.keys(servers)).toContain("notion");
    expect(servers.notion).toEqual({
      command: "npx",
      args: ["-y", "@notionhq/notion-mcp-server"],
      env: { NOTION_TOKEN: "ntn_test_token" },
    });
  });

  it("includes sentry when SENTRY_ACCESS_TOKEN is set", () => {
    process.env.SENTRY_ACCESS_TOKEN = "sntrys_test_token";
    process.env.ANTHROPIC_API_KEY = "sk-ant-test";

    const servers = buildMcpServers();

    expect(Object.keys(servers)).toContain("sentry");
    expect(servers.sentry).toEqual({
      command: "npx",
      args: ["-y", "@sentry/mcp-server@latest", "--access-token=sntrys_test_token"],
      env: {
        EMBEDDED_AGENT_PROVIDER: "anthropic",
        ANTHROPIC_API_KEY: "sk-ant-test",
      },
    });
  });

  it("includes sentry without ANTHROPIC_API_KEY in env", () => {
    process.env.SENTRY_ACCESS_TOKEN = "sntrys_test_token";

    const servers = buildMcpServers();

    expect(servers.sentry).toEqual({
      command: "npx",
      args: ["-y", "@sentry/mcp-server@latest", "--access-token=sntrys_test_token"],
      env: {
        EMBEDDED_AGENT_PROVIDER: "anthropic",
      },
    });
  });

  it("includes all servers when all env vars are set", () => {
    process.env.LINEAR_API_KEY = "lin_key";
    process.env.CONTEXT7_API_KEY = "c7_key";
    process.env.NOTION_TOKEN = "ntn_token";
    process.env.SENTRY_ACCESS_TOKEN = "sntrys_token";
    process.env.ANTHROPIC_API_KEY = "sk-ant-key";

    const servers = buildMcpServers();

    const keys = Object.keys(servers);
    expect(keys).toContain("linear");
    expect(keys).toContain("context7");
    expect(keys).toContain("notion");
    expect(keys).toContain("sentry");
    expect(keys).toHaveLength(4);
  });

  it("produces correct types for http configs", () => {
    process.env.LINEAR_API_KEY = "lin_key";

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

  it("produces correct types for stdio configs", () => {
    process.env.NOTION_TOKEN = "ntn_token";
    process.env.SENTRY_ACCESS_TOKEN = "sntrys_token";

    const servers = buildMcpServers();

    // Stdio configs must have command and args
    const notion = servers.notion as { command: string; args?: string[]; env?: Record<string, string> };
    expect(typeof notion.command).toBe("string");
    expect(Array.isArray(notion.args)).toBe(true);
    expect(notion.env).toBeDefined();

    const sentry = servers.sentry as { command: string; args?: string[]; env?: Record<string, string> };
    expect(typeof sentry.command).toBe("string");
    expect(Array.isArray(sentry.args)).toBe(true);
    expect(sentry.env).toBeDefined();
  });
});
