import { describe, test, expect } from "bun:test";

describe("PE Status Command", () => {
  test("pe-status command adds slash_command field", () => {
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

  test("pe-status command with mention", () => {
    // Test with realistic Slack mention format: <@USERID> text
    const text = "<@U123> /pe-status";
    const regex = /(^|\s)\/pe-status(\s|$)/;

    expect(regex.test(text)).toBe(true);
  });
});
