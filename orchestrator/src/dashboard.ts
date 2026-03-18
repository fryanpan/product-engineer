import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import type { Bindings } from "./types";
import { dashboardHTML } from "./dashboard-html";

interface GoogleOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  allowedDomain?: string; // Optional: restrict to specific domain (e.g., "anthropic.com")
}

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  id_token: string;
}

interface GoogleUserInfo {
  email: string;
  verified_email: boolean;
  name: string;
  picture: string;
  hd?: string; // Hosted domain (for G Suite accounts)
}

// Session management
interface Session {
  email: string;
  name: string;
  picture: string;
  expiresAt: number;
}

const SESSIONS = new Map<string, Session>();
const SESSION_DURATION = 24 * 60 * 60 * 1000; // 24 hours

function generateSessionId(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, b => b.toString(16).padStart(2, '0')).join('');
}

function createSession(userInfo: GoogleUserInfo): string {
  const sessionId = generateSessionId();
  SESSIONS.set(sessionId, {
    email: userInfo.email,
    name: userInfo.name,
    picture: userInfo.picture,
    expiresAt: Date.now() + SESSION_DURATION,
  });
  return sessionId;
}

function getSession(sessionId: string): Session | null {
  const session = SESSIONS.get(sessionId);
  if (!session) return null;
  if (session.expiresAt < Date.now()) {
    SESSIONS.delete(sessionId);
    return null;
  }
  return session;
}

function deleteSession(sessionId: string): void {
  SESSIONS.delete(sessionId);
}

// OAuth helpers
function getOAuthConfig(env: Bindings): GoogleOAuthConfig {
  return {
    clientId: (env.GOOGLE_CLIENT_ID as string) || "",
    clientSecret: (env.GOOGLE_CLIENT_SECRET as string) || "",
    redirectUri: `${env.WORKER_URL}/dashboard/callback`,
    allowedDomain: (env.GOOGLE_ALLOWED_DOMAIN as string) || undefined,
  };
}

async function exchangeCodeForToken(
  code: string,
  config: GoogleOAuthConfig
): Promise<GoogleTokenResponse> {
  const response = await fetch("https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.clientId,
      client_secret: config.clientSecret,
      redirect_uri: config.redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new Error(`OAuth token exchange failed: ${response.statusText}`);
  }

  return response.json();
}

