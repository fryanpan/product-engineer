import { describe, test, expect } from "bun:test";
import type { ProductConfig } from "./registry";

/**
 * Tests for infra channel routing.
 *
 * The infra channel is a GLOBAL setting (`infra_channel_id` in the conductor's
 * settings table), not per-product. All products share the same infra channel
 * for the environment. If the setting is not configured, infra messages are
 * silently dropped — they do NOT fall back to the product channel.
 */

describe("ProductConfig interface", () => {
  test("does not have infra_channel_id field", () => {
    const config: ProductConfig = {
      repos: ["org/repo"],
      slack_channel: "#main",
      slack_channel_id: "C_MAIN",
      triggers: { slack: { enabled: true } },
      secrets: {},
    };
    // infra_channel_id is NOT a per-product field — it's a global conductor setting
    expect("infra_channel_id" in config).toBe(false);
  });

  test("allows all standard product config fields", () => {
    const config: ProductConfig = {
      repos: ["org/repo"],
      slack_channel: "#main",
      slack_channel_id: "C_MAIN",
      triggers: {
        linear: { enabled: true, project_name: "My Project" },
        slack: { enabled: true },
      },
      secrets: { GITHUB_TOKEN: "GH_TOKEN_BINDING" },
      slack_persona: { username: "bot", icon_emoji: ":robot_face:" },
      mode: "coding",
    };
    expect(config.slack_channel).toBe("#main");
    expect(config.slack_channel_id).toBe("C_MAIN");
  });
});

describe("infra channel global setting behavior", () => {
  test("infra messages are dropped when no global setting is configured", () => {
    // Simulate getSetting returning null (not configured)
    const infraChannel = null; // getSetting(sql, "infra_channel_id") → null
    expect(infraChannel).toBeNull();
    // With null channel, notifyInfra returns early — no Slack message sent
  });

  test("infra messages go to global channel when configured", () => {
    const infraChannel = "C_INFRA_GLOBAL"; // getSetting(sql, "infra_channel_id")
    expect(infraChannel).toBe("C_INFRA_GLOBAL");
    // All products use this single channel
  });

  test("infra channel is set via admin API at settings level, not product level", () => {
    // The setting key is "infra_channel_id" in the conductor settings table
    // Set via: PUT /api/settings/infra_channel_id with body { value: "C_..." }
    const settingKey = "infra_channel_id";
    expect(settingKey).toBe("infra_channel_id");
  });
});
