// Vercel serverless function: replaces your current /api/token endpoint.
// npm i livekit-server-sdk
//
// Environment variables (Vercel > Settings > Environment Variables):
//   LIVEKIT_API_KEY, LIVEKIT_API_SECRET   already set for your old endpoint
//   ROOM_PASSCODE       already set: the normal passcode to enter the main room
//   HOST_PASSCODE       NEW: the host passcode (keep it ONLY here, never in the page)
//   LIVEKIT_URL         optional, defaults to wss://azora-bxx8k12w.livekit.cloud
//   ALLOWED_ORIGIN      optional, e.g. https://yoursite.com (defaults to *)
//
// Breakout rooms are saved in Upstash Redis when these exist (add the Upstash Redis
// integration from the Vercel Marketplace and it sets them for you):
//   KV_REST_API_URL + KV_REST_API_TOKEN   (or UPSTASH_REDIS_REST_URL + UPSTASH_REDIS_REST_TOKEN)
// Without Redis they are kept in LiveKit and last only while LiveKit keeps the main room alive.

const crypto = require("crypto");
const { AccessToken, TokenVerifier, RoomServiceClient } = require("livekit-server-sdk");

const KEY = process.env.LIVEKIT_API_KEY;
const SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL || "wss://azora-bxx8k12w.livekit.cloud";
const MEETING_PASSCODE = process.env.ROOM_PASSCODE || process.env.MEETING_PASSCODE; // your existing variable
const HOST_PASSCODE = process.env.HOST_PASSCODE;
const MAIN_ROOM = process.env.MAIN_ROOM || "azora-main-room"; // same room name as your old file

