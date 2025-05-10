const jwt = require('jsonwebtoken');
const SECRET_KEY = require("./config.js").jwtSecret;

const authedMultiplayerClients = new Map(); // User id -> Client id from PlaySocket

function attachPlaySocketEvents(server) {
    server.onEvent("clientRegistered", (id, data) => {
        if (!data?.bearer) return;
        jwt.verify(data.bearer, SECRET_KEY, (err, decoded) => {
            if (err) return console.error("Error decoding multiplayer auth token:", err);
            if (!decoded || !decoded.userId) return console.error("Multiplayer auth token lacks user id.");
            authedMultiplayerClients.set(id, decoded.userId); // Id -> User id
        });
    });
    server.onEvent("clientDisconnected", (id) => {
        authedMultiplayerClients.delete(id);
    });
}

module.exports = { attachPlaySocketEvents };