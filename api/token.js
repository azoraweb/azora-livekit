const { AccessToken } = require("livekit-server-sdk");

module.exports = async (req, res) => {
  const { name, passcode } = req.body;

  if (passcode !== process.env.ROOM_PASSCODE) {
    return res.status(401).json({
      error: "Invalid passcode"
    });
  }

  const token = new AccessToken(
    process.env.LIVEKIT_API_KEY,
    process.env.LIVEKIT_API_SECRET,
    {
      identity: name
    }
  );

  token.addGrant({
    roomJoin: true,
    room: "azora-main-room"
  });

  res.status(200).json({
    token: await token.toJwt()
  });
};