const svc = () => new RoomServiceClient(LIVEKIT_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), KEY, SECRET);
const isHost = p => { try { return JSON.parse(p.metadata || "{}").host === true; } catch (e) { return false; } };
const isAudio = t => t.type === 0 || t.type === "AUDIO";
async function muteOne(room, p) {
  for (const t of p.tracks || []) {
    if (isAudio(t) && !t.muted) { try { await svc().mutePublishedTrack(room, p.identity, t.sid, true); } catch (e) {} }
  }
}
const eq = (a, b) => {
  a = Buffer.from(String(a || "")); b = Buffer.from(String(b || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const hash = (room, pw) => crypto.createHmac("sha256", SECRET).update(room + ":" + pw).digest("hex");

// ---- Breakout storage: { rooms: [{ id, title, h }] }, h = keyed hash of the passcode ----
const REDIS_URL = process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const STATE_KEY = "azora:" + MAIN_ROOM + ":breakouts";

async function redis(cmd) {
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: "Bearer " + REDIS_TOKEN, "Content-Type": "application/json" },
    body: JSON.stringify(cmd)
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok || d.error) throw new Error(d.error || "Redis error");
  return d.result;
}
async function getState() {
  let raw;
  if (REDIS_URL && REDIS_TOKEN) raw = await redis(["GET", STATE_KEY]);
  else { const [r] = await svc().listRooms([MAIN_ROOM]); raw = r && r.metadata; }
  try {
    const st = JSON.parse(raw || "{}");
    return { rooms: Array.isArray(st.rooms) ? st.rooms.filter(x => x && x.h) : [] };
  } catch (e) { return { rooms: [] }; }
}
async function setState(st) {
  const raw = JSON.stringify(st);
  if (REDIS_URL && REDIS_TOKEN) return redis(["SET", STATE_KEY, raw]);
  await ensureMain();
  await svc().updateRoomMetadata(MAIN_ROOM, raw);
}
// Fallback mode only: create the main room ourselves with a long empty timeout (default is 5 minutes).
const ensureMain = () => svc().createRoom({ name: MAIN_ROOM, emptyTimeout: 7 * 24 * 3600 });

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const fail = (code, error) => res.status(code).json({ error });

  try {
    const b = typeof req.body === "string" ? JSON.parse(req.body || "{}") : (req.body || {});
    const action = b.action || "join";

    // Who is calling? A token we issued earlier, sent as a Bearer header.
    let caller = null;
    const bearer = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
    if (bearer) {
      try {
        const claims = await new TokenVerifier(KEY, SECRET).verify(bearer);
        let meta = {}; try { meta = JSON.parse(claims.metadata || "{}"); } catch (e) {}
        caller = { host: meta.host === true, room: claims.video && claims.video.room };
      } catch (e) {}
    }

    if (action === "join") {
      const name = String(b.name || "").trim().slice(0, 40);
      if (!name) return fail(400, "Enter your name.");
      const hp = String(b.hostPasscode || "");
      const claimsHost = hp && eq(hp, HOST_PASSCODE);
      if (hp && !HOST_PASSCODE) return fail(500, "HOST_PASSCODE is not set on the server.");
      if (hp && !claimsHost && !(caller && caller.host)) return fail(403, "Wrong host passcode.");
      const host = !!((caller && caller.host) || claimsHost);

      let room = MAIN_ROOM, title = "Azora Meeting", breakout = false;
      if (b.room && b.room !== MAIN_ROOM) {
        const entry = (await getState()).rooms.find(x => x.id === b.room);
        if (!entry) return fail(404, "That breakout room no longer exists.");
        if (!host && !eq(entry.h, hash(entry.id, String(b.passcode || "")))) return fail(403, "Wrong passcode for this room.");
        room = b.room; title = entry.title; breakout = true;
      } else if (!host && !caller && !eq(b.passcode, MEETING_PASSCODE)) {
        return fail(403, "Wrong passcode.");
      }

      if (!(REDIS_URL && REDIS_TOKEN)) await ensureMain().catch(() => {});
      const identity = name + "-" + crypto.randomBytes(2).toString("hex");
      const at = new AccessToken(KEY, SECRET, { identity, name, ttl: "6h", metadata: JSON.stringify({ host }) });
      at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true, canUpdateOwnMetadata: true });
      return res.status(200).json({ token: await at.toJwt(), host, breakout, title });
    }

    if (!caller) return fail(401, "Join the meeting first.");

    if (action === "list") return res.status(200).json({ rooms: (await getState()).rooms.map(({ id, title }) => ({ id, title })) });

    if (!caller.host) return fail(403, "Only hosts can do that.");

    // Host controls act on the room the host is currently in (taken from their signed token).
    if (action === "mute" || action === "muteall" || action === "remove") {
      const room = caller.room;
      if (!room) return fail(400, "Unknown room.");
      const people = await svc().listParticipants(room);
      if (action === "muteall") {
        await Promise.all(people.filter(p => !isHost(p)).map(p => muteOne(room, p)));
        return res.status(200).json({ ok: true });
      }
      const target = people.find(p => p.identity === b.identity);
      if (!target) return fail(404, "That person already left.");
      if (isHost(target)) return fail(403, "You can't do that to a host.");
      if (action === "mute") await muteOne(room, target);
      else await svc().removeParticipant(room, target.identity);
      return res.status(200).json({ ok: true });
    }

    if (action === "create") {
      const title = String(b.title || "").trim().slice(0, 40), pw = String(b.password || "");
      if (!title || pw.length < 3) return fail(400, "Give the room a name and a passcode of at least 3 characters.");
      const id = MAIN_ROOM + "__b_" + crypto.randomBytes(3).toString("hex");
      const st = await getState();
      st.rooms.push({ id, title, h: hash(id, pw) });
      await setState(st);
      return res.status(200).json({ ok: true, id });
    }

    const st = await getState();
    const entry = st.rooms.find(x => x.id === b.id);
    if (!entry) return fail(404, "Unknown breakout room.");

    if (action === "password") {
      const pw = String(b.password || "");
      if (pw.length < 3) return fail(400, "Passcode must be at least 3 characters.");
      entry.h = hash(entry.id, pw);
      await setState(st);
      return res.status(200).json({ ok: true });
    }

    if (action === "close") {
      st.rooms = st.rooms.filter(x => x.id !== b.id);
      await setState(st);
      try { await svc().deleteRoom(b.id); } catch (e) {}
      return res.status(200).json({ ok: true });
    }

    return fail(400, "Unknown action.");
  } catch (e) {
    console.error(e);
    return fail(500, "Server error.");
  }
};
