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

  // Notion — stdio via npx (disabled: npx download can hang in containers)
  // TODO: Re-enable once we pre-install MCP server packages in the Dockerfile
  // const notionToken = process.env.NOTION_TOKEN;
  // if (notionToken) {
  //   servers.notion = {
  //     command: "npx",
  //     args: ["-y", "@notionhq/notion-mcp-server"],
  //     env: { NOTION_TOKEN: notionToken },
  //   };
  // }

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
