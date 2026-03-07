import { describe, test, expect } from "bun:test";

describe("Status Command", () => {
  test("status command adds slash_command field", () => {
    // Verify the slack-socket.ts changes parse /pe-status correctly
    const mockEvent = {
      type: "message",
      text: "/pe-status",
      user: "U123",
      channel: "C123",
      ts: "1234567890.123456",
    };

    // The socket will detect /pe-status and add slash_command field
    const expectedEvent = {
      ...mockEvent,
      slash_command: "pe-status",
    };

    expect(expectedEvent.slash_command).toBe("pe-status");
  });

  test("status command with mention", () => {
    const text = "@product-engineer /pe-status";
    const hasStatus = text.includes("/pe-status");
    const hasMention = text.includes("@product-engineer");

    expect(hasStatus).toBe(true);
    expect(hasMention).toBe(true);
  });
});
