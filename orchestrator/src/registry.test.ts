import { describe, it, expect } from "bun:test";
import {
  getAgentIdentity,
  getProduct,
  getProducts,
  getProductByLinearProject,
  isOurTeam,
  loadRegistry,
} from "./registry";

describe("getProduct", () => {
  it("returns correct config for known products", () => {
    const myApp = getProduct("my-app");
    expect(myApp).not.toBeNull();
    expect(myApp!.repos).toEqual(["your-org/my-app"]);
    expect(myApp!.slack_channel).toBe("#my-app");
    expect(myApp!.triggers.linear?.project_name).toBe("My App");
    expect(myApp!.triggers.feedback?.enabled).toBe(true);
    expect(myApp!.triggers.feedback?.callback_url).toBe(
      "https://my-app-api.example.com",
    );

    const myOther = getProduct("my-other-app");
    expect(myOther).not.toBeNull();
    expect(myOther!.repos).toEqual(["your-org/my-other-app"]);
    expect(myOther!.triggers.feedback).toBeUndefined();
  });

  it("returns null for unknown products", () => {
    expect(getProduct("nonexistent")).toBeNull();
    expect(getProduct("")).toBeNull();
    expect(getProduct("MY-APP")).toBeNull(); // case-sensitive
  });
});

describe("getProductByLinearProject", () => {
  it("matches case-insensitively", () => {
    const result1 = getProductByLinearProject("My App");
    expect(result1).not.toBeNull();
    expect(result1!.name).toBe("my-app");
    expect(result1!.config.repos).toEqual(["your-org/my-app"]);

    const result2 = getProductByLinearProject("my app");
    expect(result2).not.toBeNull();
    expect(result2!.name).toBe("my-app");

    const result3 = getProductByLinearProject("MY APP");
    expect(result3).not.toBeNull();
    expect(result3!.name).toBe("my-app");

    const result4 = getProductByLinearProject("My Other App");
    expect(result4).not.toBeNull();
    expect(result4!.name).toBe("my-other-app");
  });

  it("returns null for unknown projects", () => {
    expect(getProductByLinearProject("Unknown Project")).toBeNull();
    expect(getProductByLinearProject("")).toBeNull();
    expect(getProductByLinearProject("my-app")).toBeNull(); // slug, not project name
  });
});

describe("getProducts", () => {
  it("returns all products", () => {
    const products = getProducts();
    expect(Object.keys(products)).toContain("my-app");
    expect(Object.keys(products)).toContain("my-other-app");
    expect(products["my-app"].slack_channel).toBe("#my-app");
    expect(products["my-other-app"].slack_channel).toBe("#my-other-app");
  });
});

describe("getAgentIdentity", () => {
  it("returns configured agent identity", () => {
    const identity = getAgentIdentity();
    expect(identity.linear_email).toBe("agent@example.com");
    expect(identity.linear_name).toBe("My Agent");
  });
});

describe("isOurTeam", () => {
  it("returns true for configured team ID", () => {
    const registry = loadRegistry();
    expect(isOurTeam(registry.linear_team_id)).toBe(true);
    expect(isOurTeam("00000000-0000-0000-0000-000000000001")).toBe(true);
  });

  it("returns false for other team IDs", () => {
    expect(isOurTeam("00000000-0000-0000-0000-000000000000")).toBe(false);
    expect(isOurTeam("")).toBe(false);
    expect(isOurTeam("random-id")).toBe(false);
  });
});
