/**
 * TranscriptManager — manages discovery and upload of Claude Agent SDK
 * transcript .jsonl files to the orchestrator's R2 storage.
 *
 * Extracted from server.ts to keep the main server focused on HTTP/session logic.
 */

import { readFile, stat } from "node:fs/promises";

export interface TranscriptManagerConfig {
  agentUuid: string;
  workerUrl: string;
  apiKey: string;
  taskUUID: string;
  associatedTaskUUID?: string;
}

export class TranscriptManager {
  private config: TranscriptManagerConfig;
  private uploadedSizes = new Map<string, number>();

  constructor(config: TranscriptManagerConfig) {
    this.config = config;
  }

  /** Returns the Claude projects transcript directory for the current working directory. */
  getTranscriptDir(): string {
    const home = process.env.HOME || "/home/agent";
    const cwd = process.cwd().replace(/\//g, "-");
    return `${home}/.claude/projects/${cwd}`;
  }

  /** Find all transcript .jsonl files in the transcript directory. */
  async findAllTranscripts(): Promise<string[]> {
    try {
      const sessionDir = this.getTranscriptDir();

      const proc = Bun.spawn(["ls", "-1", sessionDir]);
      const output = await new Response(proc.stdout).text();
      const exitCode = await proc.exited;

      if (exitCode !== 0) return [];

      return output
        .trim()
        .split("\n")
        .filter(f => f.endsWith(".jsonl"))
        .map(f => `${sessionDir}/${f}`);
    } catch {
      return [];
    }
  }

  /**
   * Upload all transcript files to R2 via the worker.
   * Each file gets a stable key: {agentUuid}-{filename} so it's uploaded once per change.
   * @param force - If true, upload even if size hasn't changed (e.g., session end / shutdown)
   */
  async upload(force = false): Promise<void> {
    try {
      const files = await this.findAllTranscripts();
      if (files.length === 0) {
        console.log("[Agent] No transcript files found to upload");
        return;
      }

      for (const path of files) {
        try {
          // Use node:fs instead of Bun.file() — Bun.file().text() uses
          // globalThis.fetch internally, which breaks if fetch is mocked in tests.
          const transcriptContent = await readFile(path, "utf-8");
          const currentSize = transcriptContent.length;
          const prevSize = this.uploadedSizes.get(path) ?? 0;

          // Skip if unchanged (unless forced, e.g., session end / shutdown)
          if (!force && currentSize === prevSize) continue;

          const basename = path.split("/").pop()!;
          const r2Key = `${this.config.agentUuid}-${basename}`;

          console.log(`[Agent] Uploading transcript ${basename} (${currentSize} bytes, was ${prevSize})...`);
          this.uploadedSizes.set(path, currentSize);

          const uploadRes = await fetch(`${this.config.workerUrl}/api/internal/upload-transcript`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Key": this.config.apiKey,
            },
            body: JSON.stringify({
              taskUUID: this.config.taskUUID,
              r2Key,
              transcript: transcriptContent,
              associatedTaskUUID: this.config.associatedTaskUUID,
            }),
          });

          if (!uploadRes.ok) {
            const errorText = await uploadRes.text();
            console.error(`[Agent] Transcript upload failed for ${basename}: ${uploadRes.status} — ${errorText}`);
            continue;
          }

          console.log(`[Agent] Transcript uploaded: ${r2Key}`);
        } catch (fileErr) {
          console.error(`[Agent] Error uploading ${path}:`, fileErr);
        }
      }
    } catch (err) {
      console.error("[Agent] Transcript upload error:", err);
    }
  }

  /**
   * Download a transcript from R2 and write it to the local transcript directory.
   * This enables session resumption — the SDK reads transcripts from the local path.
   * @param r2Key - The R2 key of the transcript (e.g., "{agentUuid}-{sessionId}.jsonl")
   */
  async download(r2Key: string): Promise<string | null> {
    try {
      const transcriptDir = this.getTranscriptDir();

      // Ensure the directory exists
      const mkdirProc = Bun.spawn(["mkdir", "-p", transcriptDir]);
      await mkdirProc.exited;

      // Fetch transcript from R2 via worker API
      const res = await fetch(`${this.config.workerUrl}/api/transcripts/${encodeURIComponent(r2Key)}`, {
        headers: { "X-API-Key": this.config.apiKey },
      });

      if (!res.ok) {
        console.error(`[Agent] Transcript download failed: ${res.status}`);
        return null;
      }

      const content = await res.text();

      // Extract session ID from the transcript content (first line has sessionId field)
      // Or from the R2 key: format is "{agentUuid}-{sessionId}.jsonl"
      const firstLine = content.split("\n")[0];
      let sessionId: string | null = null;
      try {
        const parsed = JSON.parse(firstLine);
        sessionId = parsed.sessionId || null;
      } catch {
        // Try extracting from r2Key format: "{agentUuid}-{sessionId}.jsonl"
        // Both agentUuid and sessionId are UUIDs with hyphens, so split on the
        // last occurrence of a UUID pattern followed by .jsonl
        const basename = r2Key.replace(/\.jsonl$/, "");
        // The sessionId is the last UUID in the key (after the agentUuid prefix)
        const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;
        const uuids = basename.match(uuidPattern);
        sessionId = uuids && uuids.length >= 2 ? uuids[uuids.length - 1] : null;
      }

      if (!sessionId) {
        console.error("[Agent] Could not determine session ID from transcript");
        return null;
      }

      // Write to the expected path: {transcriptDir}/{sessionId}.jsonl
      const localPath = `${transcriptDir}/${sessionId}.jsonl`;
      await Bun.write(localPath, content);
      console.log(`[Agent] Transcript downloaded: ${r2Key} → ${localPath} (${content.length} bytes)`);

      return sessionId;
    } catch (err) {
      console.error("[Agent] Transcript download error:", err);
      return null;
    }
  }

  /** Set the associated task UUID (e.g., when a project lead receives an event for a child task). */
  setAssociatedTaskUUID(uuid: string): void {
    this.config.associatedTaskUUID = uuid;
  }

  /** Returns the current uploaded sizes map (for testing/debugging). */
  getUploadedSizes(): Map<string, number> {
    return this.uploadedSizes;
  }
}
