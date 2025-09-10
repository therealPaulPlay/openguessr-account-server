import jwt from 'jsonwebtoken';
import { fetchReportData } from './reportFetch.js';
import { getDB } from './dbConnection.js';
import { roomTimer } from './roomTimer.js';
import saveDuelResult from './processDuelResult.js';
import { jwtSecret as SECRET_KEY } from "./config.js";
import { getLocations } from './locations.js';

const authedMultiplayerClients = new Map(); // Client Id (from PlaySocket) -> User id
const authedMultiplayerUserId = new Map(); // User id -> client id

let playSocketServer;

function attachPlaySocketEvents(server) {
    playSocketServer = server; // Assign server

    server.onEvent("clientRegistrationRequested", async (clientId, data) => {
        if (!data?.bearer) return;

        try {
            const decoded = await new Promise((resolve, reject) => {
                jwt.verify(data.bearer, SECRET_KEY, (err, decoded) => {
                    if (err) reject(err);
                    else resolve(decoded);
                });
            });
            if (!decoded?.userId) return "The authentication token lacks a user ID.";
            const userId = Number(decoded.userId);

            // Fetch OpenReport status
            const banStatus = await fetchReportData("blacklist", "user", "user-" + userId);
            if (banStatus?.listed) return `You are banned for "${banStatus?.entry?.reason}" until ${new Date(banStatus?.entry?.expires_at)?.toLocaleDateString() || "forever"}. Please contact the moderators via Discord for help.`;

            // Store auth mapping after successful validation
            authedMultiplayerClients.set(clientId, userId); // Client id -> User id
            authedMultiplayerUserId.set(userId, clientId); // User id -> Client id

        } catch (error) {
            return "An error occured decoding your authentication token.";
        }
    });

    server.onEvent("clientDisconnected", async (clientId, roomId) => {
        if (roomId) {
            const players = server.getRoomStorage(roomId)?.players;
            const player = players?.find(p => p[0] === clientId);
            if (player) {
                // Remove disconnected player from room storage
                server.updateRoomStorage(roomId, "players", "array-remove-matching", player);
                server.updateRoomStorage(roomId, "chats", "array-add", `System: ${player?.[1] || "Unknown"} left.`);
                server.updateRoomStorage(roomId, "highestSupporterLevel", "set", determineHighestSupporterLevel(roomId));
            }
        }

        if (authedMultiplayerClients.has(clientId)) {
            const userId = authedMultiplayerClients.get(clientId);

            // Only remove from user ID -> client ID map if this is the current/latest client from this user
            const currentClientForUser = authedMultiplayerUserId.get(userId);
            if (currentClientForUser == clientId) authedMultiplayerUserId.delete(userId);

            // Always remove from client -> user ID maps
            authedMultiplayerClients.delete(clientId);

            // Process the result if in ongoing duel
            if (userId && roomId && !server.getRoomStorage(roomId).duelProcessed && server.getRoomStorage(roomId).gameStarted && server.getRoomStorage(roomId).divisionRoom) {
                const players = server.getRoomStorage(roomId).players;

                // If one other player is still in the room, that means this client left first and should lose!
                if (players.length === 1) {
                    const otherPlayer = players[0];
                    const otherPlayerUserId = otherPlayer[5];
                    if (otherPlayerUserId != null) {
                        server.updateRoomStorage(roomId, "duelProcessed", "set", true);
                        saveDuelResult(server.getRoomStorage(roomId).duelUuid, otherPlayerUserId, userId);
                    }
                }
            }
        }
    });

    server.onEvent("clientJoinRequested", (clientId, roomId) => {
        if (server.getRoomStorage(roomId)?.divisionRoom && !authedMultiplayerClients.has(clientId)) return "You need to be authenticated to participate in a division game.";
    });

    server.onEvent("storageUpdateRequested", ({ clientId, roomId, update }) => {
        if (update.key === 'players') return false; // Block client's 'players' updates

        // Block room configuration updates
        if (update.key === "roundAmount" || update.key === "style" || update.key === "roundLength" || update.key === "restriction") return false;
        if (update.key === "category") return false;
        if (update.key === "duelUuid") return false;
        if (update.key === "divisionRoom") return false;
        if (update.key === "duelProcessed") return false;

        // Block server-side-only game control updates
        if (update.key === "countdownActive") return false;
        if (update.key === "currentRound") return false;
        if (update.key === "firstRoundPlayed") return false;
        if (update.key === "gameStarted") return false;
        if (update.key === "gameEnded") return false;
        if (update.key === "timeReducedOverlay") return false;
        if (update.key === "guessLocationsArray") return false;
        if (update.key === "highestSupporterLevel") return false;
        if (update.key === "confirmedArray") return false;
        if (update.key === "timerStart") return false;
        if (update.key === "overlay") return false;
        if (update.key === "location") return false;
        if (update.key === "mapBounds") return false;

        // Restrict updates
        if (update.key === "chats" && (update.operation.data.type !== "array-add" || !update.operation.data.value?.startsWith(server.getRoomStorage(roomId).players?.find((e) => e[0] === clientId)?.[1]))) return false;
        if (update.key === "showResult" && (update.operation.data.type !== "set" || update.operation.data.value !== false)) return false;
    });

    server.onEvent("storageUpdated", ({ clientId, roomId, update, storage }) => {
        if (update.key === "showResult" && update.operation.data.value === false) {
            server.updateRoomStorage(roomId, "guessLocationsArray", "set", []); // Reset guesses
            server.updateRoomStorage(roomId, "overlay", "set", true);

            // Check if this is a division room that has ended and hasn't been processed yet
            if (storage.divisionRoom && storage.gameEnded && !storage.duelProcessed) {
                const players = storage.players;
                const sortedPlayers = players?.sort((a, b) => b[3] - a[3]);
                const winner = sortedPlayers?.[0];
                const loser = sortedPlayers?.[1];
                const isDraw = winner?.[3] == loser?.[3];

                if (winner && loser) {
                    // Mark as processed immediately to prevent duplicate processing
                    server.updateRoomStorage(roomId, "duelProcessed", "set", true);
                    saveDuelResult(storage.duelUuid, winner[5], loser[5], isDraw);
                }
            }

            if (!storage.gameEnded) {
                setTimeout(() => {
                    startRound(roomId);
                }, storage.currentRound === 0 ? 0 : 1500);
            }
        }
    });

    server.onEvent("roomCreationRequested", ({ clientId, roomId, initialStorage }) => {
        if (typeof initialStorage.roundAmount !== "number" || initialStorage.roundAmount < 2 || initialStorage.roundAmount > 10) initialStorage.roundAmount = 3;
        if (typeof initialStorage.roundLength !== "number" || initialStorage.roundLength < 10 || initialStorage.roundLength > 300) initialStorage.roundLength = 60;
        if (typeof initialStorage.teamAmount !== "number" || initialStorage.teamAmount > 10 || initialStorage.teamAmount < 0) initialStorage.teamAmount = 1;
        if (!["standard", "duel"].includes(initialStorage.style)) initialStorage.style = "standard";
        if (typeof initialStorage.highestSupporterLevel !== "number" || initialStorage.highestSupporterLevel > 4 || initialStorage.highestSupporterLevel < 0) initialStorage.highestSupporterLevel = 0;
        if (!["standard", "nmpz", "grayscale", "invert", "hue", "fade"].includes(initialStorage.restriction)) initialStorage.restriction = "standard";
        if (typeof initialStorage.category !== "string") initialStorage.category = "standard";
        initialStorage.players = []; // Ensure initial players array is empty
        initialStorage.currentRound = 0;
        initialStorage.location = [35.7072457, 139.863412]; // Default panorama to prevent blackscreen
        initialStorage.guessLocationsArray = []; // Guesses from players (with location data)
        initialStorage.confirmedArray = []; // Client IDs that have confirmed their guess
        initialStorage.duelUuid = crypto.randomUUID();
        initialStorage.firstRoundPlayed = false; // Resets with rematch
        initialStorage.chats = [];
        initialStorage.overlay = true;
        initialStorage.timeReducedOverlay = false; // Duel "Opponent has guessed" overlay
        initialStorage.showResult = false;
        initialStorage.gameStarted = false; // Stays always true after the initial start
        initialStorage.gameEnded = false;
        initialStorage.countdownActive = false;
        initialStorage.timerStart = false;
        initialStorage.duelProcessed = false;
        initialStorage.location = null;
        initialStorage.mapBounds = null;

        return initialStorage;
    });

    // Handle requests
    server.onEvent("requestReceived", async ({ roomId, clientId, name, data }) => {
        if (!roomId) return;

        if (name === 'addPlayer') {
            const userId = authedMultiplayerClients.get(clientId);
            const players = server.getRoomStorage(roomId)?.players || [];
            const teamAmount = server.getRoomStorage(roomId)?.teamAmount;
            if (players.find(p => p[0] === clientId)) return; // First check if already exists

            let playerData;

            if (userId) {
                const user = await getUser(userId);
                if (!user) return;
                const teamNumber = teamAmount <= 1 ? 1 : ((players.length % teamAmount) + 1);
                playerData = [clientId, user.user_name, user.elo, 0, teamNumber, userId, user.badge, user.pin, user.supporter_level];
            } else {
                const teamNumber = teamAmount <= 1 ? 1 : ((players.length % teamAmount) + 1);
                playerData = [clientId, data.guestName || "(No name)", 0, 0, teamNumber, null, null, 0, 0];
            }
            if (players.find(p => p[0] === clientId)) return; // Second check if already exists to prevent race conditions
            server.updateRoomStorage(roomId, "players", "array-add-unique", playerData);
            server.updateRoomStorage(roomId, "chats", "array-add", `System: ${playerData[1] || "Unknown"} joined.`);
            server.updateRoomStorage(roomId, "highestSupporterLevel", "set", determineHighestSupporterLevel(roomId));
        }

        if (name === 'addToScore') {
            const storage = server.getRoomStorage(roomId);
            const players = storage?.players;
            const player = players?.find(p => p[0] === clientId);
            if (player && typeof data === 'number') {
                if (storage?.style == "duel" && storage?.currentRound >= 4) data = Math.round(data * 1.5); // Duel multiplier for last 2 rounds
                const newPlayer = [...player];
                newPlayer[3] += data;
                server.updateRoomStorage(roomId, "players", "array-update-matching", player, newPlayer);
            }
        }

        if (name === 'updateTeam') {
            const players = server.getRoomStorage(roomId)?.players;
            const player = players?.find(p => p[0] === data.playerClientId);
            if (player && typeof data.newTeamIndex === 'number') {
                const newPlayer = [...player];
                newPlayer[4] = data.newTeamIndex; // Update team at position 4
                server.updateRoomStorage(roomId, "players", "array-update-matching", player, newPlayer);
            }
        }

        if (name === 'startRoom') {
            if (clientId === server.getRooms[roomId]?.host && !server.getRoomStorage(roomId).gameStarted) {
                server.updateRoomStorage(roomId, "gameStarted", "set", true);
                startRound(roomId);
            };
        }

        if (name === 'confirmGuess') {
            server.updateRoomStorage(roomId, "confirmedArray", "array-add-unique", clientId);

            // Time reduced overlay
            const remainingTimerTime = server.getRoomStorage(roomId).timerStart?.length * 1000 - (Date.now() - server.getRoomStorage(roomId).timerStart?.timestamp); // In ms
            if (server.getRoomStorage(roomId).style === "duel" && server.getRoomStorage(roomId).confirmedArray?.length === 1 && remainingTimerTime > 3000) {
                server.updateRoomStorage(roomId, "timeReducedOverlay", "set", true);
                if (remainingTimerTime > 15000) {
                    server.updateRoomStorage(roomId, "timerStart", "set", { timestamp: Date.now(), length: 15 }); // Reduce timer to 15s if it has longer than that remaining
                    roomTimer.adjust(roomId, 15000);
                }
                setTimeout(() => {
                    server.updateRoomStorage(roomId, "timeReducedOverlay", "set", false); // Wait shortly, hide overlay
                }, 2000);
            }

            // Check if all guesses are in (which immediately ends the round)
            if (server.getRoomStorage(roomId)?.confirmedArray?.length >= server.getRoomStorage(roomId)?.players?.length && !server.getRoomStorage(roomId)?.showResult) {
                roomTimer.stop(roomId);
                endRound(roomId);
            }
        }

        if (name === 'rematch') {
            if (clientId !== server.getRooms[roomId]?.host || server.getRoomStorage(roomId)?.divisionRoom) return; // Only allow host to rematch & prevent rematch in division games
            if (server.getRoomStorage(roomId)?.gameEnded) {
                server.updateRoomStorage(roomId, "gameEnded", "set", false);
                server.updateRoomStorage(roomId, "firstRoundPlayed", "set", false);
                server.updateRoomStorage(roomId, "currentRound", "set", 0);

                // Reset scores
                const players = server.getRoomStorage(roomId)?.players;
                if (players) {
                    const resetPlayers = players.map(p => [...p.slice(0, 3), 0, ...p.slice(4)]);
                    server.updateRoomStorage(roomId, "players", "set", resetPlayers);
                }

                // Generate round
                startRound(roomId);
            }
        }

        if (name === 'addGuessMarker') {
            if (typeof data.lat === "number" && typeof data.lon === "number") {
                const existingMarkerElement = server.getRoomStorage(roomId)?.guessLocationsArray?.find((e) => e.id === clientId);
                if (existingMarkerElement) server.updateRoomStorage(roomId, "guessLocationsArray", "array-remove-matching", existingMarkerElement)
                const player = server.getRoomStorage(roomId).players?.find((e) => e[0] === clientId);
                if (player) server.updateRoomStorage(roomId, "guessLocationsArray", "array-add-unique", { id: clientId, lat: data.lat, lon: data.lon, username: player[1], pin: player[7], team: player[4] });
            }
        }
    });

    server.onEvent("roomDestroyed", (roomId) => {
        roomTimer.stop(roomId);
    });

    function determineHighestSupporterLevel(roomId) {
        const players = server.getRoomStorage(roomId)?.players;
        let highestSupporterLevel = 0;

        players?.forEach((e) => {
            const supporterLevel = e[8];
            if (supporterLevel > highestSupporterLevel) highestSupporterLevel = supporterLevel;
        });
        return highestSupporterLevel;
    }

    async function startRound(roomId) {
        const mapCategory = server.getRoomStorage(roomId).category;
        const data = await getLocations(mapCategory, 1, roomId); // Use room ID for key that ensures no duplicates
        const location = data?.locations?.[0];
        const bounds = data?.bounds;

        server.updateRoomStorage(roomId, "mapBounds", "set", bounds); // Set this before location!
        server.updateRoomStorage(roomId, "location", "set", location);
        server.updateRoomStorage(roomId, "countdownActive", "set", true);
        server.updateRoomStorage(roomId, "currentRound", "set", (server.getRoomStorage(roomId).currentRound || 0) + 1);
        server.updateRoomStorage(roomId, "chats", "array-add", `System: Starting round ${server.getRoomStorage(roomId).currentRound}.`);

        // After countdown, start timer
        setTimeout(() => {
            if (!server.getRoomStorage(roomId)) return; // If the room no longer exists, return
            server.updateRoomStorage(roomId, "countdownActive", "set", false);
            server.updateRoomStorage(roomId, "overlay", "set", false);
            if (!server.getRoomStorage(roomId).firstRoundPlayed) server.updateRoomStorage(roomId, "firstRoundPlayed", "set", true);

            // Timer information for clients
            server.updateRoomStorage(roomId, "timerStart", "set", { timestamp: Date.now(), length: server.getRoomStorage(roomId).roundLength });

            // Server-side timer (+1s delayed to ensure all clients have their timers finished)
            roomTimer.set(roomId, server.getRoomStorage(roomId).roundLength * 1000, () => {
                endRound(roomId);
            });
        }, 4000);
    }

    function endRound(roomId) {
        server.updateRoomStorage(roomId, "timerStart", "set", null);
        server.updateRoomStorage(roomId, "timeReducedOverlay", "set", false);

        // If any players have no guess submitted, add 0, 0 as the guess
        const players = server.getRoomStorage(roomId)?.players;
        const guessArray = server.getRoomStorage(roomId)?.guessLocationsArray;
        players?.forEach((p) => {
            const correspondingGuess = guessArray?.find((g) => (g.id === p[0]));
            if (!correspondingGuess) guessArray.push({ id: p[0], lat: 0, lon: 0, username: p[1], pin: p[7], team: p[4] });
        });
        server.updateRoomStorage(roomId, "guessLocationsArray", "set", guessArray);

        server.updateRoomStorage(roomId, "showResult", "set", true);
        server.updateRoomStorage(roomId, "confirmedArray", "set", []);

        // Check if the game is over (Note that clients will send in addToScore requests AFTER this)
        if (server.getRoomStorage(roomId)?.roundAmount === server.getRoomStorage(roomId)?.currentRound) server.updateRoomStorage(roomId, "gameEnded", "set", true);
    }
}

async function getUser(userId) {
    const db = getDB();
    const [rows] = await db.promise().execute(`
        SELECT u.user_name, u.elo, u.supporter_level, p.badge, p.pin
        FROM users u LEFT JOIN profile_data p ON u.id = p.user_id 
        WHERE u.id = ?`, [userId]);
    return rows[0];
}

function checkIfUserIsAuthedAndInRoom(roomId, userId) {
    // Check if room exists and get participants
    const roomParticipants = playSocketServer?.getRooms?.[roomId]?.participants;
    if (!roomParticipants) return false;

    // Get client id for the provided user id
    let clientIdForUserId = authedMultiplayerUserId.get(Number(userId));
    if (clientIdForUserId == null) return false;
    return roomParticipants.includes(clientIdForUserId); // True or false
}

function validateRoomSettings(roomId) {
    if (!playSocketServer.getRoomStorage(roomId)?.divisionRoom) return false;
    if (playSocketServer.getRoomStorage(roomId)?.style !== "duel") return false;
    if (playSocketServer.getRooms[roomId?.maxSize !== 2]) return false;
    return true;
}

export { attachPlaySocketEvents, checkIfUserIsAuthedAndInRoom, validateRoomSettings };