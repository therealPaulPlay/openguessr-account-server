import jwt from 'jsonwebtoken';
import { fetchReportData } from './reportFetch.js';
import { getDB } from './dbConnection.js';
import { roomTimer } from './roomTimer.js';
import saveDuelResult from './processDuelResult.js';
import { jwtSecret as SECRET_KEY } from "./config.js";
import { getLocations } from './locations.js';
import PlaySocketServer from 'playsocketjs/server';
import { processTournamentMatchResults } from './tournaments.js';

export let playSocketServer;

export async function initPlaySocket(httpServer) {
    playSocketServer = new PlaySocketServer({
        server: httpServer,
        path: '/socket'
    });
    attachPlaySocketEvents(playSocketServer); // Attach events AFTER initialization
}

const authedMultiplayerClients = new Map(); // Client Id (from PlaySocket) -> User id
export const authedMultiplayerUserId = new Map(); // User id -> client id

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
            const player = players?.find(p => p.clientId === clientId);
            if (player) {
                // Remove disconnected player from room storage
                server.updateRoomStorage(roomId, "players", "array-remove-matching", player);
                server.updateRoomStorage(roomId, "chats", "array-add", `System: ${player?.username || "Unknown"} left.`);
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

            // Process the result if in ongoing duel room
            if (userId && server.getRooms[roomId] && !server.getRoomStorage(roomId).duelProcessed && server.getRoomStorage(roomId).gameStarted && server.getRoomStorage(roomId).divisionRoom) {
                const players = server.getRoomStorage(roomId).players;

                // If one other player is still in the room, that means this client left first and should lose!
                if (players.length === 1) {
                    const otherPlayerUserId = players[0]?.userId;
                    if (otherPlayerUserId != null) {
                        server.updateRoomStorage(roomId, "duelProcessed", "set", true);
                        saveDuelResult(server.getRoomStorage(roomId).duelUuid, otherPlayerUserId, userId);
                    }
                }
            }
        }
    });

    server.onEvent("clientJoinRequested", (clientId, roomId) => {
        if ((server.getRoomStorage(roomId)?.divisionRoom || server.getRoomStorage(roomId)?.tournamentRoom) && !authedMultiplayerClients.has(clientId)) return "You need to be authenticated to participate in this game.";
        if (server.getRoomStorage(roomId)?.locked) return "This room is locked.";
    });

    server.onEvent("storageUpdateRequested", ({ clientId, roomId, update, storage }) => {
        if (update.key === 'players') return false; // Block client's 'players' updates

        // Block room configuration updates
        if (update.key === "roundAmount" || update.key === "style" || update.key === "roundLength" || update.key === "restriction") return false;
        if (update.key === "category") return false;
        if (update.key === "duelUuid") return false;
        if (update.key === "divisionRoom") return false;
        if (update.key === "tournamentRoom") return false;
        if (update.key === "tournamentId") return false;
        if (update.key === "duelProcessed") return false;

        // Block server-side-only game control updates
        if (update.key === "countdownActive") return false;
        if (update.key === "currentRound") return false;
        if (update.key === "firstRoundPlayed") return false;
        if (update.key === "gameStarted") return false;
        if (update.key === "gameEnded") return false;
        if (update.key === "matchIndex") return false;
        if (update.key === "timeReducedOverlay") return false;
        if (update.key === "guessLocationsArray") return false;
        if (update.key === "highestSupporterLevel") return false;
        if (update.key === "confirmedArray") return false;
        if (update.key === "timerStart") return false;
        if (update.key === "overlay") return false;
        if (update.key === "location") return false;
        if (update.key === "mapBounds") return false;
        if (update.key === "locked") return false;

        // Restrict updates
        if (update.key === "chats" && (update.operation.data.type !== "array-add" || !update.operation.data.value?.startsWith(server.getRoomStorage(roomId).players?.find((e) => e.clientId === clientId)?.username))) return false;
        if (update.key === "showResult" && (update.operation.data.type !== "set" || update.operation.data.value !== false)) return false;

        // React to update before it has happened & ensure showResult was previously true (and not already false)
        if (update.key === "showResult" && update.operation.data.value === false && storage.showResult === true) {
            server.updateRoomStorage(roomId, "guessLocationsArray", "set", []); // Reset guesses
            server.updateRoomStorage(roomId, "overlay", "set", true);

            // Check if this is a division room that has ended and hasn't been processed yet
            if (storage.gameEnded) {
                if (storage.divisionRoom && !storage.duelProcessed) {
                    const players = storage.players;
                    const sortedPlayers = players?.sort((a, b) => b.score - a.score);
                    const winner = sortedPlayers?.[0];
                    const loser = sortedPlayers?.[1];
                    const isDraw = winner?.score == loser?.score;

                    if (winner && loser) {
                        // Mark as processed immediately to prevent duplicate processing
                        server.updateRoomStorage(roomId, "duelProcessed", "set", true);
                        saveDuelResult(storage.duelUuid, winner.userId, loser.userId, isDraw);
                    }
                }

                // Tournament match evaluation
                if (storage.tournamentRoom) processTournamentMatchResults(roomId, storage.tournamentId);

            } else {
                // If the game has not ended, continue with next round
                setTimeout(() => {
                    startRound(roomId);
                }, storage.currentRound === 0 ? 0 : 1500);
            }
        }
    });

    server.onEvent("roomCreationRequested", ({ clientId, initialStorage }) => {
        if (typeof initialStorage.roundAmount !== "number" || initialStorage.roundAmount < 2 || initialStorage.roundAmount > 10) initialStorage.roundAmount = 3;
        if (typeof initialStorage.roundLength !== "number" || initialStorage.roundLength < 10 || initialStorage.roundLength > 300) initialStorage.roundLength = 60;
        if (typeof initialStorage.teamAmount !== "number" || initialStorage.teamAmount > 10 || initialStorage.teamAmount < 0) initialStorage.teamAmount = 1;
        if (!["standard", "duel"].includes(initialStorage.style)) initialStorage.style = "standard";
        if (typeof initialStorage.highestSupporterLevel !== "number" || initialStorage.highestSupporterLevel > 4 || initialStorage.highestSupporterLevel < 0) initialStorage.highestSupporterLevel = 0;
        if (!["standard", "nmpz", "grayscale", "invert", "hue", "fade"].includes(initialStorage.restriction)) initialStorage.restriction = "standard";
        if (typeof initialStorage.category !== "string") initialStorage.category = "standard";
        if (typeof initialStorage.divisionRoom !== "boolean" || clientId !== "server") initialStorage.divisionRoom = false;
        if (typeof initialStorage.tournamentRoom !== "boolean" || clientId !== "server") initialStorage.tournamentRoom = false;
        if (clientId !== "server") initialStorage.tournamentId = null;
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
        initialStorage.matchIndex = 0;
        initialStorage.countdownActive = false;
        initialStorage.timerStart = false;
        initialStorage.duelProcessed = false;
        initialStorage.location = null;
        initialStorage.mapBounds = null;
        initialStorage.locked = false;

        return initialStorage;
    });

    // Handle requests
    server.onEvent("requestReceived", async ({ roomId, clientId, name, data }) => {
        if (!roomId) return;

        if (name === 'addPlayer') {
            const userId = authedMultiplayerClients.get(clientId);
            const players = server.getRoomStorage(roomId)?.players || [];
            const teamAmount = server.getRoomStorage(roomId)?.teamAmount;
            if (players.find(p => p.clientId === clientId)) return; // First check if already exists

            let playerData;

            if (userId) {
                const user = await getUser(userId);
                if (!user) return;
                const teamIndex = teamAmount <= 1 ? 1 : ((players.length % teamAmount) + 1);
                playerData = { clientId, username: user.user_name, elo: user.elo, score: 0, teamIndex, userId, badge: user.badge, pin: user.pin, supporterLevel: user.supporter_level, spectator: false };
            } else {
                const teamIndex = teamAmount <= 1 ? 1 : ((players.length % teamAmount) + 1);
                playerData = { clientId, username: data.guestName || "(No name)", elo: 0, score: 0, teamIndex, userId: null, badge: null, pin: 0, supporterLevel: 0, spectator: false };
            }
            if (players.find(p => p.clientId === clientId)) return; // Second check if already exists to prevent race conditions
            server.updateRoomStorage(roomId, "players", "array-add-unique", playerData);
            server.updateRoomStorage(roomId, "chats", "array-add", `System: ${playerData.username || "Unknown"} joined.`);
            server.updateRoomStorage(roomId, "highestSupporterLevel", "set", determineHighestSupporterLevel(roomId));
        }

        if (name === 'addToScore') {
            const storage = server.getRoomStorage(roomId);
            const players = storage?.players;
            const player = players?.find(p => p.clientId === clientId);
            if (player && typeof data === 'number') {
                if (storage?.style == "duel" && storage?.currentRound >= 4) data = Math.round(data * 1.5); // Duel multiplier for last 2 rounds
                const newPlayer = { ...player };
                newPlayer.score += data;
                server.updateRoomStorage(roomId, "players", "array-update-matching", player, newPlayer);
            }
        }

        if (name === 'updateTeam') {
            const players = server.getRoomStorage(roomId)?.players;
            const player = players?.find(p => p.clientId === data.playerClientId);
            if (player && typeof data.newTeamIndex === 'number') {
                const newPlayer = { ...player };
                newPlayer.teamIndex = data.newTeamIndex; // Update team at position 4
                server.updateRoomStorage(roomId, "players", "array-update-matching", player, newPlayer);
            }
        }

        if (name === 'startRoom') {
            if (clientId === server.getRooms[roomId]?.host && !server.getRoomStorage(roomId).gameStarted) startRoom(roomId);
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

                // Wait shortly, hide overlay
                setTimeout(() => {
                    try {
                        server.updateRoomStorage(roomId, "timeReducedOverlay", "set", false);
                    } catch (error) {
                        console.error(`Error hiding timeReducedOverlay:`, error);
                    }
                }, 2000);
            }

            // Check if all guesses are in (which immediately ends the round)
            if (server.getRoomStorage(roomId)?.confirmedArray?.length >= server.getRoomStorage(roomId)?.players?.length && !server.getRoomStorage(roomId)?.showResult) {
                roomTimer.stop(roomId);
                endRound(roomId);
            }
        }

        if (name === 'rematch') {
            if (clientId !== server.getRooms[roomId]?.host || server.getRoomStorage(roomId)?.divisionRoom || server.getRoomStorage(roomId)?.tournamentRoom) return; // Only allow host to rematch & prevent rematch in division games or tournaments
            if (server.getRoomStorage(roomId)?.gameEnded) rematch(roomId);
        }

        if (name === 'addGuessMarker') {
            if (typeof data.lat === "number" && typeof data.lon === "number") {
                const existingMarkerElement = server.getRoomStorage(roomId)?.guessLocationsArray?.find((e) => e.id === clientId);
                if (existingMarkerElement) server.updateRoomStorage(roomId, "guessLocationsArray", "array-remove-matching", existingMarkerElement)
                const player = server.getRoomStorage(roomId).players?.find((e) => e.clientId === clientId);
                if (player) server.updateRoomStorage(roomId, "guessLocationsArray", "array-add-unique", { id: clientId, lat: data.lat, lon: data.lon, username: player.username, pin: player.pin, team: player.teamIndex });
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
            const supporterLevel = e.supporterLevel;
            if (supporterLevel > highestSupporterLevel) highestSupporterLevel = supporterLevel;
        });
        return highestSupporterLevel;
    }
}

