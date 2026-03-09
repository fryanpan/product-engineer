/**
 * Google OAuth authentication for dashboard access.
 *
 * Flow:
 * 1. User visits /dashboard → redirect to /api/auth/login
 * 2. /api/auth/login → redirect to Google OAuth
 * 3. Google redirects back to /api/auth/callback with code
 * 4. Exchange code for tokens, verify user, create session
 * 5. Redirect to /dashboard with session cookie
 */

import type { Context } from "hono";
import type { Bindings } from "./types";

const GOOGLE_AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const GOOGLE_USERINFO_URL = "https://www.googleapis.com/oauth2/v2/userinfo";

interface GoogleTokenResponse {
  access_token: string;
  expires_in: number;
  token_type: string;
  scope: string;
  id_token: string;
}

interface GoogleUserInfo {
  id: string;
  email: string;
  verified_email: boolean;
  name: string;
  picture: string;
}

interface Session {
  email: string;
  name: string;
  picture: string;
  createdAt: number;
}

/**
 * Generate a cryptographically secure random session ID
 */
function generateSessionId(): string {
  const array = new Uint8Array(32);
  crypto.getRandomValues(array);
  return Array.from(array, byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * Store session in KV with 24h TTL
 */
async function createSession(env: Bindings, session: Session): Promise<string> {
  const sessionId = generateSessionId();
  await env.SESSIONS.put(`session:${sessionId}`, JSON.stringify(session), {
    expirationTtl: 86400, // 24 hours
  });
  return sessionId;
}

/**
 * Get session from KV by session ID
 */
async function getSession(env: Bindings, sessionId: string): Promise<Session | null> {
  const data = await env.SESSIONS.get(`session:${sessionId}`);
  if (!data) return null;
  try {
    return JSON.parse(data) as Session;
  } catch {
    // Treat invalid/corrupted JSON as an expired or missing session
    return null;
  }
}

/**
 * Delete session from KV
 */
async function deleteSession(env: Bindings, sessionId: string): Promise<void> {
  await env.SESSIONS.delete(`session:${sessionId}`);
}

/**
 * Extract session ID from cookie
 */
function getSessionIdFromCookie(cookieHeader: string | null | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)session_id=([^;]+)/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return null;
  }
}

/**
 * Middleware: require authentication
 *
 * For browser navigation routes (e.g. /dashboard), unauthenticated requests
 * are redirected to /api/auth/login. For API routes (paths starting with
 * /api/), unauthenticated requests receive a 401 JSON response so that
 * frontend fetch() calls can handle navigation explicitly.
 */
export async function requireAuth(c: Context<{ Bindings: Bindings }>): Promise<Session | Response> {
  const cookieHeader = c.req.header("Cookie");
  const sessionId = getSessionIdFromCookie(cookieHeader);
  const path = c.req.path;
  const isApiRoute = path.startsWith("/api/");

  if (!sessionId) {
    if (isApiRoute) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.redirect("/api/auth/login");
  }

  const session = await getSession(c.env, sessionId);
  if (!session) {
    if (isApiRoute) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    return c.redirect("/api/auth/login");
  }

  return session;
}

/**
 * Auth handlers
 */
