const express = require("express");
const crypto = require("crypto");
const path = require("path");
const cookieParser = require("cookie-parser");

const { db } = require("./database");
const { syncResources } = require("./sync");
const { applyResourceUpdate, removeResource } = require("./resourceManager");
const config = require("./config");

// ─── Session & rate-limit stores ──────────────────────────────────────────────
// These live in memory; they reset on bot restart, which is fine for a personal tool.
const sessions = new Map(); // token  → { expiresAt }
const loginAttempts = new Map(); // ip     → { count, lockedUntil }

const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 h  — slides on every request
const LOCKOUT_TTL = 15 * 60 * 1000; // 15 m — after MAX_ATTEMPTS failures
const MAX_ATTEMPTS = 5;

// Prune expired sessions once per hour so the Map doesn't grow unbounded
setInterval(
  () => {
    const now = Date.now();
    for (const [token, s] of sessions) {
      if (now > s.expiresAt) sessions.delete(token);
    }
  },
  60 * 60 * 1000,
);

// ─── Factory ──────────────────────────────────────────────────────────────────
function startWebPanel(client) {
  const app = express();

  app.use(express.json());
  app.use(cookieParser());
  app.use(express.static(path.join(__dirname, "..", "public")));

  // ── Middleware: require a valid session cookie ────────────────────────────
  function requireSession(req, res, next) {
    if (!config.panel.secret) {
      return res
        .status(503)
        .json({ error: "Admin panel not configured (PANEL_SECRET missing)." });
    }

    const token = req.cookies?.panel_session;
    if (!token) return res.status(401).json({ error: "Not authenticated" });

    const session = sessions.get(token);
    if (!session) {
      res.clearCookie("panel_session");
      return res
        .status(401)
        .json({ error: "Invalid session — please log in again" });
    }
    if (Date.now() > session.expiresAt) {
      sessions.delete(token);
      res.clearCookie("panel_session");
      return res
        .status(401)
        .json({ error: "Session expired — please log in again" });
    }

    // Sliding expiry: any activity resets the 8-hour clock
    session.expiresAt = Date.now() + SESSION_TTL;
    next();
  }

  // ── POST /api/login ───────────────────────────────────────────────────────
  app.post("/api/login", (req, res) => {
    if (!config.panel.secret) {
      return res.status(503).json({ error: "Admin panel not configured." });
    }

    const ip = req.ip || req.socket.remoteAddress || "unknown";
    const now = Date.now();

    // Look up (or create) the rate-limit record for this IP
    const record = loginAttempts.get(ip) || { count: 0, lockedUntil: 0 };

    // Still inside a lockout window?
    if (now < record.lockedUntil) {
      const secsLeft = Math.ceil((record.lockedUntil - now) / 1000);
      return res.status(429).json({
        error: `Too many failed attempts. Try again in ${secsLeft}s.`,
        lockedUntil: record.lockedUntil,
      });
    }

    // Lockout window expired — reset counter
    if (record.lockedUntil && now >= record.lockedUntil) {
      record.count = 0;
      record.lockedUntil = 0;
    }

    const { secret } = req.body;

    if (!secret || secret !== config.panel.secret) {
      record.count += 1;
      loginAttempts.set(ip, record);
      console.warn(
        `[panel] Failed login from ${ip} (attempt ${record.count}/${MAX_ATTEMPTS})`,
      );

      if (record.count >= MAX_ATTEMPTS) {
        record.lockedUntil = now + LOCKOUT_TTL;
        record.count = 0;
        loginAttempts.set(ip, record);
        console.warn(
          `[panel] ${ip} locked out for ${LOCKOUT_TTL / 60000} minutes`,
        );
        return res.status(429).json({
          error: "Too many failed attempts. Locked out for 15 minutes.",
          lockedUntil: record.lockedUntil,
        });
      }

      return res.status(401).json({
        error: `Incorrect secret. ${MAX_ATTEMPTS - record.count} attempt(s) remaining.`,
        attemptsLeft: MAX_ATTEMPTS - record.count,
      });
    }

    // ✅ Correct — issue a new session
    loginAttempts.delete(ip);

    const token = crypto.randomBytes(32).toString("hex");
    sessions.set(token, { expiresAt: Date.now() + SESSION_TTL });

    console.log(`[panel] Successful login from ${ip}`);

    res.cookie("panel_session", token, {
      httpOnly: true, // not accessible via document.cookie (XSS protection)
      sameSite: "strict", // not sent on cross-site requests (CSRF protection)
      maxAge: SESSION_TTL,
      // secure: true   // ← uncomment if you serve the panel over HTTPS
    });

    res.json({ success: true });
  });

  // ── POST /api/logout ──────────────────────────────────────────────────────
  app.post("/api/logout", (req, res) => {
    const token = req.cookies?.panel_session;
    if (token) sessions.delete(token);
    res.clearCookie("panel_session");
    console.log(`[panel] Logout from ${req.ip}`);
    res.json({ success: true });
  });

  // ── GET /api/status ───────────────────────────────────────────────────────
  app.get("/api/status", requireSession, (req, res) => {
    const guildId = config.guildId || client.guilds.cache.first()?.id || null;
    res.json({
      online: client.isReady(),
      tag: client.user?.tag ?? null,
      ping: client.ws.ping,
      guildId,
    });
  });

  // ── GET /api/resources ────────────────────────────────────────────────────
  app.get("/api/resources", requireSession, async (req, res) => {
    try {
      res.json(await db.getAllResources());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── PUT /api/resources/:id ────────────────────────────────────────────────
  app.put("/api/resources/:id", requireSession, async (req, res) => {
    try {
      const resource = await applyResourceUpdate(
        client,
        req.params.id,
        req.body,
      );
      res.json(resource);
    } catch (err) {
      res
        .status(err.message.includes("not found") ? 404 : 500)
        .json({ error: err.message });
    }
  });

  // ── DELETE /api/resources/:id ─────────────────────────────────────────────
  app.delete("/api/resources/:id", requireSession, async (req, res) => {
    try {
      await removeResource(client, req.params.id);
      res.json({ success: true });
    } catch (err) {
      res
        .status(err.message.includes("not found") ? 404 : 500)
        .json({ error: err.message });
    }
  });

  // ── POST /api/sync ────────────────────────────────────────────────────────
  app.post("/api/sync", requireSession, async (req, res) => {
    try {
      res.json(await syncResources(client));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── Start ─────────────────────────────────────────────────────────────────
  app.listen(config.panel.port, () => {
    console.log(`[panel] Admin panel → http://localhost:${config.panel.port}`);
  });
}

module.exports = { startWebPanel };
