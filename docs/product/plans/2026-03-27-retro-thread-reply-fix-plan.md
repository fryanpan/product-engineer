# Thread Reply Context Loss — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fix thread reply context loss when a ProjectLead handles a task inline and the user follows up later.

**Architecture:** Two independent fixes: (1) `spawn_task` tool accepts a `mode` parameter so research tasks can be delegated to TaskAgent containers without repos, (2) ProjectLead saves transcript + session_id to the specific task record at multiple checkpoints, enabling resume on thread reply.

**Tech Stack:** TypeScript, Bun, Cloudflare Workers/Durable Objects, R2

---

### Task 1: Add `mode` parameter to `spawn_task` tool

**Files:**
- Modify: `agent/src/tools.ts:409-444`
- Test: `agent/src/tools.test.ts`

**Step 1: Write the failing test**

```typescript
// In agent/src/tools.test.ts — add a new describe block for spawn_task
describe("spawn_task", () => {
  test("passes mode parameter to spawn-task endpoint", async () => {
    // Set up fetch mock to capture the request body
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, taskUUID: "test-123" }), { status: 200 }),
    );

    const { tools } = createTools(makeConfig());
    const spawnTool = tools.find((t) => t.name === "spawn_task");
    expect(spawnTool).toBeDefined();

    // Call with mode: "research"
    await spawnTool!.handler({ product: "test-product", description: "Research Berlin tech", mode: "research" });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.mode).toBe("research");

    fetchSpy.mockRestore();
  });

  test("defaults mode to coding when not specified", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true, taskUUID: "test-123" }), { status: 200 }),
    );

    const { tools } = createTools(makeConfig());
    const spawnTool = tools.find((t) => t.name === "spawn_task");

    await spawnTool!.handler({ product: "test-product", description: "Fix a bug" });

    const body = JSON.parse(fetchSpy.mock.calls[0][1]?.body as string);
    expect(body.mode).toBe("coding");

    fetchSpy.mockRestore();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd agent && bun test src/tools.test.ts -t "spawn_task"`
Expected: FAIL — `spawn_task` tool doesn't accept `mode` parameter

**Step 3: Add `mode` parameter to `spawn_task` tool**

In `agent/src/tools.ts:409-444`, change the schema to add `mode` and pass it through:

```typescript
  const spawnTask = tool(
    "spawn_task",
    "Spawn a task agent to work on a task. If a taskUUID is provided (e.g., from a task_created event), the agent works on that existing task. Otherwise a new task is created.",
    {
      product: z.string().describe("Product slug (e.g., 'staging-test-app')"),
      description: z.string().describe("Task description — what should be done"),
      taskUUID: z.string().optional().describe("Existing task UUID to spawn an agent for (from event payload). Omit to create a new task."),
      mode: z.enum(["coding", "research"]).optional().describe("Agent mode: 'coding' for tasks needing repos/CI, 'research' for web research and writing tasks (default: 'coding')"),
    },
    async ({ product, description, taskUUID: existingUUID, mode }) => {
      try {
        const taskUUID = existingUUID || `conductor-task-${Date.now()}`;
        const res = await fetch(`${config.workerUrl}/api/project-lead/spawn-task`, {
          method: "POST",
          headers: {
            "X-Internal-Key": config.apiKey,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            product,
            taskUUID,
            taskTitle: description.slice(0, 80),
            taskDescription: description,
            mode: mode || "coding",
          }),
        });
        if (!res.ok) {
          const text = await res.text();
          return { content: [{ type: "text" as const, text: `Failed to spawn task: ${res.status} ${text}` }] };
        }
        const data = await res.json() as { taskUUID?: string };
        return { content: [{ type: "text" as const, text: `Task spawned for ${product}: ${data.taskUUID || taskUUID}` }] };
      } catch (err) {
        return { content: [{ type: "text" as const, text: `Error: ${err}` }] };
      }
    },
  );
```

**Step 4: Run test to verify it passes**

Run: `cd agent && bun test src/tools.test.ts -t "spawn_task"`
Expected: PASS

**Step 5: Commit**

```bash
git add agent/src/tools.ts agent/src/tools.test.ts
git commit -m "feat: add mode parameter to spawn_task tool for research tasks"
```

---

### Task 2: Add `associatedTaskUUID` to transcript upload endpoint

**Files:**
- Modify: `api/src/index.ts:188-227`
- Test: `api/src/integration.test.ts` (or new test for the endpoint)

**Step 1: Write the failing test**

