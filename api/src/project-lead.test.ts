import { describe, test, expect } from "bun:test";
import { resolveProjectLeadEnvVars, type ProjectLeadConfig } from "./project-lead";

describe("resolveProjectLeadEnvVars", () => {
  const baseConfig: ProjectLeadConfig = {
    product: "health-tool",
    repos: ["acme-org/health-tool"],
    slackChannel: "C12345",
    secrets: {
      GITHUB_TOKEN: "HEALTH_TOOL_GITHUB_TOKEN",
      ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY",
    },
  };

  const baseEnv: Record<string, string> = {
    HEALTH_TOOL_GITHUB_TOKEN: "ghp_abc123",
    ANTHROPIC_API_KEY: "sk-ant-xyz",
    SLACK_BOT_TOKEN: "xoxb-slack",
    LINEAR_APP_TOKEN: "lin_token",
    SENTRY_DSN: "https://sentry.example.com",
    WORKER_URL: "https://pe.example.com",
    API_KEY: "api_key_123",
  };

  test("resolves basic config fields", () => {
    const vars = resolveProjectLeadEnvVars(baseConfig, baseEnv);
    expect(vars.PRODUCT).toBe("health-tool");
    expect(vars.REPOS).toBe(JSON.stringify(["acme-org/health-tool"]));
    expect(vars.SLACK_CHANNEL).toBe("C12345");
    expect(vars.AGENT_ROLE).toBe("project-lead");
    expect(vars.MODEL).toBe("sonnet"); // default
    expect(vars.MODE).toBe("coding"); // default
    expect(vars.TICKET_UUID).toBe("project-lead-health-tool");
    expect(vars.TICKET_TITLE).toBe("Project lead for health-tool");
  });

  test("resolves per-product secrets from env bindings", () => {
    const vars = resolveProjectLeadEnvVars(baseConfig, baseEnv);
    expect(vars.GITHUB_TOKEN).toBe("ghp_abc123");
    expect(vars.ANTHROPIC_API_KEY).toBe("sk-ant-xyz");
  });

  test("sets GH_TOKEN alias when GITHUB_TOKEN is resolved", () => {
    const vars = resolveProjectLeadEnvVars(baseConfig, baseEnv);
    expect(vars.GH_TOKEN).toBe("ghp_abc123");
    expect(vars.GH_TOKEN).toBe(vars.GITHUB_TOKEN);
  });

  test("does not set GH_TOKEN when GITHUB_TOKEN is missing", () => {
    const configNoGithub: ProjectLeadConfig = {
      ...baseConfig,
      secrets: { ANTHROPIC_API_KEY: "ANTHROPIC_API_KEY" },
    };
    const vars = resolveProjectLeadEnvVars(configNoGithub, baseEnv);
    expect(vars.GH_TOKEN).toBeUndefined();
  });

  test("uses custom model when specified", () => {
    const config: ProjectLeadConfig = { ...baseConfig, model: "opus" };
    const vars = resolveProjectLeadEnvVars(config, baseEnv);
    expect(vars.MODEL).toBe("opus");
  });

  test("uses custom mode when specified", () => {
    const config: ProjectLeadConfig = { ...baseConfig, mode: "research" };
    const vars = resolveProjectLeadEnvVars(config, baseEnv);
    expect(vars.MODE).toBe("research");
  });

  test("sets Slack persona when provided", () => {
    const config: ProjectLeadConfig = {
      ...baseConfig,
      slackPersona: { username: "HealthBot", icon_emoji: ":robot_face:" },
    };
    const vars = resolveProjectLeadEnvVars(config, baseEnv);
    expect(JSON.parse(vars.SLACK_PERSONA)).toEqual({
      username: "HealthBot",
      icon_emoji: ":robot_face:",
    });
  });

  test("sets empty SLACK_PERSONA when not provided", () => {
    const vars = resolveProjectLeadEnvVars(baseConfig, baseEnv);
    expect(vars.SLACK_PERSONA).toBe("");
  });

  test("resolves platform secrets from env", () => {
    const vars = resolveProjectLeadEnvVars(baseConfig, baseEnv);
    expect(vars.SLACK_BOT_TOKEN).toBe("xoxb-slack");
    expect(vars.LINEAR_APP_TOKEN).toBe("lin_token");
    expect(vars.SENTRY_DSN).toBe("https://sentry.example.com");
    expect(vars.WORKER_URL).toBe("https://pe.example.com");
    expect(vars.API_KEY).toBe("api_key_123");
  });

  test("sets ANTHROPIC_BASE_URL when gateway config is provided", () => {
    const gateway = { account_id: "acc123", gateway_id: "gw456" };
    const vars = resolveProjectLeadEnvVars(baseConfig, baseEnv, gateway);
    expect(vars.ANTHROPIC_BASE_URL).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc123/gw456/anthropic",
    );
  });

  test("does not set ANTHROPIC_BASE_URL without gateway config", () => {
    const vars = resolveProjectLeadEnvVars(baseConfig, baseEnv);
    expect(vars.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("handles missing secret bindings gracefully", () => {
    const config: ProjectLeadConfig = {
      ...baseConfig,
      secrets: { GITHUB_TOKEN: "NONEXISTENT_BINDING" },
    };
    const vars = resolveProjectLeadEnvVars(config, baseEnv);
    expect(vars.GITHUB_TOKEN).toBe("");
  });

  test("defaults to empty strings for missing env vars", () => {
    const vars = resolveProjectLeadEnvVars(baseConfig, {} as Record<string, string>);
    expect(vars.SLACK_BOT_TOKEN).toBe("");
    expect(vars.WORKER_URL).toBe("");
    expect(vars.SENTRY_DSN).toBe("");
  });
});
