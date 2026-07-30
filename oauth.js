import express from "express";
import crypto from "node:crypto";
import { upsertUserProfileStmt, getUserProfileStmt, db } from "./database.js";

const SESSION_COOKIE = "glizzy_session";
const STATE_COOKIE = "glizzy_oauth_state";
const SESSION_TTL_DAYS = 30;
const SESSION_TTL_MS = SESSION_TTL_DAYS * 24 * 60 * 60 * 1000;

function sessionSecret() {
  // Fall back to ADMIN_PASSWORD so local dev works without a separate secret.
  // In production set GAME_SESSION_SECRET explicitly (32+ random hex chars).
  return process.env.GAME_SESSION_SECRET || process.env.ADMIN_PASSWORD || "";
}

function clientSecret() {
  return process.env.DISCORD_CLIENT_SECRET || "";
}

function appId() {
  return process.env.APP_ID || "";
}

function publicBase() {
  return (process.env.PUBLIC_BASE_URL || "").replace(/\/+$/, "");
}

function readCookie(req, name) {
  const header = req.headers.cookie || "";
  for (const part of header.split(";")) {
    const trimmed = part.trim();
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) return decodeURIComponent(trimmed.slice(eq + 1));
  }
  return null;
}

function signSession(userId, expiresAt) {
  const payload = `${userId}|${expiresAt}`;
  const secret = sessionSecret();
  if (!secret) throw new Error("GAME_SESSION_SECRET (or ADMIN_PASSWORD) not set");
  const sig = crypto.createHmac("sha256", secret).update(payload).digest("hex");
  return `${payload}|${sig}`;
}

function verifySession(token) {
  if (!token) return null;
  const parts = token.split("|");
  if (parts.length !== 3) return null;
  const [userId, expStr, sig] = parts;
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const secret = sessionSecret();
  if (!secret) return null;
  const expected = crypto.createHmac("sha256", secret).update(`${userId}|${expiresAt}`).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return null;
  try {
    if (!crypto.timingSafeEqual(a, b)) return null;
  } catch {
    return null;
  }
  return { userId, expiresAt };
}

function setSessionCookie(res, userId, secure) {
  const expiresAt = Date.now() + SESSION_TTL_MS;
  res.cookie(SESSION_COOKIE, signSession(userId, expiresAt), {
    httpOnly: true,
    sameSite: "lax",
    secure,
    maxAge: SESSION_TTL_MS,
    path: "/",
  });
}

/**
 * Build a signed session cookie string for a user, e.g. to attach to a
 * WebSocket upgrade request. Keeps the cookie's name and signing format in the
 * one file that owns them instead of letting callers reinvent either.
 */
export function mintSessionCookie(userId) {
  return `${SESSION_COOKIE}=${encodeURIComponent(signSession(userId, Date.now() + SESSION_TTL_MS))}`;
}

export function getSessionUserId(req) {
  const session = verifySession(readCookie(req, SESSION_COOKIE));
  return session ? session.userId : null;
}

export function requireGameSession(req, res, next) {
  const userId = getSessionUserId(req);
  if (!userId) {
    if (req.method !== "GET" || req.headers.accept?.includes("application/json")) {
      return res.status(401).json({ error: "auth_required" });
    }
    const next = encodeURIComponent(req.originalUrl || "/game");
    return res.redirect(`/oauth/login?next=${next}`);
  }
  req.gameUserId = userId;
  next();
}

function isDevBypassMode() {
  return !clientSecret();
}

function devBypassUserId() {
  // Use the first user we've seen in hotdog_events so the dev experience has real data.
  const row = db.prepare("SELECT user_id FROM hotdog_events ORDER BY timestamp DESC LIMIT 1").get();
  return row ? row.user_id : "0000000000000000000";
}

