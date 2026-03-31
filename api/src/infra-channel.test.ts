import { describe, test, expect } from "bun:test";
import type { ProductConfig } from "./registry";

/**
 * Tests for infra channel routing logic.
 *
 * The notifyInfra method in conductor.ts uses:
 *   productConfig.infra_channel_id || productConfig.slack_channel_id || productConfig.slack_channel
 *
 * We test this channel resolution logic directly.
 */

function resolveInfraChannel(config: ProductConfig): string | undefined {
  return config.infra_channel_id || config.slack_channel_id || config.slack_channel || undefined;
}

describe("infra channel resolution", () => {
  test("uses infra_channel_id when configured", () => {
    const config: ProductConfig = {
      repos: ["org/repo"],
      slack_channel: "#main",
      slack_channel_id: "C_MAIN",
      infra_channel_id: "C_INFRA",
      triggers: { slack: { enabled: true } },
      secrets: {},
    };
    expect(resolveInfraChannel(config)).toBe("C_INFRA");
  });

  test("falls back to slack_channel_id when infra_channel_id is not set", () => {
    const config: ProductConfig = {
      repos: ["org/repo"],
      slack_channel: "#main",
      slack_channel_id: "C_MAIN",
      triggers: { slack: { enabled: true } },
      secrets: {},
    };
    expect(resolveInfraChannel(config)).toBe("C_MAIN");
  });

  test("falls back to slack_channel when neither infra_channel_id nor slack_channel_id is set", () => {
    const config: ProductConfig = {
      repos: ["org/repo"],
      slack_channel: "#main",
      triggers: { slack: { enabled: true } },
      secrets: {},
    };
    expect(resolveInfraChannel(config)).toBe("#main");
  });

  test("infra_channel_id takes precedence over slack_channel_id", () => {
    const config: ProductConfig = {
      repos: ["org/repo"],
      slack_channel: "#main",
      slack_channel_id: "C_MAIN",
      infra_channel_id: "C_INFRA_SPECIFIC",
      triggers: { slack: { enabled: true } },
      secrets: {},
    };
    expect(resolveInfraChannel(config)).toBe("C_INFRA_SPECIFIC");
  });

  test("ProductConfig interface accepts infra_channel_id", () => {
    const config: ProductConfig = {
      repos: ["org/repo"],
      slack_channel: "#main",
      infra_channel_id: "C_INFRA",
      triggers: {},
      secrets: {},
    };
    expect(config.infra_channel_id).toBe("C_INFRA");
  });

  test("ProductConfig interface allows infra_channel_id to be omitted", () => {
    const config: ProductConfig = {
      repos: ["org/repo"],
      slack_channel: "#main",
      triggers: {},
      secrets: {},
    };
    expect(config.infra_channel_id).toBeUndefined();
  });
});
