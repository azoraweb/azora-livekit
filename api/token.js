const { AccessToken } = require("livekit-server-sdk");

module.exports = async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");

  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }

  try {
    if (req.method !== "POST") {
      return res.status(200).json({
        status: "ready"
      });
    }

    const { name, passcode } = req.body || {};

    if (passcode !== process.env.ROOM_PASSCODE) {
      return res.status(401).json({
        error: "Invalid passcode"
      });
    }

    const token = new AccessToken(
      process.env.LIVEKIT_API_KEY,
      process.env.LIVEKIT_API_SECRET,
      {
        identity: name || "Guest"
      }
    );

    token.addGrant({
      roomJoin: true,
      room: "azora-main-room"
    });

    return res.status(200).json({
      token: await token.toJwt()
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
};
