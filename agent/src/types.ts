export interface TicketEvent {
  type: string;
  source: string;
  ticketId: string;
  product: string;
  payload: unknown;
  slackThreadTs?: string;
  slackChannel?: string;
}
