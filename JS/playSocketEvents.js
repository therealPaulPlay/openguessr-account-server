const jwt = require('jsonwebtoken');
const processDuelResult = require('./processDuelResult.js');
const { fetchReportData } = require('./reportFetch.js');
const { getDB } = require('./dbConnection.js');
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

            // Check if user is banned (Async – so do this AFTER the client registration!)
            const banStatus = await fetchReportData("blacklist", "user", "user-" + decoded.userId);
            if (banStatus?.listed) {
                const entry = banStatus?.entry;
                server.kick(clientId, `You are banned from multiplayer for "${entry?.reason}" until ${new Date(entry?.expires_at)?.toLocaleDateString() || "forever"}. Please
                contact the moderators via Discord if you think this was a mistake.`);
            }
        });
    });

    server.onEvent("clientDisconnected", async (clientId, roomId) => {
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

        // Remove disconnected player from room storage
        if (roomId) {
            const players = server.getRoomStorage(roomId)?.players;
            const player = players?.find(p => p[0] === clientId);
            if (player) {
                server.updateRoomStorage(roomId, "players", "array-remove-matching", player);
                server.updateRoomStorage(roomId, "chats", "array-add", `System: ${player?.[1] || "Unknown"} left.`);
            }
        }
    });

    server.onEvent("storageUpdateRequested", ({ clientId, roomId, update }) => {
        if (update.key === 'players') return false; // Block client's 'players' updates
    });

    server.onEvent("roomCreationRequested", ({ clientId, roomId, initialStorage }) => {
        if (initialStorage.players) initialStorage.players = []; // Ensure initial players array is empty
        return initialStorage;
    });

    // Handle requests
    server.onEvent("requestReceived", async ({ roomId, clientId, name, data }) => {
        if (!roomId) return;

        if (name === 'playersAdd') {
            const userId = authedMultiplayerClients.get(clientId);
            const players = server.getRoomStorage(roomId)?.players || [];
            if (players.find(p => p[0] === clientId)) return; // Already exists

            let playerData;
            if (userId) {
                const user = await getUser(userId);
                if (!user) return;
                const teamNumber = data.teamAmount <= 1 ? 1 : ((players.length % data.teamAmount) + 1);
                playerData = [clientId, user.user_name, user.elo, 0, teamNumber, userId, user.badge];
            } else {
                const teamNumber = data.teamAmount <= 1 ? 1 : ((players.length % data.teamAmount) + 1);
                playerData = [clientId, data.guestName || "(No name)", 0, 0, teamNumber, null, null];
            }
            server.updateRoomStorage(roomId, "players", "array-add-unique", playerData);
            server.updateRoomStorage(roomId, "chats", "array-add", `System: ${playerData[1] || "Unknown"} joined.`);
        }

        if (name === 'playersResetScores') {
            const players = server.getRoomStorage(roomId)?.players;
            if (players) {
                const resetPlayers = players.map(p => [...p.slice(0, 3), 0, ...p.slice(4)]);
                server.updateRoomStorage(roomId, "players", "set", resetPlayers);
            }
        }

        if (name === 'playersAddScore') {
            const players = server.getRoomStorage(roomId)?.players;
            const player = players?.find(p => p[0] === clientId);
            if (player && typeof data === 'number') {
                const newPlayer = [...player];
                newPlayer[3] += data;
                server.updateRoomStorage(roomId, "players", "array-update-matching", player, newPlayer);
            }
        }

        if (name === 'playersUpdateTeam') {
            const players = server.getRoomStorage(roomId)?.players;
            const player = players?.find(p => p[0] === data.playerClientId);
            if (player && typeof data.newTeamIndex === 'number') {
                const newPlayer = [...player];
                newPlayer[4] = data.newTeamIndex; // Update team at position 4
                server.updateRoomStorage(roomId, "players", "array-update-matching", player, newPlayer);
            }
        }
    });
}

async function getUser(userId) {
    const db = getDB();
    const [rows] = await db.promise().execute(`
        SELECT u.user_name, u.elo, p.badge 
        FROM users u LEFT JOIN profile_data p ON u.id = p.user_id 
        WHERE u.id = ?`, [userId]);
    return rows[0];
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
    if (clientIdDuelUuid.get(clientId)) throw new Error("Your PlaySocket client is already in an ongoing duel!");
    clientIdDuelUuid.set(clientId, uuid);
}

// If they have sent in their result, they should be removed from here
function removeUserFromOngoingDuel(userId) {
    const clientId = authedMultiplayerUserId.get(Number(userId));
    clientIdDuelUuid.delete(clientId);
}

module.exports = { attachPlaySocketEvents, checkIfUserIsInRoom, addUserToOngoingDuel, removeUserFromOngoingDuel };