```typescript
// In api/src/integration.test.ts — add test for associatedTaskUUID
describe("upload-transcript with associatedTaskUUID", () => {
  test("updates associated task record in addition to container task", async () => {
    // POST to /api/internal/upload-transcript with associatedTaskUUID
    const res = await app.request("/api/internal/upload-transcript", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Internal-Key": env.API_KEY,
      },
      body: JSON.stringify({
        taskUUID: "project-lead-myproduct",
        r2Key: "agent-uuid-session-id.jsonl",
        transcript: '{"sessionId":"sess-123"}\n',
        associatedTaskUUID: "conductor-task-12345",
      }),
    });

    expect(res.status).toBe(200);

    // Verify that conductor received TWO status updates:
    // one for "project-lead-myproduct" and one for "conductor-task-12345"
    // (Check via the mock conductor fetch calls)
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd api && bun test src/integration.test.ts -t "associatedTaskUUID"`
Expected: FAIL — `associatedTaskUUID` not handled

**Step 3: Add `associatedTaskUUID` handling to upload-transcript endpoint**

In `api/src/index.ts:188-227`, modify the endpoint to accept and process `associatedTaskUUID`:

```typescript
app.post("/api/internal/upload-transcript", async (c) => {
  const key = c.req.header("X-Internal-Key");
  if (!key || !timingSafeEqual(key, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const body = await c.req.json<{
    taskUUID: string;
    r2Key: string;
    transcript: string;
    associatedTaskUUID?: string;  // NEW: also update this task's transcript_r2_key
  }>();
  const { taskUUID, r2Key, transcript, associatedTaskUUID } = body;

  if (!taskUUID) {
    return c.json({ error: "Missing taskUUID" }, 400);
  }

  try {
    // Upload to R2
    await c.env.TRANSCRIPTS.put(r2Key, transcript, {
      httpMetadata: { contentType: "application/x-ndjson" },
      customMetadata: { taskUUID, uploadedAt: new Date().toISOString() },
    });

    // Update container's task record with R2 key
    const conductor = getConductor(c.env);
    await conductor.fetch(new Request("http://internal/ticket/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ taskUUID, transcript_r2_key: r2Key }),
    }));

    // Also update the associated task record (for ProjectLead inline tasks)
    if (associatedTaskUUID && associatedTaskUUID !== taskUUID) {
      await conductor.fetch(new Request("http://internal/ticket/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ taskUUID: associatedTaskUUID, transcript_r2_key: r2Key }),
      }));
      console.log(`[Worker] Transcript also associated with task=${associatedTaskUUID}`);
    }

    console.log(`[Worker] Transcript uploaded: ticket=${taskUUID} key=${r2Key} size=${transcript.length}`);
    return c.json({ ok: true, r2Key });
  } catch (err) {
    console.error("[Worker] Transcript upload failed:", err);
    return c.json({ error: String(err) }, 500);
  }
});
```

**Step 4: Run test to verify it passes**

Run: `cd api && bun test src/integration.test.ts -t "associatedTaskUUID"`
Expected: PASS

**Step 5: Commit**

```bash
git add api/src/index.ts api/src/integration.test.ts
git commit -m "feat: upload-transcript accepts associatedTaskUUID for ProjectLead tasks"
```

---

### Task 3: TranscriptManager supports associated task UUID

**Files:**
- Modify: `agent/src/transcripts.ts:8-13,56-107`
- Test: `agent/src/transcripts.test.ts`

**Step 1: Write the failing test**

```typescript
// In agent/src/transcripts.test.ts — add test for associatedTaskUUID
describe("upload with associatedTaskUUID", () => {
  test("includes associatedTaskUUID in upload request body", async () => {
    const fetchSpy = spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );

    const mgr = new TranscriptManager({
      ...defaultConfig,
      associatedTaskUUID: "conductor-task-99999",
    });

    // Would need a real transcript file to test upload — use a mock
    // or test the request body construction
    // ... (adapt to test infrastructure)

    fetchSpy.mockRestore();
  });
});
```

**Step 2: Run test to verify it fails**

Run: `cd agent && bun test src/transcripts.test.ts -t "associatedTaskUUID"`
Expected: FAIL — `associatedTaskUUID` not in config

**Step 3: Add `associatedTaskUUID` to TranscriptManager**

In `agent/src/transcripts.ts`:

