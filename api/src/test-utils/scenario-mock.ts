/**
 * ScenarioMock — simulates container (Durable Object) responses for testing.
 *
 * Scenarios:
 *   success   — always returns a configurable status (default 200) with configurable body
 *   coldstart — returns 503 for the first N requests, then 200
 *   crash     — always returns 500
 *   timeout   — never resolves (rejects with a timeout error)
 */

type ScenarioType = "success" | "coldstart" | "crash" | "timeout";

interface SuccessOptions {
  status?: number;
  body?: unknown;
}

interface ColdstartOptions {
  failCount?: number;
}

type ScenarioOptions = SuccessOptions & ColdstartOptions;

export class ScenarioMock {
  private scenario: ScenarioType = "success";
  private options: ScenarioOptions = {};
  private requestCounts = new Map<string, number>();
  private capturedBodies = new Map<string, unknown[]>();
  private coldstartCounter = 0;

  setScenario(scenario: ScenarioType, options: ScenarioOptions = {}): void {
    this.scenario = scenario;
    this.options = options;
    this.coldstartCounter = 0;
  }

  async fetch(path: string, init?: RequestInit): Promise<Response> {
    // Track request count
    const count = this.requestCounts.get(path) ?? 0;
    this.requestCounts.set(path, count + 1);

    // Capture body if present
    if (init?.body) {
      const bodies = this.capturedBodies.get(path) ?? [];
      try {
        bodies.push(JSON.parse(init.body as string));
      } catch {
        bodies.push(init.body);
      }
      this.capturedBodies.set(path, bodies);
    }

    // Return response based on scenario
    switch (this.scenario) {
      case "success": {
        const status = this.options.status ?? 200;
        const body = this.options.body ?? { ok: true };
        return new Response(JSON.stringify(body), { status });
      }

      case "coldstart": {
        const failCount = this.options.failCount ?? 1;
        this.coldstartCounter++;
        if (this.coldstartCounter <= failCount) {
          return new Response("Service Unavailable", { status: 503 });
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }

      case "crash": {
        return new Response("Internal Server Error", { status: 500 });
      }

      case "timeout": {
        throw new Error("timeout");
      }
    }
  }

  getRequestCount(path: string): number {
    return this.requestCounts.get(path) ?? 0;
  }

  getCapturedBodies(path: string): unknown[] {
    return this.capturedBodies.get(path) ?? [];
  }

  reset(): void {
    this.requestCounts.clear();
    this.capturedBodies.clear();
    this.coldstartCounter = 0;
  }
}
