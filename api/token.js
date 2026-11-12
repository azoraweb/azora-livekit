// Vercel serverless function: replaces your current /api/token endpoint.
// npm i livekit-server-sdk
//
// Environment variables (Vercel > Settings > Environment Variables):
//   LIVEKIT_API_KEY, LIVEKIT_API_SECRET   already set for your old endpoint
//   ROOM_PASSCODE       already set: the normal passcode to enter the main room
//   HOST_PASSCODE       NEW: the host passcode (keep it ONLY here, never in the page)
//   LIVEKIT_URL         optional, defaults to wss://azora-bxx8k12w.livekit.cloud
//   ALLOWED_ORIGIN      optional, e.g. https://yoursite.com (defaults to *)

const crypto = require("crypto");
const { AccessToken, TokenVerifier, RoomServiceClient } = require("livekit-server-sdk");

const KEY = process.env.LIVEKIT_API_KEY;
const SECRET = process.env.LIVEKIT_API_SECRET;
const LIVEKIT_URL = process.env.LIVEKIT_URL || "wss://azora-bxx8k12w.livekit.cloud";
const MEETING_PASSCODE = process.env.ROOM_PASSCODE || process.env.MEETING_PASSCODE; // your existing variable
const HOST_PASSCODE = process.env.HOST_PASSCODE;
const MAIN_ROOM = process.env.MAIN_ROOM || "azora-main-room"; // same room name as your old file

const svc = () => new RoomServiceClient(LIVEKIT_URL.replace(/^wss:/, "https:").replace(/^ws:/, "http:"), KEY, SECRET);
const eq = (a, b) => {
  a = Buffer.from(String(a || "")); b = Buffer.from(String(b || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const hash = (room, pw) => crypto.createHmac("sha256", SECRET).update(room + ":" + pw).digest("hex");

// Breakout list (id + title only, no passcodes) lives in the main room's metadata.
async function getList() {
  const [r] = await svc().listRooms([MAIN_ROOM]);
  try { return JSON.parse((r && r.metadata) || "[]"); } catch (e) { return []; }
}
async function setList(list) {
  const s = svc();
  await s.createRoom({ name: MAIN_ROOM, emptyTimeout: 43200 });
  await s.updateRoomMetadata(MAIN_ROOM, JSON.stringify(list));
}

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
        caller = { host: meta.host === true };
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
        const entry = (await getList()).find(x => x.id === b.room);
        if (!entry) return fail(404, "That breakout room no longer exists.");
        if (!host) {
          const [r] = await svc().listRooms([b.room]);
          let h; try { h = JSON.parse((r && r.metadata) || "{}").h; } catch (e) {}
          if (!r || !eq(h, hash(b.room, String(b.passcode || "")))) return fail(403, "Wrong passcode for this room.");
        }
        room = b.room; title = entry.title; breakout = true;
      } else if (!host && !caller && !eq(b.passcode, MEETING_PASSCODE)) {
        return fail(403, "Wrong passcode.");
      }

      const identity = name + "-" + crypto.randomBytes(2).toString("hex");
      const at = new AccessToken(KEY, SECRET, { identity, name, ttl: "6h", metadata: JSON.stringify({ host }) });
      at.addGrant({ roomJoin: true, room, canPublish: true, canSubscribe: true, canPublishData: true });
      return res.status(200).json({ token: await at.toJwt(), host, breakout, title });
    }

    if (!caller) return fail(401, "Join the meeting first.");

    if (action === "list") return res.status(200).json({ rooms: await getList() });

    if (!caller.host) return fail(403, "Only hosts can do that.");

    if (action === "create") {
      const title = String(b.title || "").trim().slice(0, 40), pw = String(b.password || "");
      if (!title || pw.length < 3) return fail(400, "Give the room a name and a passcode of at least 3 characters.");
      const id = MAIN_ROOM + "__b_" + crypto.randomBytes(3).toString("hex");
      await svc().createRoom({ name: id, emptyTimeout: 43200, metadata: JSON.stringify({ h: hash(id, pw) }) });
      await setList([...(await getList()), { id, title }]);
      return res.status(200).json({ ok: true, id });
    }

    const list = await getList();
    if (!list.some(x => x.id === b.id)) return fail(404, "Unknown breakout room.");

    if (action === "password") {
      const pw = String(b.password || "");
      if (pw.length < 3) return fail(400, "Passcode must be at least 3 characters.");
      const s = svc();
      await s.createRoom({ name: b.id, emptyTimeout: 43200 }); // no-op if it still exists
      await s.updateRoomMetadata(b.id, JSON.stringify({ h: hash(b.id, pw) }));
      return res.status(200).json({ ok: true });
    }

    if (action === "close") {
      await setList(list.filter(x => x.id !== b.id));
      try { await svc().deleteRoom(b.id); } catch (e) {}
      return res.status(200).json({ ok: true });
    }

    return fail(400, "Unknown action.");
  } catch (e) {
    console.error(e);
    return fail(500, "Server error.");
  }
};
