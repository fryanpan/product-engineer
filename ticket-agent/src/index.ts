/**
 * TicketAgent Worker — Minimal stub exporting the TicketAgent DO class.
 *
 * This worker exists solely to isolate TicketAgent DOs from Orchestrator deployments.
 * Deploying the orchestrator worker won't reset TicketAgent DOs, enabling zero-downtime.
 *
 * The TicketAgent class is defined in orchestrator/src/ticket-agent.ts and referenced here.
 */

export { TicketAgent } from "../../orchestrator/src/ticket-agent";

export default {
  async fetch(request: Request): Promise<Response> {
    return new Response(
      JSON.stringify({
        error: "This worker only exports the TicketAgent DO. Access it via the orchestrator worker.",
      }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      },
    );
  },
};
