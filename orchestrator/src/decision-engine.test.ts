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
      linearAppToken: "lin_test",
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
      repos: "acme-org/sample-app",
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
        ticketUUID: "abc-123-uuid",
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

  it("builds Block Kit blocks with feedback buttons", () => {
    const log = {
      id: "decision-123",
      timestamp: "2026-03-18T10:00:00Z",
      type: "ticket_review" as const,
      ticket_id: "PE-42",
      context_summary: "Test context",
      action: "start_agent",
      reason: "Clear task description",
      confidence: 0.9,
    };

    // @ts-ignore - accessing private method for testing
    const blocks = engine.buildDecisionBlocks(log, "🎫", "Ticket Review");

    expect(blocks).toHaveLength(3);
    expect(blocks[0]).toHaveProperty("type", "section");
    expect(blocks[1]).toHaveProperty("type", "actions");
    expect(blocks[2]).toHaveProperty("type", "context");

    // Check action block has three buttons
    const actionBlock = blocks[1] as { elements: Array<{ action_id: string; value: string }> };
    expect(actionBlock.elements).toHaveLength(3);
    expect(actionBlock.elements[0].action_id).toBe("decision_feedback_good");
    expect(actionBlock.elements[1].action_id).toBe("decision_feedback_bad");
    expect(actionBlock.elements[2].action_id).toBe("decision_feedback_details");

    // All buttons should have the decision ID as their value
    expect(actionBlock.elements[0].value).toBe("decision-123");
    expect(actionBlock.elements[1].value).toBe("decision-123");
    expect(actionBlock.elements[2].value).toBe("decision-123");
  });
});
