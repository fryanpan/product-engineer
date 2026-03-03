import { describe, it, expect } from "bun:test";
import {
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
    expect(products["health-tool"].slack_channel).toBe("#health-tool");
    expect(products["bike-tool"].slack_channel).toBe("#bike-tool");
    expect(products["product-engineer"].slack_channel).toBe("#product-engineer");
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
