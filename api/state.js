// H2Whose? — shared state API backed by Upstash Redis (via Vercel Marketplace).
//
// GET  /api/state?room=default         -> returns the stored state object
// POST /api/state?room=default  (body) -> replaces the stored state object
//
// Env vars (injected automatically by the Vercel → Upstash integration):
//   KV_REST_API_URL / KV_REST_API_TOKEN              (legacy Vercel KV names, still used by the migrated stores)
//   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN (names used if you install Upstash directly)
// We accept either pair so setup just works.

import { Redis } from "@upstash/redis";

const REDIS_URL =
  process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN =
  process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;

const redis =
  REDIS_URL && REDIS_TOKEN
    ? new Redis({ url: REDIS_URL, token: REDIS_TOKEN })
    : null;

const emptyState = () => ({
  names: [],
  currentRound: [],
  history: [],
  roundNumber: 1,
  updatedAt: 0,
});

// Only allow safe characters in room names so the key space can't be abused.
const sanitizeRoom = (raw) => {
  const s = String(raw || "default")
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, "")
    .slice(0, 40);
  return s || "default";
};

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");

  if (!redis) {
    return res.status(503).json({
      error:
        "Redis not configured. Install the Upstash for Redis integration in your Vercel project's Storage tab.",
    });
  }

  const room = sanitizeRoom(req.query?.room);
  const key = `h2w:${room}`;

  try {
    if (req.method === "GET") {
      const state = await redis.get(key);
      return res.status(200).json(state || emptyState());
    }

    if (req.method === "POST") {
      // Vercel parses JSON bodies automatically when the content-type is correct.
      const body = req.body;
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return res.status(400).json({ error: "body must be a state object" });
      }

      // Minimal shape check — don't let random payloads trash the store.
      const {
        names = [],
        currentRound = [],
        history = [],
        roundNumber = 1,
      } = body;

      if (!Array.isArray(names) || !Array.isArray(currentRound) || !Array.isArray(history)) {
        return res.status(400).json({ error: "invalid shape" });
      }

      const clean = {
        names: names.slice(0, 200),
        currentRound: currentRound.slice(0, 200),
        history: history.slice(0, 500),
        roundNumber: Number.isFinite(roundNumber) ? roundNumber : 1,
        updatedAt: Date.now(),
      };

      // Safety: cap payload size.
      if (JSON.stringify(clean).length > 250_000) {
        return res.status(413).json({ error: "state too large" });
      }

      await redis.set(key, clean);
      return res.status(200).json({ ok: true, updatedAt: clean.updatedAt });
    }

    res.setHeader("Allow", "GET, POST");
    return res.status(405).json({ error: "method not allowed" });
  } catch (err) {
    console.error("state handler error:", err);
    return res.status(500).json({ error: "server error" });
  }
}
