import { describe, it, expect, beforeEach } from "bun:test";
import { DecisionEngine } from "./decision-engine";

describe("DecisionEngine", () => {
  let engine: DecisionEngine;

  beforeEach(() => {
    engine = new DecisionEngine({
      anthropicApiKey: "test-key",
      anthropicBaseUrl: undefined,
      slackBotToken: "xoxb-test",
      decisionsChannel: "#product-engineer-decisions",
      linearApiKey: "lin_test",
    });
  });

  it("renders ticket-review template", () => {
    const rendered = engine.renderTemplate("ticket-review", {
      identifier: "PE-42",
      title: "Fix button color",
      description: "The submit button is blue, should be green",
      priority: "Normal",
      activeCount: 3,
      activeTickets: [{ id: "PE-40", status: "in_progress", product: "health-tool" }],
      productName: "health-tool",
      repos: "bryanchan/health-tool",
      linearComments: [],
      slackThread: [],
    });
    expect(rendered).toContain("PE-42");
    expect(rendered).toContain("Fix button color");
    expect(rendered).toContain("PE-40");
  });

  it("renders merge-gate template", () => {
    const rendered = engine.renderTemplate("merge-gate", {
      identifier: "PE-42",
      title: "Fix button",
      pr_url: "https://github.com/org/repo/pull/1",
      pr_title: "Fix button color",
      branch: "ticket/PE-42",
      changedFiles: 2,
      additions: 10,
      deletions: 5,
      ciPassed: true,
      diffSummary: "Changed button color from blue to green",
      reviewComments: [],
      linearComments: [],
    });
    expect(rendered).toContain("PE-42");
    expect(rendered).toContain("auto_merge");
  });

  it("renders supervisor template", () => {
    const rendered = engine.renderTemplate("supervisor", {
      agentCount: 1,
      agents: [{
        ticketId: "PE-40",
        product: "health-tool",
        status: "in_progress",
        lastHeartbeat: "2026-03-09T10:00:00Z",
        heartbeatAge: "5m",
        healthStatus: "healthy",
        duration: "30m",
        pr_url: null,
        cost: "0.50",
      }],
      stalePRs: [],
      queuedTickets: [],
      dailyCost: "1.50",
      pendingEvents: 0,
    });
    expect(rendered).toContain("PE-40");
    expect(rendered).toContain("health-tool");
  });

  it("renders thread-classify template", () => {
    const rendered = engine.renderTemplate("thread-classify", {
      user: "U12345",
      text: "What's the status?",
      identifier: "PE-42",
      title: "Fix button",
      status: "in_progress",
      agentRunning: "yes",
    });
    expect(rendered).toContain("What's the status?");
    expect(rendered).toContain("PE-42");
  });

  it("parses JSON from LLM response with markdown fences", () => {
    const result = engine.parseDecisionResponse('```json\n{"action":"start_agent","model":"sonnet","reason":"clear"}\n```');
    expect(result.action).toBe("start_agent");
    expect(result.model).toBe("sonnet");
  });

  it("parses JSON from LLM response without fences", () => {
    const result = engine.parseDecisionResponse('{"action":"auto_merge","reason":"all green"}');
    expect(result.action).toBe("auto_merge");
  });

  it("parses JSON with surrounding text", () => {
    const result = engine.parseDecisionResponse('Here is my analysis:\n\n```json\n{"action":"escalate","reason":"security concern"}\n```\n\nLet me know if you need more details.');
    expect(result.action).toBe("escalate");
  });
});
