# Decision Feedback UX Fix

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix three UX bugs in decision feedback buttons: no visual confirmation after clicking, broken "Give Details" modal, and no confirmation after modal submit.

**Architecture:** All changes are in `orchestrator/src/orchestrator.ts` (the `handleSlackInteractive` method) and its test file. The fix uses Slack's `chat.update` API to replace buttons with confirmation text after interaction, and corrects the modal's block structure so radio button values are captured on submission.

**Tech Stack:** Slack Block Kit, Slack Web API (`chat.update`, `views.open`), Bun test runner

---

### Task 1: Add `chat.update` helper and fix payload types

**Files:**
- Modify: `orchestrator/src/orchestrator.ts:2796-2809` (payload type)
- Modify: `orchestrator/src/orchestrator.ts` (add helper near line 2795)

**Step 1: Expand the payload type to include `channel`**

The `block_actions` payload from Slack includes `channel.id` and `message.ts`, but the type is missing `channel`. Update the type at line 2796:

```typescript
const payload = await request.json<{
  type: string;
  user: { id: string };
  actions?: Array<{ action_id: string; value: string }>;
  channel?: { id: string };
  message?: { ts: string; blocks?: unknown[] };
  view?: {
    id: string;
    state: {
      values: Record<string, Record<string, { value?: string; selected_option?: { value: string } }>>;
    };
    private_metadata?: string;
  };
  trigger_id?: string;
}>();
```

Key changes: added `channel?: { id: string }`, added `blocks?: unknown[]` to `message`.

**Step 2: Add a private helper method to update a Slack message**

Add this method to the Orchestrator class (above or below `handleSlackInteractive`):

```typescript
private async updateSlackMessage(channel: string, ts: string, blocks: unknown[]): Promise<void> {
  try {
    await fetch("https://slack.com/api/chat.update", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.getSlackBotToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ channel, ts, blocks }),
    });
  } catch (err) {
    console.error("[Orchestrator] Failed to update Slack message:", err);
  }
}
```

**Step 3: Commit**

```bash
git add orchestrator/src/orchestrator.ts
git commit -m "feat: add updateSlackMessage helper and fix payload types"
```

---

### Task 2: Add visual confirmation on button click

**Files:**
- Modify: `orchestrator/src/orchestrator.ts:2817-2853` (good/bad button handlers)

**Step 1: Update the "good" button handler (line 2817-2834)**

After the SQL insert, replace the buttons by calling `chat.update`. The updated handler:

```typescript
if (action.action_id === "decision_feedback_good") {
  this.ctx.storage.sql.exec(
    `INSERT INTO decision_feedback (id, decision_id, feedback, given_by, given_at, slack_message_ts)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(decision_id) DO UPDATE SET
       feedback = excluded.feedback,
       given_by = excluded.given_by,
       given_at = datetime('now')`,
    crypto.randomUUID(),
    decisionId,
    "good",
    userId,
    payload.message?.ts || null,
  );
  console.log(`[Orchestrator] Decision feedback (button): good for ${decisionId} from user ${userId}`);

  // Replace buttons with confirmation
  if (payload.channel?.id && payload.message?.ts && payload.message?.blocks) {
    const originalSection = payload.message.blocks[0];
    await this.updateSlackMessage(payload.channel.id, payload.message.ts, [
      originalSection,
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `✓ Marked as *correct* by <@${userId}>` }],
      },
    ]);
  }

  return Response.json({ ok: true });
}
```

**Step 2: Update the "bad" button handler (line 2836-2853)**

Same pattern but with "incorrect" text:

```typescript
if (action.action_id === "decision_feedback_bad") {
  this.ctx.storage.sql.exec(
    `INSERT INTO decision_feedback (id, decision_id, feedback, given_by, given_at, slack_message_ts)
     VALUES (?, ?, ?, ?, datetime('now'), ?)
     ON CONFLICT(decision_id) DO UPDATE SET
       feedback = excluded.feedback,
       given_by = excluded.given_by,
       given_at = datetime('now')`,
    crypto.randomUUID(),
    decisionId,
    "bad",
    userId,
    payload.message?.ts || null,
  );
  console.log(`[Orchestrator] Decision feedback (button): bad for ${decisionId} from user ${userId}`);

  // Replace buttons with confirmation
  if (payload.channel?.id && payload.message?.ts && payload.message?.blocks) {
    const originalSection = payload.message.blocks[0];
    await this.updateSlackMessage(payload.channel.id, payload.message.ts, [
      originalSection,
      {
        type: "context",
        elements: [{ type: "mrkdwn", text: `✗ Marked as *incorrect* by <@${userId}>` }],
      },
    ]);
  }

  return Response.json({ ok: true });
}
```

**Step 3: Run tests**

Run: `cd orchestrator && bun test`
Expected: All existing tests pass (no behavior change to test generation).

**Step 4: Commit**

```bash
git add orchestrator/src/orchestrator.ts
git commit -m "feat: add visual confirmation when clicking feedback buttons"
```

---

### Task 3: Fix "Give Details" modal — radio buttons in `input` block + pass message context

**Files:**
- Modify: `orchestrator/src/orchestrator.ts:2855-2928` (details button handler + modal definition)

**Step 1: Fix the modal definition**

The radio buttons are currently in an `actions` block (line 2873). Slack modals only include `input` block values in `view.state.values`. Change it to an `input` block. Also encode `channel` and `message_ts` in `private_metadata` so the modal submission handler can update the original message.

Replace the entire `decision_feedback_details` handler (lines 2855-2928):

