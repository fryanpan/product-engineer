/**
 * Type declarations for Cloudflare Sandbox (Containers) SDK.
 * This module is available at runtime in Cloudflare Workers with container bindings.
 */
declare module "@cloudflare/sandbox" {
  interface SandboxOptions {
    sleepAfter?: string;
  }

  interface ExecOptions {
    cwd?: string;
    timeout?: number;
    env?: Record<string, string>;
  }

  interface ExecResult {
    success: boolean;
    exitCode: number;
    stdout: string;
    stderr: string;
  }

  interface Sandbox {
    writeFile(path: string, content: string): Promise<void>;
    exec(command: string, options?: ExecOptions): Promise<ExecResult>;
    destroy(): Promise<void>;
  }

  export function getSandbox(
    namespace: DurableObjectNamespace,
    id: string,
    options?: SandboxOptions,
  ): Sandbox;
}
