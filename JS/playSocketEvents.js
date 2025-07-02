const jwt = require('jsonwebtoken');
const processDuelResult = require('./processDuelResult.js');
const { fetchReportData } = require('./reportFetch.js');
const SECRET_KEY = require("./config.js").jwtSecret;

const authedMultiplayerClients = new Map(); // Client Id (from PlaySocket) -> User id
const authedMultiplayerUserId = new Map(); // User id -> client id
let playSocketServer;

// Duel rooms
const clientIdDuelUuid = new Map(); // Client id -> Active duel uuid (active = no result submited yet)

function attachPlaySocketEvents(server) {
    playSocketServer = server; // Assign server

    server.onEvent("clientRegistered", (clientId, data) => {
        if (!data?.bearer) return;
        jwt.verify(data.bearer, SECRET_KEY, async (err, decoded) => {
            if (err) return console.error("Error decoding multiplayer auth token:", err);
            if (!decoded || !decoded.userId) return console.error("Multiplayer auth token lacks user id.");

            authedMultiplayerClients.set(clientId, Number(decoded.userId)); // Client id -> User id
            authedMultiplayerUserId.set(Number(decoded.userId), clientId); // User id -> Client id

            // Check if user is banned (Async – so do this AFTER the client registration!)
            const banStatus = await fetchReportData("blacklist", "user", "user-" + decoded.userId);
            if (banStatus?.listed) {
                const entry = banStatus?.entry;
                server.kick(clientId, `You are banned from multiplayer for "${entry?.reason}" until ${new Date(entry?.expires_at)?.toLocaleDateString() || "forever"}. Please
                contact the moderators via Discord if you think this was a mistake.`);
            }
        });
    });

    server.onEvent("clientDisconnected", async (clientId) => {
        if (authedMultiplayerClients.has(clientId)) {

            // Get user id and check if the user was in an ongoing duel (means they have not submitted a result)
            const userId = authedMultiplayerClients.get(clientId);
            const duelUuid = clientIdDuelUuid.get(clientId);

            // Only remove from userId map if this is the current client for this user
            const currentClientForUser = authedMultiplayerUserId.get(userId);
            if (currentClientForUser == clientId) authedMultiplayerUserId.delete(userId);

            // Always remove from client maps
            authedMultiplayerClients.delete(clientId);
            clientIdDuelUuid.delete(clientId);

            // Process the result if in ongoing duel > This will fail silently if already processed
            if (duelUuid && userId != null) await processDuelResult(duelUuid, userId);
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
    const clientId = authedMultiplayerUserId.get(Number(userId));
    if (!clientId) throw new Error("Your PlaySocket client is not authenticated!");
    clientIdDuelUuid.set(clientId, uuid);
}

// If they have sent in their result, they should be removed from here
function removeUserFromOngoingDuel(userId) {
    const clientId = authedMultiplayerUserId.get(Number(userId));
    clientIdDuelUuid.delete(clientId);
}

module.exports = { attachPlaySocketEvents, checkIfUserIsInRoom, addUserToOngoingDuel, removeUserFromOngoingDuel };