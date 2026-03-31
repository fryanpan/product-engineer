# Thread Reply Context Loss — Design

**Date**: 2026-03-27
**Branch**: `docs/retro-thread-reply-fix`
**Problem**: When a user replies in a Slack thread after the agent has completed a task, the respawned agent has no conversation context and can't answer follow-up questions.

## Root Cause

Two independent failures combine:

1. **`spawn_task` doesn't support research mode** — The tool hardcodes `mode: "coding"` and requires a full product config with repos. When spawning fails (e.g., missing product config for a research-only task), the ProjectLead falls back to handling the task inline.

2. **ProjectLead doesn't save transcripts** — When the ProjectLead handles a task inline, `handleSessionEnd()` for persistent agents reports tokens and calls `resetSession()` but never uploads the transcript or saves `session_id`/`transcript_r2_key` to the task record. When the user replies later and the system respawns an agent, there's no transcript to resume from.

## Approaches Considered

### SDK Subagents (rejected)
The Agent SDK supports subagents via the `agents` option in `query()`. However, subagents:
- Run in isolated context — parent only gets final result, no streaming
- Cannot receive injected messages (no Slack thread reply handling)
- Cannot echo intermediate tool calls to Slack (no real-time progress)
- The interactive, bidirectional UX pattern (agent works → echoes to Slack → user replies → agent adjusts) is incompatible with the subagent "fire and get result" model

### Separate TaskAgent container for research (adopted — Fix 1)
Fix `spawn_task` to support `mode: "research"` so the ProjectLead can delegate research tasks to a proper TaskAgent with full lifecycle guarantees.

### ProjectLead saves transcripts inline (adopted — Fix 2)
When the ProjectLead handles a task directly, save transcript and session_id to the task record at multiple checkpoints — not just at task completion.

## Design

### Fix 1: `spawn_task` supports research mode

**Changes:**

1. **`agent/src/tools.ts` — `spawn_task` tool definition**
   - Add optional `mode` parameter: `"coding"` | `"research"` (default: `"coding"`)
   - Pass through to the spawn-task API endpoint

2. **`api/src/project-lead-router.ts` — spawn-task handler**
   - Allow `repos: []` to pass through without error for research tasks
   - Research mode tasks don't need a GitHub token or repo access

3. **ProjectLead prompt guidance** (`agent/src/prompts/task-project-lead.mustache`)
   - Update to say: for resource-intensive or coding tasks, use `spawn_task` with `mode: "coding"`. For research tasks that need isolation, use `spawn_task` with `mode: "research"`.

### Fix 2: ProjectLead saves per-task transcript

**Problem detail:** The ProjectLead's `config.taskUUID` is `"project-lead-{product}"` (generic), not the specific task UUID. Its TranscriptManager uploads against this generic key. But the conductor DB looks up `transcript_r2_key` by the task's specific UUID.

**Solution:** When transcript is uploaded, also associate the R2 key + session_id with the current task UUID.

**Changes:**

1. **`agent/src/server.ts` — track current task UUID**
   - Add a `currentTaskUUID` variable that gets set from `event.taskUUID` when an event arrives
   - This is the actual task UUID (e.g., `conductor-task-1774608823`), not the container's generic UUID

2. **`agent/src/lifecycle.ts` — `handleSessionEnd()` for persistent agents**
   - After token reporting, upload transcript: `await this.transcriptMgr.upload(true)`
   - POST `session_id` and `transcript_r2_key` to the conductor for the current task UUID
   - This matches what `autoSuspend()` already does for ticket agents, minus the status change and exit

3. **`agent/src/lifecycle.ts` — expose method for saving task context**
   - Add `saveTaskContext(taskUUID: string)` method that:
     a. Calls `transcriptMgr.upload(true)` to push latest transcript to R2
     b. POSTs `{ taskUUID, session_id, transcript_r2_key }` to `/api/internal/status`
   - This is called from multiple save points (not just session end)

4. **Save points** — transcript is associated with the task at:
   - **Every periodic backup** (existing 60s timer) — add task UUID association
   - **On SIGTERM/SIGINT** (deploy) — already uploads transcript, add task UUID association
   - **On session end** — new: persistent agents now save transcript
   - **On task status update** — when agent calls `update_task_status` via pe-tools

5. **`api/src/index.ts` — upload-transcript endpoint**
   - Accept optional `associatedTaskUUID` field
   - When present, also update that task's `transcript_r2_key` in the DB (in addition to the container's own taskUUID)
   - This way, the same R2 object is referenced by both the container record and the task record

### Resume flow (already works, no changes needed)

When a thread reply arrives for a completed task:
1. `slack-handler.ts` reads `session_id` and `transcript_r2_key` from the task record (now populated)
2. `reopenTask()` spawns a new agent container
3. The event includes `resumeSessionId` and `resumeTranscriptR2Key`
4. `agent/server.ts` downloads the transcript and resumes the session
5. The resumed agent has full context of prior work

## Success Criteria

- [ ] `spawn_task` with `mode: "research"` successfully spawns a TaskAgent without repos
- [ ] ProjectLead handling a task inline saves `transcript_r2_key` and `session_id` to the task record
- [ ] Thread reply to a ProjectLead-handled task resumes with full conversation context
- [ ] Deploy/restart mid-task doesn't lose transcript — periodic backup keeps it current
- [ ] Existing TaskAgent transcript/resume flow is unaffected

## Edge Cases

| Scenario | Behavior |
|----------|----------|
| ProjectLead handles multiple tasks in one session | Each task gets the same transcript R2 key (full session). On resume, agent has context from all tasks — acceptable since the session is continuous. |
| Deploy mid-research task | SIGTERM handler uploads transcript + associates with task. New container resumes. |
| `spawn_task` still fails after fix | ProjectLead falls back to inline handling (same as today), but now with transcript saving. |
| Periodic backup runs but no task is active | Skip task association — only upload for the container's generic UUID. |