export const authHandlers = {
  /**
   * GET /api/auth/login
   * Redirect to Google OAuth consent screen
   */
  async login(c: Context<{ Bindings: Bindings }>) {
    const clientId = c.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      return c.text("GOOGLE_CLIENT_ID not configured", 500);
    }

    const redirectUri = `${new URL(c.req.url).origin}/api/auth/callback`;
    const state = generateSessionId(); // CSRF protection

    // Store state in KV for validation (5 min TTL)
    await c.env.SESSIONS.put(`oauth_state:${state}`, "1", {
      expirationTtl: 300,
    });

    const params = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: "openid email profile",
      state,
    });

    return c.redirect(`${GOOGLE_AUTH_URL}?${params}`);
  },

  /**
   * GET /api/auth/callback
   * Handle OAuth callback from Google
   */
  async callback(c: Context<{ Bindings: Bindings }>) {
    const code = c.req.query("code") || null;
    const state = c.req.query("state") || null;
    const error = c.req.query("error") || null;

    if (error) {
      return c.text(`OAuth error: ${error}`, 400);
    }

    if (!code || !state) {
      return c.text("Missing code or state", 400);
    }

    // Verify state (CSRF protection)
    const storedState = await c.env.SESSIONS.get(`oauth_state:${state}`);
    if (!storedState) {
      return c.text("Invalid or expired state", 400);
    }
    await c.env.SESSIONS.delete(`oauth_state:${state}`);

    // Exchange code for tokens
    const redirectUri = `${new URL(c.req.url).origin}/api/auth/callback`;
    const tokenResponse = await fetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: c.env.GOOGLE_CLIENT_ID,
        client_secret: c.env.GOOGLE_CLIENT_SECRET,
        redirect_uri: redirectUri,
        grant_type: "authorization_code",
      }),
    });

    if (!tokenResponse.ok) {
      const errorText = await tokenResponse.text();
      return c.text(`Token exchange failed: ${errorText}`, 500);
    }

    const tokens = await tokenResponse.json<GoogleTokenResponse>();

    // Fetch user info
    const userInfoResponse = await fetch(GOOGLE_USERINFO_URL, {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });

    if (!userInfoResponse.ok) {
      return c.text("Failed to fetch user info", 500);
    }

    const userInfo = await userInfoResponse.json<GoogleUserInfo>();

    // Verify email is verified by Google
    if (!userInfo.verified_email) {
      return c.text("Access denied. Email address not verified by Google.", 403);
    }

    // Check email allowlist (required for security)
    const allowedEmails = c.env.ALLOWED_EMAILS;
    if (!allowedEmails) {
      return c.text("ALLOWED_EMAILS not configured. Access denied.", 500);
    }

    const allowed = allowedEmails.split(",").map(e => e.trim().toLowerCase());
    if (!allowed.includes(userInfo.email.toLowerCase())) {
      return c.text(`Access denied. Your email (${userInfo.email}) is not authorized.`, 403);
    }

    // Create session
    const session: Session = {
      email: userInfo.email,
      name: userInfo.name,
      picture: userInfo.picture,
      createdAt: Date.now(),
    };

    const sessionId = await createSession(c.env, session);

    // Set cookie and redirect to dashboard
    const cookie = `session_id=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=86400`;
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/dashboard",
        "Set-Cookie": cookie,
      },
    });
  },

  /**
   * GET /api/auth/user
   * Get current user info (for displaying in UI)
   */
  async user(c: Context<{ Bindings: Bindings }>) {
    const cookieHeader = c.req.header("Cookie");
    const sessionId = getSessionIdFromCookie(cookieHeader);

    if (!sessionId) {
      return c.json({ error: "Not authenticated" }, 401);
    }

    const session = await getSession(c.env, sessionId);
    if (!session) {
      return c.json({ error: "Session expired" }, 401);
    }

    return c.json({
      email: session.email,
      name: session.name,
      picture: session.picture,
    });
  },

  /**
   * POST /api/auth/logout
   * Destroy session and redirect to login
   */
  async logout(c: Context<{ Bindings: Bindings }>) {
    const cookieHeader = c.req.header("Cookie");
    const sessionId = getSessionIdFromCookie(cookieHeader);

    if (sessionId) {
      await deleteSession(c.env, sessionId);
    }

    const cookie = "session_id=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";
    return new Response(null, {
      status: 302,
      headers: {
        Location: "/",
        "Set-Cookie": cookie,
      },
    });
  },
};

/**
 * Helper: check if request has valid session
 */
export async function isAuthenticated(c: Context<{ Bindings: Bindings }>): Promise<boolean> {
  const cookieHeader = c.req.header("Cookie");
  const sessionId = getSessionIdFromCookie(cookieHeader);
  if (!sessionId) return false;

  const session = await getSession(c.env, sessionId);
  return session !== null;
}
