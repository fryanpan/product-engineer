import { describe, it, expect } from "bun:test";
import { buildPrompt } from "./prompt";
import type { TaskPayload } from "./config";

describe("buildPrompt", () => {
  it("builds correct prompt for feedback tasks", () => {
    const task: TaskPayload = {
      type: "feedback",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      data: {
        id: "fb-001",
        text: "The dashboard is slow",
        annotations: "Highlighted the chart area",
        page_url: "https://example.com/dashboard",
        screenshot: "https://example.com/screenshot.png",
      },
    };

    const prompt = buildPrompt(task);

    expect(prompt).toContain("health-tool");
    expect(prompt).toContain("User feedback");
    expect(prompt).toContain("The dashboard is slow");
    expect(prompt).toContain("Highlighted the chart area");
    expect(prompt).toContain("https://example.com/dashboard");
    expect(prompt).toContain("(attached)");
    expect(prompt).toContain("fb-001");
    expect(prompt).toContain("`fryanpan/health-tool`");
  });

  it("builds correct prompt for ticket tasks", () => {
    const task: TaskPayload = {
      type: "ticket",
      product: "bike-tool",
      repos: ["fryanpan/bike-tool"],
      data: {
        id: "issue-456",
        title: "Add route export feature",
        description: "Users want to export routes as GPX files",
        priority: 2,
        labels: ["feature", "export"],
      },
    };

    const prompt = buildPrompt(task);

    expect(prompt).toContain("bike-tool");
    expect(prompt).toContain("Linear ticket");
    expect(prompt).toContain("Add route export feature");
    expect(prompt).toContain("Users want to export routes as GPX files");
    expect(prompt).toContain("2"); // priority
    expect(prompt).toContain("feature, export");
    expect(prompt).toContain("issue-456");
    expect(prompt).toContain("`fryanpan/bike-tool`");
  });

  it("builds correct prompt for command tasks", () => {
    const task: TaskPayload = {
      type: "command",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      data: {
        text: "refactor the auth module",
        user: "U12345",
        channel: "#health-tool",
      },
    };

    const prompt = buildPrompt(task);

    expect(prompt).toContain("health-tool");
    expect(prompt).toContain("Slack command");
    expect(prompt).toContain("refactor the auth module");
    expect(prompt).toContain("<@U12345>");
    expect(prompt).toContain("#health-tool");
  });

  it("includes repo names in prompt", () => {
    const singleRepo: TaskPayload = {
      type: "ticket",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      data: {
        id: "i1",
        title: "Test",
        description: "",
        priority: 1,
        labels: [],
      },
    };

    const singlePrompt = buildPrompt(singleRepo);
    expect(singlePrompt).toContain("`fryanpan/health-tool`");
    expect(singlePrompt).toContain("The repo is already cloned");

    const multiRepo: TaskPayload = {
      type: "ticket",
      product: "health-tool",
      repos: ["fryanpan/health-tool", "fryanpan/health-tool-api"],
      data: {
        id: "i2",
        title: "Test multi",
        description: "",
        priority: 1,
        labels: [],
      },
    };

    const multiPrompt = buildPrompt(multiRepo);
    expect(multiPrompt).toContain("`fryanpan/health-tool`");
    expect(multiPrompt).toContain("`fryanpan/health-tool-api`");
    expect(multiPrompt).toContain("The repos are already cloned");
  });

  it("handles feedback with null optional fields", () => {
    const task: TaskPayload = {
      type: "feedback",
      product: "health-tool",
      repos: ["fryanpan/health-tool"],
      data: {
        id: "fb-002",
        text: null,
        annotations: null,
        page_url: null,
        screenshot: null,
      },
    };

    const prompt = buildPrompt(task);

    // Should still contain the type and ID
    expect(prompt).toContain("User feedback");
    expect(prompt).toContain("fb-002");
    // Should NOT contain the optional field labels when values are null
    expect(prompt).not.toContain("Feedback:");
    expect(prompt).not.toContain("Page URL:");
    expect(prompt).not.toContain("Annotations:");
    expect(prompt).not.toContain("(attached)");
  });

  it("handles ticket with no labels", () => {
    const task: TaskPayload = {
      type: "ticket",
      product: "bike-tool",
      repos: ["fryanpan/bike-tool"],
      data: {
        id: "issue-789",
        title: "Simple fix",
        description: "Fix a typo",
        priority: 4,
        labels: [],
      },
    };

    const prompt = buildPrompt(task);

    expect(prompt).toContain("Simple fix");
    expect(prompt).not.toContain("Labels:");
  });
});
