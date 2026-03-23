/**
 * TranscriptManager — manages discovery and upload of Claude Agent SDK
 * transcript .jsonl files to the orchestrator's R2 storage.
 *
 * Extracted from server.ts to keep the main server focused on HTTP/session logic.
 */

export interface TranscriptManagerConfig {
  agentUuid: string;
  workerUrl: string;
  apiKey: string;
  ticketUUID: string;
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
          const file = Bun.file(path);
          const currentSize = file.size;
          const prevSize = this.uploadedSizes.get(path) ?? 0;

          // Skip if unchanged (unless forced, e.g., session end / shutdown)
          if (!force && currentSize === prevSize) continue;

          const basename = path.split("/").pop()!;
          const r2Key = `${this.config.agentUuid}-${basename}`;

          console.log(`[Agent] Uploading transcript ${basename} (${currentSize} bytes, was ${prevSize})...`);
          const transcriptContent = await file.text();
          this.uploadedSizes.set(path, currentSize);

          const uploadRes = await fetch(`${this.config.workerUrl}/api/internal/upload-transcript`, {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              "X-Internal-Key": this.config.apiKey,
            },
            body: JSON.stringify({
              ticketUUID: this.config.ticketUUID,
              r2Key,
              transcript: transcriptContent,
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

  /** Returns the current uploaded sizes map (for testing/debugging). */
  getUploadedSizes(): Map<string, number> {
    return this.uploadedSizes;
  }
}
