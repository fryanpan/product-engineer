import { describe, test, expect, beforeEach } from "bun:test";
import { ScenarioMock } from "./scenario-mock";

describe("ScenarioMock", () => {
  let mock: ScenarioMock;

  beforeEach(() => {
    mock = new ScenarioMock();
  });

  describe("success scenario", () => {
    test("returns 200 with default body", async () => {
      mock.setScenario("success");
      const res = await mock.fetch("/test");
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true });
    });

    test("returns configurable status code", async () => {
      mock.setScenario("success", { status: 201 });
      const res = await mock.fetch("/test");
      expect(res.status).toBe(201);
    });

    test("returns configurable body", async () => {
      mock.setScenario("success", { body: { result: "done" } });
      const res = await mock.fetch("/test");
      expect(await res.json()).toEqual({ result: "done" });
    });
  });

  describe("coldstart scenario", () => {
    test("returns 503 N times then 200", async () => {
      mock.setScenario("coldstart", { failCount: 2 });

      const r1 = await mock.fetch("/init");
      expect(r1.status).toBe(503);

      const r2 = await mock.fetch("/init");
      expect(r2.status).toBe(503);

      const r3 = await mock.fetch("/init");
      expect(r3.status).toBe(200);

      // Subsequent calls also succeed
      const r4 = await mock.fetch("/init");
      expect(r4.status).toBe(200);
    });
  });

  describe("crash scenario", () => {
    test("always returns 500", async () => {
      mock.setScenario("crash");

      const r1 = await mock.fetch("/test");
      expect(r1.status).toBe(500);

      const r2 = await mock.fetch("/test");
      expect(r2.status).toBe(500);

      const r3 = await mock.fetch("/test");
      expect(r3.status).toBe(500);
    });
  });

  describe("timeout scenario", () => {
    test("never resolves (rejects with timeout error)", async () => {
      mock.setScenario("timeout");

      // The timeout scenario should reject, simulating a network timeout
      await expect(mock.fetch("/test")).rejects.toThrow("timeout");
    });
  });

  describe("request tracking", () => {
    test("tracks request counts per path", async () => {
      mock.setScenario("success");

      await mock.fetch("/initialize");
      await mock.fetch("/initialize");
      await mock.fetch("/event");

      expect(mock.getRequestCount("/initialize")).toBe(2);
      expect(mock.getRequestCount("/event")).toBe(1);
      expect(mock.getRequestCount("/unknown")).toBe(0);
    });

    test("captures request bodies per path", async () => {
      mock.setScenario("success");

      await mock.fetch("/event", {
        method: "POST",
        body: JSON.stringify({ type: "ticket_created" }),
      });
      await mock.fetch("/event", {
        method: "POST",
        body: JSON.stringify({ type: "pr_review" }),
      });

      const bodies = mock.getCapturedBodies("/event");
      expect(bodies).toHaveLength(2);
      expect(bodies[0]).toEqual({ type: "ticket_created" });
      expect(bodies[1]).toEqual({ type: "pr_review" });
    });

    test("returns empty array for uncaptured paths", () => {
      expect(mock.getCapturedBodies("/nope")).toEqual([]);
    });
  });

  describe("reset", () => {
    test("clears request counts and captured bodies", async () => {
      mock.setScenario("success");

      await mock.fetch("/test");
      await mock.fetch("/test", { method: "POST", body: JSON.stringify({ x: 1 }) });

      expect(mock.getRequestCount("/test")).toBe(2);
      expect(mock.getCapturedBodies("/test")).toHaveLength(1);

      mock.reset();

      expect(mock.getRequestCount("/test")).toBe(0);
      expect(mock.getCapturedBodies("/test")).toEqual([]);
    });

    test("resets coldstart failure counter", async () => {
      mock.setScenario("coldstart", { failCount: 1 });

      const r1 = await mock.fetch("/test");
      expect(r1.status).toBe(503);

      mock.reset();

      // After reset, coldstart counter restarts
      const r2 = await mock.fetch("/test");
      expect(r2.status).toBe(503);

      const r3 = await mock.fetch("/test");
      expect(r3.status).toBe(200);
    });
  });
});
