import { describe, it, expect } from "bun:test";
import { analyzeComplexity, selectModel, selectModelForTicket } from "./model-selection";

describe("Model Selection", () => {
  describe("analyzeComplexity", () => {
    it("should classify simple typo fixes as low complexity", () => {
      const complexity = analyzeComplexity({
        title: "Fix typo in README",
        description: "Small typo fix",
        priority: 4,
      });
      expect(complexity).toBe("low");
    });

    it("should classify normal tasks as medium complexity", () => {
      const complexity = analyzeComplexity({
        title: "Add new feature for user profiles",
        description: "Implement a new user profile page with basic info",
        priority: 3,
      });
      expect(complexity).toBe("medium");
    });

    it("should classify architecture work as high complexity", () => {
      const complexity = analyzeComplexity({
        title: "Refactor authentication system",
        description: "Major architecture refactor to improve security",
        priority: 1,
        labels: ["urgent", "feature"],
      });
      expect(complexity).toBe("high");
    });

    it("should classify urgent priority tasks with longer descriptions as higher complexity", () => {
      const complexity = analyzeComplexity({
        title: "Implement new API endpoint",
        description: "Add a new REST API endpoint with authentication, rate limiting, comprehensive error handling, and proper documentation. This is a critical feature that needs to be production-ready and well-tested. The implementation should follow our established patterns and integrate seamlessly with existing services. Security is paramount - all inputs must be validated and sanitized. The endpoint should handle edge cases gracefully and provide meaningful error messages. Performance is also critical - the endpoint should be able to handle high traffic loads. We need proper logging, monitoring, and alerting in place. The API should be versioned to allow for future changes without breaking existing clients. Documentation should include examples, parameter descriptions, and response schemas. Integration tests are required before deployment.",
        priority: 1, // Urgent
      });
      expect(complexity).toBe("high");
    });

    it("should classify low-priority bug fixes appropriately", () => {
      const complexity = analyzeComplexity({
        title: "Fix minor styling issue",
        description: "Button alignment is slightly off",
        priority: 4,
        labels: ["bug", "minor"],
      });
      expect(complexity).toBe("low");
    });
  });

  describe("selectModel", () => {
    it("should select haiku for low complexity", () => {
      expect(selectModel("low")).toBe("haiku");
    });

    it("should select sonnet for medium complexity", () => {
      expect(selectModel("medium")).toBe("sonnet");
    });

    it("should select opus for high complexity", () => {
      expect(selectModel("high")).toBe("opus");
    });
  });

  describe("selectModelForTicket", () => {
    it("should return model, complexity, and reason", () => {
      const result = selectModelForTicket({
        title: "Fix typo",
        priority: 4,
      });
      expect(result.model).toBe("haiku");
      expect(result.complexity).toBe("low");
      expect(result.reason).toContain("Simple task");
    });

    it("should handle performance optimization as high complexity", () => {
      const result = selectModelForTicket({
        title: "Optimize database query performance",
        description: "Slow queries are causing timeout issues",
        priority: 2,
      });
      expect(result.complexity).toBe("high");
      expect(result.model).toBe("opus");
    });

    it("should handle security issues as high complexity", () => {
      const result = selectModelForTicket({
        title: "Fix security vulnerability in auth flow",
        description: "OWASP vulnerability found",
        priority: 1,
      });
      expect(result.complexity).toBe("high");
      expect(result.model).toBe("opus");
    });
  });
});
