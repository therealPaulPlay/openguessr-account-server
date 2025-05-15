const jwt = require('jsonwebtoken');
const processDuelResult = require('./processDuelResult.js');
const SECRET_KEY = require("./config.js").jwtSecret;

const authedMultiplayerClients = new Map(); // Client Id (from PlaySocket) -> User id
const authedMultiplayerUserId = new Map(); // User id -> client id
let playSocketServer;

// Duel rooms
const userIdDuelUuid = new Map(); // User id -> Active duel uuid (active = no result submited yet)

function attachPlaySocketEvents(server) {
    playSocketServer = server; // assign server
    server.onEvent("clientRegistered", (clientId, data) => {
        if (!data?.bearer) return;
        jwt.verify(data.bearer, SECRET_KEY, (err, decoded) => {
            if (err) return console.error("Error decoding multiplayer auth token:", err);
            if (!decoded || !decoded.userId) return console.error("Multiplayer auth token lacks user id.");
            authedMultiplayerClients.set(clientId, Number(decoded.userId)); // Client id -> User id
            authedMultiplayerUserId.set(Number(decoded.userId), clientId); // User id -> Client id
        });
    });
    server.onEvent("clientDisconnected", async (clientId) => {
        if (authedMultiplayerClients.has(clientId)) {
            const userId = authedMultiplayerClients.get(clientId);

            // Remove from maps
            authedMultiplayerClients.delete(clientId);
            authedMultiplayerUserId.delete(userId);

            // Check if user was in an ongoing duel (means they have also not submitted a result)
            const duelUuid = userIdDuelUuid.get(userId);
            if (duelUuid) {
                userIdDuelUuid.delete(userId);
                await processDuelResult(duelUuid, userId); // Process the result > This will fail silently in case the duel was already processed
            }
        }
    });
}

// This only works if the user is authenticated (checked in room submissions)
function checkIfUserIsInRoom(roomId, userId) {
    // Check if room exists and get participants
    const roomParticipants = playSocketServer?.getRooms?.[roomId]?.participants;
    if (!roomParticipants) return false;

    // Get client id for the provided user id
    let clientIdForUserId = authedMultiplayerUserId.get(Number(userId));
    if (clientIdForUserId == null) return false;
    return roomParticipants.includes(clientIdForUserId); // True or false
}

// Add user id to duel room map (in registration)
function addUserToOngoingDuel(userId, uuid) {
    userIdDuelUuid.set(Number(userId), uuid);
}

// If they have sent in their result, they should be removed from here
function removeUserFromOngoingDuel(userId) {
    userIdDuelUuid.delete(Number(userId));
}

module.exports = { attachPlaySocketEvents, checkIfUserIsInRoom, addUserToOngoingDuel, removeUserFromOngoingDuel };