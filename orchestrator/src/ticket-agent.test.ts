import { describe, test, expect } from "bun:test";
import { resolveAgentEnvVars } from "./ticket-agent";

describe("resolveAgentEnvVars", () => {
  test("resolves secrets from env bindings", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {
        GITHUB_TOKEN: "HEALTH_TOOL_GITHUB_TOKEN",
        ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
      },
    };
    const env = {
      HEALTH_TOOL_GITHUB_TOKEN: "ghp_abc123",
      ANTHROPIC_API_KEY: "sk-ant-xyz",
      SLACK_BOT_TOKEN: "xoxb-slack",
    } as Record<string, string>;

    const vars = resolveAgentEnvVars(config, env);
    expect(vars.GITHUB_TOKEN).toBe("ghp_abc123");
    expect(vars.ANTHROPIC_API_KEY).toBe("sk-ant-xyz");
    expect(vars.PRODUCT).toBe("health-tool");
    expect(vars.REPOS).toBe(JSON.stringify(["fryanpan/health-tool"]));
    expect(vars.TICKET_ID).toBe("LIN-123");
    expect(vars.SLACK_CHANNEL).toBe("#health-tool");
    expect(vars.SLACK_BOT_TOKEN).toBe("xoxb-slack");
    expect(vars.WORKER_URL).toBe("");
  });

  test("uses WORKER_URL from env when provided", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {},
    };
    const env = {
      WORKER_URL: "https://custom-worker.example.com",
    } as Record<string, string>;

    const vars = resolveAgentEnvVars(config, env);
    expect(vars.WORKER_URL).toBe("https://custom-worker.example.com");
  });

  test("sets GH_TOKEN alias when GITHUB_TOKEN is resolved", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {
        GITHUB_TOKEN: "HEALTH_TOOL_GITHUB_TOKEN",
      },
    };
    const env = {
      HEALTH_TOOL_GITHUB_TOKEN: "ghp_abc123",
    } as Record<string, string>;

    const vars = resolveAgentEnvVars(config, env);
    expect(vars.GH_TOKEN).toBe("ghp_abc123");
    expect(vars.GH_TOKEN).toBe(vars.GITHUB_TOKEN);
  });

  test("does not set GH_TOKEN when GITHUB_TOKEN is missing", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {
        GITHUB_TOKEN: "MISSING_BINDING",
      },
    };
    const env = {} as Record<string, string>;

    const vars = resolveAgentEnvVars(config, env);
    expect(vars.GITHUB_TOKEN).toBe("");
    expect(vars.GH_TOKEN).toBeUndefined();
  });

  test("warns on missing secret binding", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {
        GITHUB_TOKEN: "MISSING_TOKEN",
      },
    };
    const env = {} as Record<string, string>;

    const vars = resolveAgentEnvVars(config, env);
    expect(vars.GITHUB_TOKEN).toBe("");
  });

  test("includes R2 credentials for session persistence", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {},
    };
    const env = {
      R2_ACCESS_KEY_ID: "r2_key_id",
      R2_SECRET_ACCESS_KEY: "r2_secret",
      CF_ACCOUNT_ID: "cf_account",
    } as Record<string, string>;

    const vars = resolveAgentEnvVars(config, env);
    expect(vars.R2_ACCESS_KEY_ID).toBe("r2_key_id");
    expect(vars.R2_SECRET_ACCESS_KEY).toBe("r2_secret");
    expect(vars.CF_ACCOUNT_ID).toBe("cf_account");
  });
});

describe("resolveAgentEnvVars - AI Gateway", () => {
  test("sets ANTHROPIC_BASE_URL when AI Gateway is configured", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {},
    };
    const env = {} as Record<string, string>;
    const gatewayConfig = {
      account_id: "abc123def456",
      gateway_id: "pe-gateway",
    };

    const vars = resolveAgentEnvVars(config, env, gatewayConfig);
    expect(vars.ANTHROPIC_BASE_URL).toBe(
      "https://gateway.ai.cloudflare.com/v1/abc123def456/pe-gateway/anthropic"
    );
  });

  test("does not set ANTHROPIC_BASE_URL when AI Gateway is explicitly null", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {},
    };
    const env = {} as Record<string, string>;

    const vars = resolveAgentEnvVars(config, env, null);
    expect(vars.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("does not set ANTHROPIC_BASE_URL when registry has no gateway config", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {},
    };
    const env = {} as Record<string, string>;

    // Omit gatewayConfig parameter — falls back to getAIGatewayConfig()
    // which returns null if registry.json has no cloudflare_ai_gateway
    const vars = resolveAgentEnvVars(config, env);
    expect(vars.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("formats gateway URL correctly with hyphens in IDs", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {},
    };
    const env = {} as Record<string, string>;
    const gatewayConfig = {
      account_id: "12345-abcde-67890",
      gateway_id: "prod-gateway-v2",
    };

    const vars = resolveAgentEnvVars(config, env, gatewayConfig);
    expect(vars.ANTHROPIC_BASE_URL).toBe(
      "https://gateway.ai.cloudflare.com/v1/12345-abcde-67890/prod-gateway-v2/anthropic"
    );
  });

  test("URL-encodes special characters in gateway IDs", () => {
    const config = {
      ticketId: "LIN-123",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      slackChannel: "#health-tool",
      secrets: {},
    };
    const env = {} as Record<string, string>;
    const gatewayConfig = {
      account_id: "abc/123",
      gateway_id: "gateway name",
    };

    const vars = resolveAgentEnvVars(config, env, gatewayConfig);
    expect(vars.ANTHROPIC_BASE_URL).toBe(
      "https://gateway.ai.cloudflare.com/v1/abc%2F123/gateway%20name/anthropic"
    );
  });
});