```typescript
if (action.action_id === "decision_feedback_details" && payload.trigger_id) {
  // Encode message context so modal submission can update the original message
  const metadata = JSON.stringify({
    decisionId,
    channel: payload.channel?.id || null,
    messageTs: payload.message?.ts || null,
    originalSection: payload.message?.blocks?.[0] || null,
  });

  const modalView = {
    type: "modal",
    callback_id: "decision_feedback_modal",
    private_metadata: metadata,
    title: { type: "plain_text", text: "Decision Feedback" },
    submit: { type: "plain_text", text: "Submit" },
    close: { type: "plain_text", text: "Cancel" },
    blocks: [
      {
        type: "input",
        block_id: "feedback_choice",
        label: { type: "plain_text", text: "Was this decision correct?" },
        element: {
          type: "radio_buttons",
          action_id: "feedback_radio",
          options: [
            {
              text: { type: "plain_text", text: "✓ Correct" },
              value: "good",
            },
            {
              text: { type: "plain_text", text: "✗ Incorrect" },
              value: "bad",
            },
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
          placeholder: {
            type: "plain_text",
            text: "What was right or wrong about this decision...",
          },
        },
        optional: true,
      },
    ],
  };

  try {
    await fetch("https://slack.com/api/views.open", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.getSlackBotToken()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        trigger_id: payload.trigger_id,
        view: modalView,
      }),
    });
  } catch (err) {
    console.error("[Orchestrator] Failed to open modal:", err);
  }

  return Response.json({ ok: true });
}
```

**Step 2: Run tests**

Run: `cd orchestrator && bun test`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add orchestrator/src/orchestrator.ts
git commit -m "fix: use input block for modal radio buttons so values are captured"
```

---

### Task 4: Fix modal submission handler to save feedback and update message

**Files:**
- Modify: `orchestrator/src/orchestrator.ts:2932-2958` (view_submission handler)

**Step 1: Update the modal submission handler**

Parse the JSON `private_metadata` to get `decisionId`, `channel`, `messageTs`, and `originalSection`. After saving feedback, call `chat.update` to replace buttons with confirmation.

Replace lines 2932-2958:

```typescript
if (payload.type === "view_submission" && payload.view) {
  let decisionId = "";
  let channel: string | null = null;
  let messageTs: string | null = null;
  let originalSection: unknown = null;

  try {
    const meta = JSON.parse(payload.view.private_metadata || "{}");
    decisionId = meta.decisionId || "";
    channel = meta.channel || null;
    messageTs = meta.messageTs || null;
    originalSection = meta.originalSection || null;
  } catch {
    decisionId = payload.view.private_metadata || "";
  }

  const values = payload.view.state.values;
  const feedbackChoice = values.feedback_choice?.feedback_radio?.selected_option?.value as "good" | "bad" | undefined;
  const details = values.feedback_details?.details_input?.value || null;
  const userId = payload.user.id;

  if (feedbackChoice) {
    this.ctx.storage.sql.exec(
      `INSERT INTO decision_feedback (id, decision_id, feedback, details, given_by, given_at, slack_message_ts)
       VALUES (?, ?, ?, ?, ?, datetime('now'), ?)
       ON CONFLICT(decision_id) DO UPDATE SET
         feedback = excluded.feedback,
         details = excluded.details,
         given_by = excluded.given_by,
         given_at = datetime('now')`,
      crypto.randomUUID(),
      decisionId,
      feedbackChoice,
      details,
      userId,
      messageTs,
    );
    console.log(`[Orchestrator] Decision feedback (modal): ${feedbackChoice} for ${decisionId} from user ${userId} with details`);

    // Update the original message to show confirmation
    if (channel && messageTs && originalSection) {
      const label = feedbackChoice === "good" ? "✓ Marked as *correct*" : "✗ Marked as *incorrect*";
      const detailsSuffix = details ? `\n> ${details}` : "";
      await this.updateSlackMessage(channel, messageTs, [
        originalSection,
        {
          type: "context",
          elements: [{ type: "mrkdwn", text: `${label} by <@${userId}>${detailsSuffix}` }],
        },
      ]);
    }
  }

  return Response.json({ response_action: "clear" });
}
```

**Step 2: Run tests**

Run: `cd orchestrator && bun test`
Expected: All tests pass.

**Step 3: Commit**

```bash
git add orchestrator/src/orchestrator.ts
git commit -m "fix: modal submission saves feedback and updates original message"
```

---

### Task 5: Add tests for interactive handler

**Files:**
- Create: `orchestrator/src/interactive-handler.test.ts`

**Step 1: Write tests for the three interaction paths**

```typescript
import { describe, it, expect } from "bun:test";

describe("handleSlackInteractive", () => {
  // These are integration-style tests that verify the Block Kit structures
  // produced by the handler. The actual handler requires a full DO context,
  // so we test the data transformations.

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
    // This verifies the fix: radio buttons must be in input blocks
    // for view.state.values to be populated on submission
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

    // Both blocks must be type "input" — NOT "actions" or "section"
    expect(modalBlocks[0].type).toBe("input");
    expect(modalBlocks[1].type).toBe("input");
    // Radio buttons are nested inside the input element
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
```

**Step 2: Run tests**

Run: `cd orchestrator && bun test`
Expected: All tests pass including new ones.

**Step 3: Commit**

```bash
git add orchestrator/src/interactive-handler.test.ts
git commit -m "test: add tests for interactive feedback handler"
```

---

### Task 6: Final verification and PR

**Step 1: Run full test suite**

Run: `cd orchestrator && bun test`
Expected: All tests pass.

**Step 2: Commit any remaining changes and create PR**

Use `/commit-push-pr` to create the PR with title: "Fix decision feedback UX: visual confirmation, modal bug, message update"
