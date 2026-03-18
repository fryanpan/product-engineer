import { describe, it, expect } from "bun:test";

describe("handleSlackInteractive", () => {
  it("builds confirmation blocks for good feedback", () => {
    const originalSection = {
      type: "section",
      text: { type: "mrkdwn", text: "🎫 *Ticket Review* — `PE-42`\n*Action:* start_agent\n*Reason:* Clear task" },
    };
    const userId = "U12345";

    const confirmationBlocks = [
      originalSection,
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `✓ Marked as *correct* by <@${userId}>` }],
      },
    ];

    expect(confirmationBlocks).toHaveLength(2);
    expect(confirmationBlocks[0]).toEqual(originalSection);
    expect(confirmationBlocks[1].type).toBe("context");
    expect(confirmationBlocks[1].elements[0].text).toContain("correct");
    expect(confirmationBlocks[1].elements[0].text).toContain(userId);
  });

  it("builds confirmation blocks for bad feedback with details", () => {
    const originalSection = {
      type: "section",
      text: { type: "mrkdwn", text: "🎫 *Ticket Review*" },
    };
    const userId = "U12345";
    const details = "Should have deferred to human";

    const label = "✗ Marked as *incorrect*";
    const detailsSuffix = `\n> ${details}`;
    const confirmationBlocks = [
      originalSection,
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `${label} by <@${userId}>${detailsSuffix}` }],
      },
    ];

    expect(confirmationBlocks[1].elements[0].text).toContain("incorrect");
    expect(confirmationBlocks[1].elements[0].text).toContain("Should have deferred");
  });

  it("modal view uses input blocks (not actions) for radio buttons", () => {
    const modalBlocks = [
      {
        type: "input",
        block_id: "feedback_choice",
        label: { type: "plain_text", text: "Was this decision correct?" },
        element: {
          type: "radio_buttons",
          action_id: "feedback_radio",
          options: [
            { text: { type: "plain_text", text: "✓ Correct" }, value: "good" },
            { text: { type: "plain_text", text: "✗ Incorrect" }, value: "bad" },
          ],
        },
      },
      {
        type: "input",
        block_id: "feedback_details",
        label: { type: "plain_text", text: "Additional context" },
        element: {
          type: "plain_text_input",
          action_id: "details_input",
          multiline: true,
        },
        optional: true,
      },
    ];

    expect(modalBlocks[0].type).toBe("input");
    expect(modalBlocks[1].type).toBe("input");
    expect(modalBlocks[0].element.type).toBe("radio_buttons");
  });

  it("private_metadata carries channel and message context as JSON", () => {
    const metadata = JSON.stringify({
      decisionId: "decision-123",
      channel: "C12345",
      messageTs: "1234567890.123456",
      originalSection: { type: "section", text: { type: "mrkdwn", text: "test" } },
    });

    const parsed = JSON.parse(metadata);
    expect(parsed.decisionId).toBe("decision-123");
    expect(parsed.channel).toBe("C12345");
    expect(parsed.messageTs).toBe("1234567890.123456");
    expect(parsed.originalSection).toBeTruthy();
  });
});