async function getUserInfo(accessToken: string): Promise<GoogleUserInfo> {
  const response = await fetch("https://www.googleapis.com/oauth2/v2/userinfo", {
    headers: { Authorization: `Bearer ${accessToken}` },
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch user info: ${response.statusText}`);
  }

  return response.json();
}

// Extend Hono context with session
type DashboardContext = {
  Bindings: Bindings;
  Variables: {
    session: Session;
  };
};

// Middleware
function requireAuth() {
  return async (c: any, next: () => Promise<void>) => {
    const sessionId = getCookie(c, "session_id");
    if (!sessionId) {
      return c.redirect("/dashboard/login");
    }

    const session = getSession(sessionId);
    if (!session) {
      deleteCookie(c, "session_id");
      return c.redirect("/dashboard/login");
    }

    c.set("session", session);
    await next();
  };
}

// Dashboard router
export const dashboardRouter = new Hono<DashboardContext>();

// Login page - initiate OAuth flow
dashboardRouter.get("/login", async (c) => {
  const config = getOAuthConfig(c.env);

  if (!config.clientId || !config.clientSecret) {
    return c.html(`
      <html>
        <body style="font-family: sans-serif; padding: 40px; max-width: 600px; margin: 0 auto;">
          <h1>Configuration Error</h1>
          <p>Google OAuth is not configured. Please set the following secrets:</p>
          <ul>
            <li>GOOGLE_CLIENT_ID</li>
            <li>GOOGLE_CLIENT_SECRET</li>
            <li>GOOGLE_ALLOWED_DOMAIN (optional - restricts access to specific domain)</li>
          </ul>
          <p>Run: <code>wrangler secret put GOOGLE_CLIENT_ID</code></p>
        </body>
      </html>
    `);
  }

  const authUrl = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  authUrl.searchParams.set("client_id", config.clientId);
  authUrl.searchParams.set("redirect_uri", config.redirectUri);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("scope", "openid email profile");

  if (config.allowedDomain) {
    authUrl.searchParams.set("hd", config.allowedDomain);
  }

  return c.redirect(authUrl.toString());
});

// OAuth callback
dashboardRouter.get("/callback", async (c) => {
  const code = c.req.query("code");
  if (!code) {
    return c.html("<html><body>Error: No authorization code received</body></html>");
  }

  try {
    const config = getOAuthConfig(c.env);
    const tokenResponse = await exchangeCodeForToken(code, config);
    const userInfo = await getUserInfo(tokenResponse.access_token);

    // Check domain restriction if configured
    if (config.allowedDomain && userInfo.hd !== config.allowedDomain) {
      return c.html(`
        <html>
          <body style="font-family: sans-serif; padding: 40px; max-width: 600px; margin: 0 auto;">
            <h1>Access Denied</h1>
            <p>Only users from ${config.allowedDomain} are allowed to access this dashboard.</p>
            <p>Your email: ${userInfo.email}</p>
            <a href="/dashboard/login">Try again</a>
          </body>
        </html>
      `);
    }

    const sessionId = createSession(userInfo);
    setCookie(c, "session_id", sessionId, {
      httpOnly: true,
      secure: true,
      sameSite: "Lax",
      maxAge: SESSION_DURATION / 1000,
      path: "/",
    });

    return c.redirect("/dashboard");
  } catch (error) {
    console.error("OAuth callback error:", error);
    return c.html(`
      <html>
        <body style="font-family: sans-serif; padding: 40px; max-width: 600px; margin: 0 auto;">
          <h1>Authentication Error</h1>
          <p>${error instanceof Error ? error.message : "Unknown error"}</p>
          <a href="/dashboard/login">Try again</a>
        </body>
      </html>
    `);
  }
});

// Logout
dashboardRouter.get("/logout", async (c) => {
  const sessionId = getCookie(c, "session_id");
  if (sessionId) {
    deleteSession(sessionId);
  }
  deleteCookie(c, "session_id");
  return c.redirect("/dashboard/login");
});

// Dashboard home (protected)
dashboardRouter.get("/", requireAuth(), async (c) => {
  return c.html(dashboardHTML);
});

// Get current user info (protected)
dashboardRouter.get("/user", requireAuth(), async (c) => {
  const session = c.get("session") as Session;
  return c.json({
    email: session.email,
    name: session.name,
    picture: session.picture,
  });
});

// List all active agents (protected)
dashboardRouter.get("/api/agents", requireAuth(), async (c) => {
  try {
    const orchestratorId = c.env.ORCHESTRATOR.idFromName("main");
    const orchestrator = c.env.ORCHESTRATOR.get(orchestratorId);
    const res = await orchestrator.fetch(new Request("http://internal/tickets"));

    if (!res.ok) {
      return c.json({ error: "Failed to fetch tickets" }, 500);
    }

    const data = await res.json() as { tickets: any[] };

    // Filter to active agents only (agent_active = 1)
    const activeAgents = data.tickets
      .filter((t: any) => t.agent_active === 1)
      .map((t: any) => ({
        id: t.ticket_id || t.ticket_uuid,
        product: t.product,
        status: t.status,
        slack_thread_ts: t.slack_thread_ts,
        slack_channel: t.slack_channel,
        pr_url: t.pr_url,
        updated_at: t.updated_at,
        last_heartbeat: t.last_heartbeat,
      }));

    return c.json({ agents: activeAgents });
  } catch (error) {
    console.error("[Dashboard] Failed to list agents:", error);
    return c.json({ error: String(error) }, 500);
  }
});

// Get metrics summary (protected)
dashboardRouter.get("/api/metrics", requireAuth(), async (c) => {
  try {
    const orchestratorId = c.env.ORCHESTRATOR.idFromName("main");
    const orchestrator = c.env.ORCHESTRATOR.get(orchestratorId);
    const res = await orchestrator.fetch(new Request("http://internal/tickets"));

    if (!res.ok) {
      return c.json({ error: "Failed to fetch metrics" }, 500);
    }

    const data = await res.json() as { tickets: any[] };
    const tickets = data.tickets;

    // Calculate metrics
    const totalTickets = tickets.length;
    const merged = tickets.filter((t: any) => t.status === "merged").length;
    const failed = tickets.filter((t: any) => t.status === "failed").length;
    const automergeRate = totalTickets > 0 ? `${Math.round((merged / totalTickets) * 100)}%` : "0%";
    const failureRate = totalTickets > 0 ? `${Math.round((failed / totalTickets) * 100)}%` : "0%";

    // TODO: Add cost and decision accuracy metrics when available
    return c.json({
      summary: {
        totalTickets,
        automergeRate,
        failureRate,
        multiRevisionRate: "0%", // TODO: calculate from revision count
      },
      costs: {
        average: "0.00",
        daily: [],
      },
      decisions: {
        accuracy: "N/A",
        withFeedback: 0,
      },
    });
  } catch (error) {
    console.error("[Dashboard] Failed to fetch metrics:", error);
    return c.json({ error: String(error) }, 500);
  }
});

// Get recent decisions (protected)
dashboardRouter.get("/api/decisions", requireAuth(), async (c) => {
  // TODO: Implement decision log query
  return c.json([]);
});

// Submit decision feedback (protected)
dashboardRouter.post("/api/decision-feedback", requireAuth(), async (c) => {
  // TODO: Implement decision feedback storage
  return c.json({ ok: true });
});

// Kill individual agent (protected)
dashboardRouter.post("/api/agents/:ticketUUID/kill", requireAuth(), async (c) => {
  const ticketUUID = c.req.param("ticketUUID");
  const session = c.get("session") as Session;

  console.log(`[Dashboard] User ${session.email} killing agent ${ticketUUID}`);

  try {
    // Mark as inactive in orchestrator
    const orchestratorId = c.env.ORCHESTRATOR.idFromName("main");
    const orchestrator = c.env.ORCHESTRATOR.get(orchestratorId);
    await orchestrator.fetch(new Request("http://internal/ticket/status", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        ticketUUID: ticketUUID,
        status: "deferred",
      }),
    }));

    return c.json({ ok: true });
  } catch (error) {
    console.error("[Dashboard] Failed to kill agent:", error);
    return c.json({ error: String(error) }, 500);
  }
});

// Kill all active agents (protected)
dashboardRouter.post("/api/agents/shutdown-all", requireAuth(), async (c) => {
  const session = c.get("session") as Session;
  console.log(`[Dashboard] User ${session.email} requesting shutdown of all agents`);

  try {
    const orchestratorId = c.env.ORCHESTRATOR.idFromName("main");
    const orchestrator = c.env.ORCHESTRATOR.get(orchestratorId);

    // Get all active tickets
    const res = await orchestrator.fetch(new Request("http://internal/tickets"));
    const data = await res.json() as { tickets: any[] };
    const activeTickets = data.tickets.filter((t: any) => t.agent_active === 1);

    // Kill each one
    for (const ticket of activeTickets) {
      await orchestrator.fetch(new Request("http://internal/ticket/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ticketUUID: ticket.ticket_uuid,
          status: "deferred",
        }),
      }));
    }

    return c.json({ ok: true, total: activeTickets.length });
  } catch (error) {
    console.error("[Dashboard] Failed to shutdown all agents:", error);
    return c.json({ error: String(error) }, 500);
  }
});

export function timingSafeEqual(a: string, b: string): boolean {
  const encoder = new TextEncoder();
  const bufA = encoder.encode(a);
  const bufB = encoder.encode(b);
  if (bufA.byteLength !== bufB.byteLength) return false;
  return (crypto.subtle as unknown as { timingSafeEqual(a: BufferSource, b: BufferSource): boolean }).timingSafeEqual(bufA, bufB);
}

// Override API_KEY check for dashboard routes
dashboardRouter.use("/api/*", async (c, next) => {
  const apiKey = c.req.header("X-API-Key");
  const sessionId = getCookie(c, "session_id");

  // Allow if either:
  // 1. Valid API key is provided
  // 2. Valid session exists and using dashboard special key
  if (apiKey === "dashboard" && sessionId && getSession(sessionId)) {
    // Inject real API key for internal requests
    c.req.raw.headers.set("X-API-Key", c.env.API_KEY);
  } else if (!apiKey || !timingSafeEqual(apiKey, c.env.API_KEY)) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  await next();
});
