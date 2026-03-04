import { describe, it, expect } from "bun:test";
import {
  getAgentIdentity,
  getAIGatewayConfig,
  getProduct,
  getProducts,
  getProductByLinearProject,
  isOurTeam,
  loadRegistry,
} from "./registry";

describe("getProduct", () => {
  it("returns correct config for known products", () => {
    const health = getProduct("health-tool");
    expect(health).not.toBeNull();
    expect(health!.repos).toEqual(["fryanpan/health-tool"]);
    expect(health!.slack_channel).toBe("#health-tool");
    expect(health!.triggers.linear?.project_name).toBe("Health Tool");

    const bike = getProduct("bike-tool");
    expect(bike).not.toBeNull();
    expect(bike!.repos).toEqual(["fryanpan/bike-tool"]);

    const pe = getProduct("product-engineer");
    expect(pe).not.toBeNull();
    expect(pe!.repos).toEqual(["fryanpan/product-engineer"]);
    expect(pe!.slack_channel).toBe("#product-engineer");
    expect(pe!.triggers.linear?.project_name).toBe("Product Engineer");

    const aiProjectSupport = getProduct("ai-project-support");
    expect(aiProjectSupport).not.toBeNull();
    expect(aiProjectSupport!.repos).toEqual(["fryanpan/ai-project-support"]);
    expect(aiProjectSupport!.slack_channel).toBe("#project-support");
    expect(aiProjectSupport!.triggers.linear?.project_name).toBe("Project Support");

    const blogAssistant = getProduct("blog-assistant");
    expect(blogAssistant).not.toBeNull();
    expect(blogAssistant!.repos).toEqual(["fryanpan/blog-assistant"]);
    expect(blogAssistant!.slack_channel).toBe("#blog-assistant");
    expect(blogAssistant!.triggers.linear?.project_name).toBe("Blog Assistant");

    const givewellImpact = getProduct("givewell-impact");
    expect(givewellImpact).not.toBeNull();
    expect(givewellImpact!.repos).toEqual(["fryanpan/givewell-impact"]);
    expect(givewellImpact!.slack_channel).toBe("#nonprofit-impact");
    expect(givewellImpact!.triggers.linear?.project_name).toBe("Nonprofit Impact");

    const personalFinance = getProduct("personal-finance");
    expect(personalFinance).not.toBeNull();
    expect(personalFinance!.repos).toEqual(["fryanpan/personal-finance"]);
    expect(personalFinance!.slack_channel).toBe("#personal-finance");
    expect(personalFinance!.triggers.linear?.project_name).toBe("Personal Finance");
  });

  it("returns null for unknown products", () => {
    expect(getProduct("nonexistent")).toBeNull();
    expect(getProduct("")).toBeNull();
    expect(getProduct("HEALTH-TOOL")).toBeNull(); // case-sensitive
  });
});

describe("getProductByLinearProject", () => {
  it("matches case-insensitively", () => {
    const result1 = getProductByLinearProject("Health Tool");
    expect(result1).not.toBeNull();
    expect(result1!.name).toBe("health-tool");
    expect(result1!.config.repos).toEqual(["fryanpan/health-tool"]);

    const result2 = getProductByLinearProject("health tool");
    expect(result2).not.toBeNull();
    expect(result2!.name).toBe("health-tool");

    const result3 = getProductByLinearProject("HEALTH TOOL");
    expect(result3).not.toBeNull();
    expect(result3!.name).toBe("health-tool");

    const result4 = getProductByLinearProject("bike tool");
    expect(result4).not.toBeNull();
    expect(result4!.name).toBe("bike-tool");

    const result5 = getProductByLinearProject("Product Engineer");
    expect(result5).not.toBeNull();
    expect(result5!.name).toBe("product-engineer");

    const result6 = getProductByLinearProject("Project Support");
    expect(result6).not.toBeNull();
    expect(result6!.name).toBe("ai-project-support");

    const result7 = getProductByLinearProject("Blog Assistant");
    expect(result7).not.toBeNull();
    expect(result7!.name).toBe("blog-assistant");

    const result8 = getProductByLinearProject("Nonprofit Impact");
    expect(result8).not.toBeNull();
    expect(result8!.name).toBe("givewell-impact");

    const result9 = getProductByLinearProject("Personal Finance");
    expect(result9).not.toBeNull();
    expect(result9!.name).toBe("personal-finance");
  });

  it("returns null for unknown projects", () => {
    expect(getProductByLinearProject("Unknown Project")).toBeNull();
    expect(getProductByLinearProject("")).toBeNull();
    expect(getProductByLinearProject("health-tool")).toBeNull(); // slug, not project name
  });
});

describe("getProducts", () => {
  it("returns all products", () => {
    const products = getProducts();
    expect(Object.keys(products)).toContain("health-tool");
    expect(Object.keys(products)).toContain("bike-tool");
    expect(Object.keys(products)).toContain("product-engineer");
    expect(Object.keys(products)).toContain("ai-project-support");
    expect(Object.keys(products)).toContain("blog-assistant");
    expect(Object.keys(products)).toContain("givewell-impact");
    expect(Object.keys(products)).toContain("personal-finance");
    expect(products["health-tool"].slack_channel).toBe("#health-tool");
    expect(products["bike-tool"].slack_channel).toBe("#bike-tool");
    expect(products["product-engineer"].slack_channel).toBe("#product-engineer");
    expect(products["ai-project-support"].slack_channel).toBe("#project-support");
    expect(products["blog-assistant"].slack_channel).toBe("#blog-assistant");
    expect(products["givewell-impact"].slack_channel).toBe("#nonprofit-impact");
    expect(products["personal-finance"].slack_channel).toBe("#personal-finance");
  });
});

describe("getAgentIdentity", () => {
  it("returns configured agent identity", () => {
    const identity = getAgentIdentity();
    expect(identity.linear_email).toBe("bcagent13@gmail.com");
    expect(identity.linear_name).toBe("BC Agent");
  });
});

describe("isOurTeam", () => {
  it("returns true for Team Bryan's ID", () => {
    const registry = loadRegistry();
    expect(isOurTeam(registry.linear_team_id)).toBe(true);
    expect(isOurTeam("01328a7f-d761-4176-8bbf-004a397dc6f7")).toBe(true);
  });

  it("returns false for other team IDs", () => {
    expect(isOurTeam("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(isOurTeam("")).toBe(false);
    expect(isOurTeam("random-id")).toBe(false);
  });
});

describe("getAIGatewayConfig", () => {
  it("returns null or valid config object", () => {
    const config = getAIGatewayConfig();

    // Registry.json may or may not have cloudflare_ai_gateway configured
    if (config === null) {
      expect(config).toBeNull();
    } else {
      // If configured, should have required fields
      expect(typeof config).toBe("object");
      expect(typeof config.account_id).toBe("string");
      expect(typeof config.gateway_id).toBe("string");
      expect(config.account_id.length).toBeGreaterThan(0);
      expect(config.gateway_id.length).toBeGreaterThan(0);
    }
  });
});