export function registerOAuth(app) {
  const router = express.Router();

  router.get("/login", async (req, res) => {
    const next = typeof req.query.next === "string" ? req.query.next : "/game";

    // Dev bypass: when no DISCORD_CLIENT_SECRET is configured, log in as the most-recently-seen
    // hotdog_events user so the game is playable end-to-end locally.
    if (isDevBypassMode()) {
      const userId = devBypassUserId();
      setSessionCookie(res, userId, false);
      console.log("[oauth] dev-bypass login as", userId);
      return res.redirect(next);
    }

    if (!appId() || !publicBase()) {
      return res.status(500).send("OAuth not fully configured: need APP_ID and PUBLIC_BASE_URL.");
    }

    const stateNonce = crypto.randomBytes(16).toString("hex");
    const statePayload = JSON.stringify({ n: stateNonce, next });
    res.cookie(STATE_COOKIE, statePayload, {
      httpOnly: true,
      sameSite: "lax",
      secure: req.secure || req.headers["x-forwarded-proto"] === "https",
      maxAge: 10 * 60 * 1000,
      path: "/oauth",
    });

    const params = new URLSearchParams({
      client_id: appId(),
      redirect_uri: `${publicBase()}/oauth/callback`,
      response_type: "code",
      scope: "identify",
      state: stateNonce,
      prompt: "none",
    });
    res.redirect(`https://discord.com/api/oauth2/authorize?${params.toString()}`);
  });

  router.get("/callback", async (req, res) => {
    if (isDevBypassMode()) {
      return res.redirect("/oauth/login");
    }
    const { code, state } = req.query;
    if (!code || !state) return res.status(400).send("missing code/state");

    let cookieState;
    try {
      cookieState = JSON.parse(readCookie(req, STATE_COOKIE) || "null");
    } catch {
      cookieState = null;
    }
    if (!cookieState || cookieState.n !== state) {
      return res.status(400).send("state mismatch (CSRF)");
    }

    // Exchange the code for an access token.
    const tokenRes = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: appId(),
        client_secret: clientSecret(),
        grant_type: "authorization_code",
        code: String(code),
        redirect_uri: `${publicBase()}/oauth/callback`,
      }).toString(),
    });
    if (!tokenRes.ok) {
      const err = await tokenRes.text();
      console.error("[oauth] token exchange failed:", tokenRes.status, err);
      return res.status(502).send("Discord token exchange failed");
    }
    const tokens = await tokenRes.json();

    // Fetch the user.
    const userRes = await fetch("https://discord.com/api/v10/users/@me", {
      headers: { Authorization: `Bearer ${tokens.access_token}` },
    });
    if (!userRes.ok) {
      console.error("[oauth] /users/@me failed:", userRes.status);
      return res.status(502).send("Discord user fetch failed");
    }
    const user = await userRes.json();

    // Upsert into user_profiles. We want the avatar to render immediately on the
    // dashboard / leaderboards, so we set avatar_url to the Discord CDN URL right
    // away. The daily worker (profiles.js) will later replace it with the durable
    // Spaces-mirrored copy.
    //
    // Don't clobber an existing Spaces URL when the avatar hash hasn't changed:
    // that would replace a permanent URL with one that might go stale if the user
    // changes their avatar later.
    const cached = getUserProfileStmt.get(user.id);
    const newHash = user.avatar || null;
    let avatarUrl;
    if (cached && cached.avatar_hash === newHash && cached.avatar_url) {
      avatarUrl = cached.avatar_url; // keep durable URL we already have
    } else if (newHash) {
      const ext = newHash.startsWith("a_") ? "gif" : "png";
      avatarUrl = `https://cdn.discordapp.com/avatars/${user.id}/${newHash}.${ext}?size=256`;
    } else {
      avatarUrl = null;
    }
    upsertUserProfileStmt.run(user.id, user.username || null, user.global_name || null, newHash, avatarUrl);

    // Kick a Spaces mirror in the background (no await). Fails gracefully when
    // DO Spaces isn't configured locally.
    import("./profiles.js").then((m) =>
      m.refreshProfile(user.id).catch((err) =>
        console.warn("[oauth] background avatar mirror failed:", err.message),
      ),
    ).catch(() => {});

    res.clearCookie(STATE_COOKIE, { path: "/oauth" });
    setSessionCookie(res, user.id, req.secure || req.headers["x-forwarded-proto"] === "https");

    const next = typeof cookieState.next === "string" && cookieState.next.startsWith("/")
      ? cookieState.next
      : "/game";
    res.redirect(next);
  });

  router.post("/logout", (req, res) => {
    res.clearCookie(SESSION_COOKIE, { path: "/" });
    res.redirect("/");
  });

  app.use("/oauth", router);
}
