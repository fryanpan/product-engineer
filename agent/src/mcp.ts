/**
 * Build MCP server configs from environment variables.
 *
 * Each external service is included only when its required env var is present.
 * The one exception is Context7, which works without a key (lower rate limits).
 *
 * Types mirror McpHttpServerConfig/McpStdioServerConfig from the Agent SDK
 * (defined in coreTypes.d.ts but not re-exported from the public API).
 */

type McpHttpServerConfig = {
  type: "http";
  url: string;
  headers?: Record<string, string>;
};

type McpStdioServerConfig = {
  type?: "stdio";
  command: string;
  args?: string[];
  env?: Record<string, string>;
};

type McpServerConfig = McpHttpServerConfig | McpStdioServerConfig;

export function buildMcpServers(): Record<string, McpServerConfig> {
  const servers: Record<string, McpServerConfig> = {};

  // Linear — HTTP remote with Bearer auth
  const linearKey = process.env.LINEAR_APP_TOKEN;
  if (linearKey) {
    servers.linear = {
      type: "http",
      url: "https://mcp.linear.app/mcp",
      headers: { Authorization: `Bearer ${linearKey}` },
    };
  }

  // Context7 — always included, optional API key for higher rate limits
  const context7: McpHttpServerConfig = {
    type: "http",
    url: "https://mcp.context7.com/mcp",
  };
  const context7Key = process.env.CONTEXT7_API_KEY;
  if (context7Key) {
    context7.headers = { CONTEXT7_API_KEY: context7Key };
  }
  servers.context7 = context7;

  // Notion — pre-installed binary, activated when NOTION_TOKEN is set
  // @notionhq/notion-mcp-server is installed globally in the Dockerfile
  const notionToken = process.env.NOTION_TOKEN;
  if (notionToken) {
    servers.notion = {
      command: "notion-mcp-server",
      env: {
        OPENAPI_MCP_HEADERS: JSON.stringify({
          Authorization: `Bearer ${notionToken}`,
          "Notion-Version": "2022-06-28",
        }),
      },
    };
  }

  // Google Calendar — pre-installed binary, activated when GOOGLE_CALENDAR_CREDENTIALS is set
  // google-calendar-mcp is installed globally in the Dockerfile
  // server.ts writes the JSON credentials to /tmp/google-calendar-credentials.json at startup
  const gcalCreds = process.env.GOOGLE_CALENDAR_CREDENTIALS;
  if (gcalCreds) {
    servers.google_calendar = {
      command: "google-calendar-mcp",
      env: { GOOGLE_CALENDAR_CREDENTIALS_PATH: "/tmp/google-calendar-credentials.json" },
    };
  }

  // Sentry — stdio via npx (disabled: npx download can hang in containers)
  // TODO: Re-enable once we pre-install MCP server packages in the Dockerfile
  // const sentryToken = process.env.SENTRY_ACCESS_TOKEN;
  // if (sentryToken) {
  //   servers.sentry = {
  //     command: "npx",
  //     args: ["-y", "@sentry/mcp-server@latest"],
  //     env: {
  //       SENTRY_AUTH_TOKEN: sentryToken,
  //       EMBEDDED_AGENT_PROVIDER: "anthropic",
  //       ...(process.env.ANTHROPIC_API_KEY
  //         ? { ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY }
  //         : {}),
  //     },
  //   };
  // }

  return servers;
}