export function rematch(roomId) {
    try {
        playSocketServer.updateRoomStorage(roomId, "gameEnded", "set", false);
        playSocketServer.updateRoomStorage(roomId, "firstRoundPlayed", "set", false);
        playSocketServer.updateRoomStorage(roomId, "currentRound", "set", 0);
        playSocketServer.updateRoomStorage(roomId, "matchIndex", "set", playSocketServer.getRoomStorage(roomId).matchIndex + 1);

        // Reset scores
        const players = playSocketServer.getRoomStorage(roomId)?.players;
        if (players) {
            const resetPlayers = players.map(p => ({ ...p, score: 0 }));
            playSocketServer.updateRoomStorage(roomId, "players", "set", resetPlayers);
        }

        // Generate round
        startRound(roomId);
    } catch (error) {
        console.error("Failed to rematch:", error);
    }
}

export async function startRoom(roomId) {
    playSocketServer.updateRoomStorage(roomId, "gameStarted", "set", true);
    startRound(roomId);
}

function endRound(roomId) {
    try {
        playSocketServer.updateRoomStorage(roomId, "timerStart", "set", null);
        playSocketServer.updateRoomStorage(roomId, "timeReducedOverlay", "set", false);

        // If any players have no guess submitted, add 0, 0 as the guess
        const players = playSocketServer.getRoomStorage(roomId)?.players;
        const guessArray = playSocketServer.getRoomStorage(roomId)?.guessLocationsArray;
        players?.forEach((p) => {
            const correspondingGuess = guessArray?.find((g) => (g.id === p.clientId));
            if (!correspondingGuess) guessArray.push({ id: p.clientId, lat: 0, lon: 0, username: p.username, pin: p.pin, team: p.teamIndex });
        });
        playSocketServer.updateRoomStorage(roomId, "guessLocationsArray", "set", guessArray);

        playSocketServer.updateRoomStorage(roomId, "showResult", "set", true);
        playSocketServer.updateRoomStorage(roomId, "confirmedArray", "set", []);

        // Check if the game is over (Note that clients will send in addToScore requests AFTER this)
        if (playSocketServer.getRoomStorage(roomId)?.roundAmount === playSocketServer.getRoomStorage(roomId)?.currentRound) playSocketServer.updateRoomStorage(roomId, "gameEnded", "set", true);

    } catch (error) {
        console.error("Error ending round:", error);
    }
}

