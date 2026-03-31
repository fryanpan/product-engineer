/**
 * Pure helpers for resolving which transcript/session to resume from.
 * Extracted for testability — server.ts delegates to these functions.
 */

import type { TaskEvent } from "./config";
import type { TranscriptManager } from "./transcripts";

/**
 * Determine the transcript R2 key to use for resuming a session.
 *
 * Priority:
 * 1. Event-provided key (explicit suspend/reopen path via slack-handler)
 * 2. Conductor DB fallback (deploy restarts where agent_active=1, so
 *    slack-handler omits the key because needsRespawn=false)
 */
export async function resolveTranscriptKey(
  event: TaskEvent,
  workerUrl: string,
  taskUUID: string,
  apiKey: string,
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  if (event.resumeTranscriptR2Key) {
    return event.resumeTranscriptR2Key;
  }

  try {
    const res = await fetchFn(
      `${workerUrl}/api/conductor/task-status/${encodeURIComponent(taskUUID)}`,
      { headers: { "X-Internal-Key": apiKey } },
    );
    if (res.ok) {
      const taskInfo = await res.json() as { transcript_r2_key?: string };
      if (taskInfo.transcript_r2_key) {
        return taskInfo.transcript_r2_key;
      }
    }
  } catch {
    // Non-fatal — fall through and start a fresh session
  }

  return undefined;
}

/**
 * Download a transcript and return the session ID to resume with.
 * Returns undefined if download fails.
 */
export async function resolveResumeSessionId(
  transcriptKey: string,
  transcriptMgr: Pick<TranscriptManager, "download">,
): Promise<string | undefined> {
  const downloadedSessionId = await transcriptMgr.download(transcriptKey);
  // Use session ID extracted from transcript file — more reliable than DB
  // session_id which may be stale from a previous session.
  return downloadedSessionId || undefined;
}
