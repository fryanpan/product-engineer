import { describe, test, expect } from "bun:test";
import { resolveContainerEnvVars } from "./container-env";

describe("resolveContainerEnvVars", () => {
  const baseConfig = {
    product: "health-tool",
    repos: ["acme-org/sample-app"],
    slackChannel: "#health-tool",
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
    WORKER_URL: "https://pe.example.com",
    API_KEY: "api_key_123",
    R2_ACCESS_KEY_ID: "r2_key",
    R2_SECRET_ACCESS_KEY: "r2_secret",
    CF_ACCOUNT_ID: "cf_account",
  };

  test("resolves base vars from config and env", () => {
    const vars = resolveContainerEnvVars(baseConfig, baseEnv);
    expect(vars.PRODUCT).toBe("health-tool");
    expect(vars.REPOS).toBe(JSON.stringify(["acme-org/sample-app"]));
    expect(vars.SLACK_CHANNEL).toBe("#health-tool");
    expect(vars.SLACK_BOT_TOKEN).toBe("xoxb-slack");
    expect(vars.WORKER_URL).toBe("https://pe.example.com");
    expect(vars.R2_ACCESS_KEY_ID).toBe("r2_key");
    expect(vars.R2_SECRET_ACCESS_KEY).toBe("r2_secret");
    expect(vars.CF_ACCOUNT_ID).toBe("cf_account");
  });

  test("resolves per-product secrets from env bindings", () => {
    const vars = resolveContainerEnvVars(baseConfig, baseEnv);
    expect(vars.GITHUB_TOKEN).toBe("ghp_abc123");
    expect(vars.ANTHROPIC_API_KEY).toBe("sk-ant-xyz");
  });

  test("sets GH_TOKEN alias when GITHUB_TOKEN is resolved", () => {
    const vars = resolveContainerEnvVars(baseConfig, baseEnv);
    expect(vars.GH_TOKEN).toBe("ghp_abc123");
  });

  test("does not set GH_TOKEN when GITHUB_TOKEN is missing", () => {
    const config = { ...baseConfig, secrets: {} };
    const vars = resolveContainerEnvVars(config, baseEnv);
    expect(vars.GH_TOKEN).toBeUndefined();
  });

  test("sets ANTHROPIC_BASE_URL when gateway configured", () => {
    const gateway = { account_id: "acc123", gateway_id: "gw456" };
    const vars = resolveContainerEnvVars(baseConfig, baseEnv, gateway);
    expect(vars.ANTHROPIC_BASE_URL).toBe(
      "https://gateway.ai.cloudflare.com/v1/acc123/gw456/anthropic",
    );
  });

  test("does not set ANTHROPIC_BASE_URL without gateway", () => {
    const vars = resolveContainerEnvVars(baseConfig, baseEnv);
    expect(vars.ANTHROPIC_BASE_URL).toBeUndefined();
  });

  test("includes extraVars in output", () => {
    const vars = resolveContainerEnvVars(baseConfig, baseEnv, null, {
      TASK_UUID: "abc-123",
      AGENT_ROLE: "project-lead",
    });
    expect(vars.TASK_UUID).toBe("abc-123");
    expect(vars.AGENT_ROLE).toBe("project-lead");
  });

  test("handles missing secret bindings gracefully", () => {
    const config = {
      ...baseConfig,
      secrets: { GITHUB_TOKEN: "NONEXISTENT_BINDING" },
    };
    const vars = resolveContainerEnvVars(config, baseEnv);
    expect(vars.GITHUB_TOKEN).toBe("");
  });

  test("defaults to empty strings for missing env vars", () => {
    const vars = resolveContainerEnvVars(baseConfig, {} as Record<string, string>);
    expect(vars.SLACK_BOT_TOKEN).toBe("");
    expect(vars.WORKER_URL).toBe("");
  });
});