async function startRound(roomId) {
    try {
        const mapCategory = playSocketServer.getRoomStorage(roomId).category;
        const data = await getLocations(mapCategory, 1, roomId); // Use room ID for key that ensures no duplicates
        const location = data?.locations?.[0];
        const bounds = data?.bounds;

        playSocketServer.updateRoomStorage(roomId, "mapBounds", "set", bounds); // Set this before location!
        playSocketServer.updateRoomStorage(roomId, "location", "set", location);
        playSocketServer.updateRoomStorage(roomId, "countdownActive", "set", true);
        playSocketServer.updateRoomStorage(roomId, "currentRound", "set", (playSocketServer.getRoomStorage(roomId).currentRound || 0) + 1);
        playSocketServer.updateRoomStorage(roomId, "chats", "array-add", `System: Starting round ${playSocketServer.getRoomStorage(roomId).currentRound}.`);
    } catch (error) {
        console.error("Error starting round:", error);
    }

    // After countdown, start timer
    setTimeout(() => {
        try {
            if (!playSocketServer.getRooms[roomId]) return; // If the room no longer exists, return
            playSocketServer.updateRoomStorage(roomId, "countdownActive", "set", false);
            playSocketServer.updateRoomStorage(roomId, "overlay", "set", false);
            if (!playSocketServer.getRoomStorage(roomId).firstRoundPlayed) playSocketServer.updateRoomStorage(roomId, "firstRoundPlayed", "set", true);

            // Timer information for clients
            playSocketServer.updateRoomStorage(roomId, "timerStart", "set", { timestamp: Date.now(), length: playSocketServer.getRoomStorage(roomId).roundLength });

            // Server-side timer (+1s delayed to ensure all clients have their timers finished)
            roomTimer.set(roomId, playSocketServer.getRoomStorage(roomId).roundLength * 1000, () => {
                endRound(roomId);
            });
        } catch (error) {
            console.error("Error in timeout within round start:", error);
        }
    }, 4000);
}

async function getUser(userId) {
    const db = getDB();
    const [rows] = await db.promise().execute(`
        SELECT u.user_name, u.elo, u.supporter_level, p.badge, p.pin
        FROM users u LEFT JOIN profile_data p ON u.id = p.user_id 
        WHERE u.id = ?`, [userId]);
    return rows[0];
}

export function checkIfUserIsAuthedAndInRoom(roomId, userId) {
    // Check if room exists and get participants
    const roomParticipants = playSocketServer?.getRooms?.[roomId]?.participants;
    if (!roomParticipants) return false;

    // Get client id for the provided user id
    let clientIdForUserId = authedMultiplayerUserId.get(Number(userId));
    if (clientIdForUserId == null) return false;
    return roomParticipants.includes(clientIdForUserId); // True or false
}

export function validateRoomSettings(roomId) {
    if (!playSocketServer.getRoomStorage(roomId)?.divisionRoom) return false;
    if (playSocketServer.getRoomStorage(roomId)?.style !== "duel") return false;
    if (playSocketServer.getRooms[roomId?.maxSize !== 2]) return false;
    return true;
}