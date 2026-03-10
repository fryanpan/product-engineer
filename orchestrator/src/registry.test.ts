import { describe, it, expect, beforeEach } from "bun:test";
import {
  getLinearAppUserId,
  getAIGatewayConfig,
  getProduct,
  getProducts,
  getProductByLinearProject,
  isOurTeam,
  loadRegistry,
  clearRegistryCache,
} from "./registry";
import { createMockOrchestratorStub, TEST_REGISTRY } from "./test-helpers";

describe("Registry with DO backend", () => {
  let mockOrchestrator: DurableObjectStub;

  beforeEach(() => {
    // Clear cache before each test to ensure fresh data
    clearRegistryCache();
    mockOrchestrator = createMockOrchestratorStub(TEST_REGISTRY);
  });

  describe("getProduct", () => {
    it("returns correct config for known products", async () => {
      const testApp = await getProduct(mockOrchestrator, "test-app");
      expect(testApp).not.toBeNull();
      expect(testApp!.repos).toEqual(["test-org/test-app"]);
      expect(testApp!.slack_channel).toBe("#test-app");
      expect(testApp!.triggers.linear?.project_name).toBe("Test App");

      const anotherApp = await getProduct(mockOrchestrator, "another-app");
      expect(anotherApp).not.toBeNull();
      expect(anotherApp!.repos).toEqual(["test-org/another-app"]);
      expect(anotherApp!.slack_channel).toBe("#another-app");
      expect(anotherApp!.triggers.linear?.project_name).toBe("Another App");

      const multiRepo = await getProduct(mockOrchestrator, "multi-repo-app");
      expect(multiRepo).not.toBeNull();
      expect(multiRepo!.repos).toEqual(["test-org/frontend", "test-org/backend"]);
    });

    it("returns null for unknown products", async () => {
      expect(await getProduct(mockOrchestrator, "nonexistent")).toBeNull();
      expect(await getProduct(mockOrchestrator, "")).toBeNull();
      expect(await getProduct(mockOrchestrator, "TEST-APP")).toBeNull(); // case-sensitive
    });
  });

  describe("getProductByLinearProject", () => {
    it("matches case-insensitively", async () => {
      const result1 = await getProductByLinearProject(mockOrchestrator, "Test App");
      expect(result1).not.toBeNull();
      expect(result1!.name).toBe("test-app");
      expect(result1!.config.repos).toEqual(["test-org/test-app"]);

      const result2 = await getProductByLinearProject(mockOrchestrator, "test app");
      expect(result2).not.toBeNull();
      expect(result2!.name).toBe("test-app");

      const result3 = await getProductByLinearProject(mockOrchestrator, "TEST APP");
      expect(result3).not.toBeNull();
      expect(result3!.name).toBe("test-app");

      const result4 = await getProductByLinearProject(mockOrchestrator, "another app");
      expect(result4).not.toBeNull();
      expect(result4!.name).toBe("another-app");

      const result5 = await getProductByLinearProject(mockOrchestrator, "Multi Repo");
      expect(result5).not.toBeNull();
      expect(result5!.name).toBe("multi-repo-app");
    });

    it("returns null for unknown projects", async () => {
      expect(await getProductByLinearProject(mockOrchestrator, "Unknown Project")).toBeNull();
      expect(await getProductByLinearProject(mockOrchestrator, "")).toBeNull();
      expect(await getProductByLinearProject(mockOrchestrator, "test-app")).toBeNull(); // slug, not project name
    });
  });

  describe("getProducts", () => {
    it("returns all products", async () => {
      const products = await getProducts(mockOrchestrator);
      expect(Object.keys(products)).toContain("test-app");
      expect(Object.keys(products)).toContain("another-app");
      expect(Object.keys(products)).toContain("multi-repo-app");
      expect(products["test-app"].slack_channel).toBe("#test-app");
      expect(products["another-app"].slack_channel).toBe("#another-app");
      expect(products["multi-repo-app"].slack_channel).toBe("#multi-repo");
    });
  });

  describe("getLinearAppUserId", () => {
    it("returns configured app user ID", async () => {
      const appUserId = await getLinearAppUserId(mockOrchestrator);
      expect(appUserId).toBe("app-user-001");
    });
  });

  describe("isOurTeam", () => {
    it("returns true for our team ID", async () => {
      const registry = await loadRegistry(mockOrchestrator);
      expect(await isOurTeam(mockOrchestrator, registry.linear_team_id)).toBe(true);
      expect(await isOurTeam(mockOrchestrator, "00000000-0000-0000-0000-000000000001")).toBe(true);
    });

    it("returns false for other team IDs", async () => {
      expect(await isOurTeam(mockOrchestrator, "00000000-0000-0000-0000-000000000000")).toBe(false);
      expect(await isOurTeam(mockOrchestrator, "")).toBe(false);
      expect(await isOurTeam(mockOrchestrator, "random-id")).toBe(false);
    });
  });

  describe("getAIGatewayConfig", () => {
    it("returns null when not configured", async () => {
      const config = await getAIGatewayConfig(mockOrchestrator);
      expect(config).toBeNull();
    });

    it("returns config when configured", async () => {
      const registryWithGateway = {
        ...TEST_REGISTRY,
        cloudflare_ai_gateway: {
          account_id: "test-account-id",
          gateway_id: "test-gateway-id",
        },
      };

      const mockWithGateway = createMockOrchestratorStub(registryWithGateway);
      clearRegistryCache();

      const config = await getAIGatewayConfig(mockWithGateway);
      expect(config).not.toBeNull();
      expect(config!.account_id).toBe("test-account-id");
      expect(config!.gateway_id).toBe("test-gateway-id");
    });
  });

  describe("caching", () => {
    it("caches registry after first load", async () => {
      // First call loads from DO
      const registry1 = await loadRegistry(mockOrchestrator);

      // Second call should return cached version (same object reference)
      const registry2 = await loadRegistry(mockOrchestrator);

      expect(registry1).toBe(registry2);
    });

    it("clears cache when clearRegistryCache is called", async () => {
      const registry1 = await loadRegistry(mockOrchestrator);

      clearRegistryCache();

      const registry2 = await loadRegistry(mockOrchestrator);

      // Should be different object references after cache clear
      expect(registry1).not.toBe(registry2);
      // But content should be the same
      expect(registry1.linear_team_id).toBe(registry2.linear_team_id);
    });
  });
});
