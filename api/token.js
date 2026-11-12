const { AccessToken } = require("livekit-server-sdk");

module.exports = async (req, res) => {
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

    const jwt = await token.toJwt();

    return res.status(200).json({
      token: jwt
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message
    });
  }
};