Add to the config interface:
```typescript
export interface TranscriptManagerConfig {
  agentUuid: string;
  workerUrl: string;
  apiKey: string;
  taskUUID: string;
  associatedTaskUUID?: string;  // NEW: actual task UUID for ProjectLead inline tasks
}
```

In the `upload()` method body (line ~86-91), add `associatedTaskUUID` to the request:
```typescript
body: JSON.stringify({
  taskUUID: this.config.taskUUID,
  r2Key,
  transcript: transcriptContent,
  associatedTaskUUID: this.config.associatedTaskUUID,  // NEW
}),
```

Add a setter so the server can update it when events arrive:
```typescript
setAssociatedTaskUUID(uuid: string): void {
  this.config = { ...this.config, associatedTaskUUID: uuid };
}
```

**Step 4: Run test to verify it passes**

Run: `cd agent && bun test src/transcripts.test.ts -t "associatedTaskUUID"`
Expected: PASS

**Step 5: Commit**

```bash
git add agent/src/transcripts.ts agent/src/transcripts.test.ts
git commit -m "feat: TranscriptManager passes associatedTaskUUID on upload"
```

---

### Task 4: Server sets `associatedTaskUUID` from event payload

**Files:**
- Modify: `agent/src/server.ts:329-400`

**Step 1: In server.ts `/event` handler, set the associated task UUID**

After the event is received and before starting/continuing the session, update the TranscriptManager:

```typescript
// In the /event handler, after line 336:
// Set the associated task UUID so transcript uploads are linked to the actual task
if (event.taskUUID && event.taskUUID !== config.taskUUID) {
  transcriptMgr.setAssociatedTaskUUID(event.taskUUID);
}
```

This means: when a ProjectLead (whose `config.taskUUID` is `"project-lead-{product}"`) receives an event for task `"conductor-task-12345"`, all subsequent transcript uploads will also update that task's record.

**Step 2: Verify manually (no unit test — integration behavior)**

The server.ts file is hard to unit test due to module-level initialization. This will be covered by the integration test in Task 6.

**Step 3: Commit**

```bash
git add agent/src/server.ts
git commit -m "feat: server sets associatedTaskUUID from event for ProjectLead transcript linking"
```

---

### Task 5: ProjectLead uploads transcript + session_id on session end

**Files:**
- Modify: `agent/src/lifecycle.ts:199-229`
- Test: `agent/src/lifecycle.test.ts`

**Step 1: Write the failing test**

```typescript
// In agent/src/lifecycle.test.ts, inside the handleSessionEnd describe block
test("project lead: uploads transcript and reports session_id before resetting", async () => {
  const transcriptMgr = makeTranscriptMgr();
  const { lifecycle, tokenTracker, callbacks } = createLifecycle({
    roleConfig: makeProjectLeadRole(),
    transcriptMgr,
  });

  lifecycle.state.sessionActive = true;
  lifecycle.state.sessionStatus = "running";
  lifecycle.state.sessionMessageCount = 10;
  lifecycle.state.currentSessionId = "sess-abc-123";

  await lifecycle.handleSessionEnd();

  // Transcript uploaded with force=true
  expect(transcriptMgr.upload).toHaveBeenCalledWith(true);

  // session_id reported to orchestrator
  const statusCalls = fetchCalls.filter((c) =>
    c.url.includes("/api/internal/status") && c.init.body?.toString().includes("session_id"),
  );
  expect(statusCalls.length).toBe(1);
  const body = JSON.parse(statusCalls[0].init.body as string);
  expect(body.session_id).toBe("sess-abc-123");
  expect(body.taskUUID).toBe("test-uuid");

  // Session was reset (persistent agent stays alive)
  expect(lifecycle.state.sessionStatus as string).toBe("idle");
  expect(callbacks.onExit).not.toHaveBeenCalled();
});
```

**Step 2: Run test to verify it fails**

Run: `cd agent && bun test src/lifecycle.test.ts -t "uploads transcript and reports session_id"`
Expected: FAIL — persistent agent path doesn't upload transcript or report session_id

**Step 3: Add transcript upload + session_id save to persistent agent path**

In `agent/src/lifecycle.ts:199-229`, modify the persistent agent branch of `handleSessionEnd()`:

```typescript
async handleSessionEnd(): Promise<void> {
  console.log("[Agent] Session ended normally");
  this.state.sessionStatus = "completed";
  this.state.sessionActive = false;
  this.phoneHome(`session_completed msgs=${this.state.sessionMessageCount}`);

  if (this.roleConfig.persistAfterSession) {
    // Upload transcript so it's available for session resume on thread reply
    try {
      await this.transcriptMgr.upload(true);
    } catch (err) {
      console.error("[Agent] Failed to upload transcript during session end:", err);
    }

    // Report session_id to orchestrator so thread replies can resume
    if (this.state.currentSessionId) {
      try {
        await fetch(`${this.config.workerUrl}/api/internal/status`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-Internal-Key": this.config.apiKey,
          },
          body: JSON.stringify({
            taskUUID: this.config.taskUUID,
            session_id: this.state.currentSessionId,
          }),
        });
      } catch (err) {
        console.error("[Agent] Failed to save session_id:", err);
      }
    }

    // Report token usage
    await this.tokenTracker.report({
      taskUUID: this.config.taskUUID,
      workerUrl: this.config.workerUrl,
      apiKey: this.config.apiKey,
      slackBotToken: this.config.slackBotToken,
      slackChannel: this.config.slackChannel,
      slackThreadTs: this.config.slackThreadTs,
      sessionMessageCount: this.state.sessionMessageCount,
      model: this.config.model,
    });

    console.log("[Agent] Persistent session completed — staying alive for next event");
    this.resetSession();
  } else {
    console.log("[Agent] Session completed — auto-suspending for potential resume");
    this.stopTimers();
    this.autoSuspend("session_completed").catch((err) => {
      console.error("[Agent] autoSuspend failed after session end:", err);
      this.callbacks.onExit(0);
    });
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd agent && bun test src/lifecycle.test.ts -t "uploads transcript and reports session_id"`
Expected: PASS

**Step 5: Run all lifecycle tests**

Run: `cd agent && bun test src/lifecycle.test.ts`
Expected: All pass (existing project lead test needs updating since it now expects transcript upload)

**Step 6: Fix existing project lead test**

The existing test at line ~280 ("project lead: resets session state") will need updating — it now expects `transcriptMgr.upload` to be called. Update it to use a mock TranscriptManager and assert the upload.

**Step 7: Commit**

```bash
git add agent/src/lifecycle.ts agent/src/lifecycle.test.ts
git commit -m "feat: ProjectLead uploads transcript and saves session_id on session end"
```

---

### Task 6: End-to-end integration test

**Files:**
- Test: `api/src/project-lead.test.ts` or new test file

**Step 1: Write integration test for the full flow**

```typescript
describe("ProjectLead inline task transcript flow", () => {
  test("transcript upload with associatedTaskUUID updates the task record", async () => {
    // 1. Create a task in the DB (simulating conductor creating it)
    // 2. POST to /api/internal/upload-transcript with:
    //    - taskUUID: "project-lead-myproduct"
    //    - associatedTaskUUID: "conductor-task-12345"
    //    - r2Key and transcript content
    // 3. Verify the task record "conductor-task-12345" has transcript_r2_key set
    // 4. Simulate a thread reply: verify the event includes resumeTranscriptR2Key
  });
});
```

**Step 2: Run test**

Run: `cd api && bun test src/project-lead.test.ts -t "transcript upload"`
Expected: PASS

**Step 3: Commit**

```bash
git add api/src/project-lead.test.ts
git commit -m "test: integration test for ProjectLead transcript linking"
```

---

### Task 7: Run full test suite and verify

**Step 1: Run all agent tests**

Run: `cd agent && bun test`
Expected: All pass

**Step 2: Run all API tests**

Run: `cd api && bun test`
Expected: All pass

**Step 3: Commit any test fixes**

```bash
git add -A
git commit -m "fix: test adjustments for ProjectLead transcript saving"
```

---

### Task 8: Update ProjectLead prompt guidance

**Files:**
- Modify: `agent/src/prompts/task-project-lead.mustache`

**Step 1: Update the prompt to guide task delegation**

Add guidance about when to use `spawn_task` with research mode vs handling inline:

```
## Task Handling

For tasks that arrive in your channel:
- **Simple questions, quick lookups, brief research** → Handle directly. Your session transcript is saved automatically for follow-up replies.
- **Resource-intensive research or coding tasks** → Use `spawn_task` with `mode: "research"` or `mode: "coding"` as appropriate. Research mode doesn't require repos.
- **Any task needing repos, tests, CI, or PRs** → Use `spawn_task` with `mode: "coding"`.
```

**Step 2: Commit**

```bash
git add agent/src/prompts/task-project-lead.mustache
git commit -m "docs: update ProjectLead prompt with research mode guidance"
```
