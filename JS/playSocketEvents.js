import jwt from 'jsonwebtoken';
import requestIp from 'request-ip';
import { fetchReportData } from './reportFetch.js';
import { getDB } from './dbConnection.js';
import { cancelAllRoomTimeouts, roomTimer, setRoomTimeout } from './roomTimer.js';
import saveDivisionDuelResult from './processDivisionResult.js';
import { saveDuelRoundResults } from './dbWriteHelpers.js';
import { jwtSecret as SECRET_KEY } from "./config.js";
import { getLocations } from './locations.js';
import PlaySocketServer from 'playsocketjs/server';
import { processTournamentMatchResults } from './tournaments.js';
import { deleteMatchmakingRoom } from './matchmaking.js';
import { censor } from 'fast-profanity-filter';

export let playSocketServer;

// WebSocket upgrade rate limiting
const wsUpgradeAttempts = new Map(); // IP -> { count, resetTime }
const WS_RATE_LIMIT_WINDOW = 5 * 1000; // 5 seconds
const WS_RATE_LIMIT_MAX = 10;

function isWsUpgradeRateLimited(ip) {
    const now = Date.now();
    const record = wsUpgradeAttempts.get(ip);

    if (!record || now > record.resetTime) {
        wsUpgradeAttempts.set(ip, { count: 1, resetTime: now + WS_RATE_LIMIT_WINDOW });
        return false;
    }

    record.count++;
    return record.count > WS_RATE_LIMIT_MAX;
}

// Clean up old entries periodically
setInterval(() => {
    const now = Date.now();
    for (const [ip, record] of wsUpgradeAttempts) {
        if (now > record.resetTime) wsUpgradeAttempts.delete(ip);
    }
}, 60 * 1000);

export async function initPlaySocket(httpServer) {
    playSocketServer = new PlaySocketServer({
        server: httpServer,
        path: '/socket',
        verifyClient: (info, callback) => {
            const ip = requestIp.getClientIp(info.req);
            if (isWsUpgradeRateLimited(ip)) return callback(false, 429, 'Too Many Requests');
            callback(true);
        }
    });
    attachPlaySocketEvents(playSocketServer); // Attach events AFTER initialization
}

const clientTokens = new Map(); // Client ID -> client token
const authedMultiplayerClients = new Map(); // Client ID -> User ID (a user can have several clients, e.g. when playing on multiple devices)

function attachPlaySocketEvents(server) {
    playSocketServer = server; // Assign server

    server.onEvent("clientRegistrationRequested", async (clientId, data) => {
        // Authenticated users carry a bearer in the registration custom data
        if (data?.bearer) {
            try {
                const decoded = await new Promise((resolve, reject) => {
                    jwt.verify(data.bearer, SECRET_KEY, (err, decoded) => {
                        if (err) reject(err);
                        else resolve(decoded);
                    });
                });
                if (!decoded?.userId) return "The authentication token lacks a user ID";
                const userId = Number(decoded.userId);

                // Fetch OpenReport status
                const banStatus = await fetchReportData("blacklist", "user", "user-" + userId);
                if (banStatus?.listed) return `You are banned for "${banStatus?.entry?.reason}" until ${new Date(banStatus?.entry?.expires_at)?.toLocaleDateString() || "forever"} – If you need help, please contact the moderators via Discord`;

                // Store auth mapping after successful validation
                authedMultiplayerClients.set(clientId, userId);

            } catch (error) {
                return "An error occured decoding the authentication token";
            }
        }
        // All clients carry a clientToken so that guests can prove they own that client ID
        if (data?.clientToken && typeof data?.clientToken === "string" && data?.clientToken.length <= 64) clientTokens.set(clientId, data.clientToken);
    });

    server.onEvent("clientLeftRoom", async (clientId, roomId) => {
        const players = server.getRoomStorage(roomId)?.players;
        const player = players?.find(p => p.clientId === clientId);
        if (player) {
            // Remove player from room storage
            server.updateRoomStorage(roomId, "players", "array-remove-matching", player);
            addChat(roomId, "Server", "server", `${player?.username || "Unknown"} left.`);

            // Update highest supporter level
            server.updateRoomStorage(roomId, "highestSupporterLevel", "set", determineHighestSupporterLevel(roomId));

            // Check if all players now have confirmed guesses
            endRoundIfAllPlayersGuessed(roomId);
        }

        // Process division duel if user was in one
        if (authedMultiplayerClients.has(clientId)) {
            const userId = authedMultiplayerClients.get(clientId);

            // Process the result if in ongoing duel room
            if (userId && server.rooms[roomId] && !server.getRoomStorage(roomId).duelProcessed && server.getRoomStorage(roomId).gameStarted && server.getRoomStorage(roomId).divisionRoom) {
                const players = server.getRoomStorage(roomId).players;

                // If one other player is still in the room, that means this client left first and should lose
                if (players.length === 1) {
                    const otherPlayerUserId = players[0]?.userId;
                    if (otherPlayerUserId != null) {
                        server.updateRoomStorage(roomId, "duelProcessed", "set", true);
                        saveDivisionDuelResult(server.getRoomStorage(roomId).duelUuid, otherPlayerUserId, userId);
                    }
                }
            }
        }
    });

    server.onEvent("clientDisconnected", async (clientId) => {
        authedMultiplayerClients.delete(clientId);
        clientTokens.delete(clientId);
    });

    server.onEvent("clientJoinRequested", (clientId, roomId) => {
        if ((server.getRoomStorage(roomId)?.divisionRoom || server.getRoomStorage(roomId)?.tournamentRoom) && !authedMultiplayerClients.has(clientId)) return "You need to be authenticated to participate in this game";
        if ((server.getRoomStorage(roomId)?.matchmakingRoom || server.getRoomStorage(roomId)?.tournamentRoom) && server.getRoomStorage(roomId)?.gameStarted) return "This game has already started and prohibits joining late";
        if (server.getRoomStorage(roomId)?.locked) return "This room is locked";
    });

    server.onEvent("storageUpdateRequested", ({ clientId, roomId, update, storage }) => {
        const { key, type, value, secondValue } = server.getUpdateDetails(update);

        // Block room configuration updates
        if (key === "roundAmount" || key === "style" || key === "roundLength" || key === "restriction" || key === "teamAmount") return false;
        if (key === "map") return false;
        if (key === "duelUuid") return false;
        if (key === "divisionRoom") return false;
        if (key === "matchmakingRoom") return false;
        if (key === "tournamentRoom") return false;
        if (key === "tournamentId") return false;
        if (key === "duelProcessed") return false;

        // Block server-side-only game control updates
        if (key === "players") return false;
        if (key === "teamScores") return false;
        if (key === "countdownActive") return false;
        if (key === "currentRound") return false;
        if (key === "firstRoundPlayed") return false;
        if (key === "gameStarted") return false;
        if (key === "gameEnded") return false;
        if (key === "matchIndex") return false;
        if (key === "timeReducedOverlay") return false;
        if (key === "guessLocationsArray") return false;
        if (key === "highestSupporterLevel") return false;
        if (key === "confirmedArray") return false;
        if (key === "timerStart") return false;
        if (key === "overlay") return false;
        if (key === "location") return false;
        if (key === "mapBounds") return false;
        if (key === "locked") return false;

        // Restrict updates
        if (key === "chats") {
            if (type !== "array-add") return false;
            if (value?.username !== storage.players?.find((e) => e.clientId === clientId)?.username) return false;
            if (value?.clientId !== clientId) return false;
            if (value?.teamIndex != null && value?.teamIndex !== storage.players?.find((e) => e.clientId === clientId)?.teamIndex) return false;
        }
        if (key === "showResult" && (type !== "set" || value !== false)) return false;

        // React to update before it has happened & ensure showResult was previously true (and not already false)
        if (key === "showResult" && value === false && storage.showResult === true) goToNextRound(roomId);
    });

    server.onEvent("roomCreationRequested", ({ clientId, initialStorage }) => {
        return reviewAndConstructInitialRoomStorage(clientId, initialStorage);
    });

    // Handle requests
    server.onEvent("requestReceived", async ({ roomId, clientId, name, data }) => {
        if (!roomId) return;

        if (name === 'addPlayer') {
            const userId = authedMultiplayerClients.get(clientId);
            const players = server.getRoomStorage(roomId)?.players || [];
            if (players.find(p => p.clientId === clientId)) return; // First check if already exists

            // Fetch user data if authenticated (proceed without user if account no longer exists)
            let user = null;
            if (userId) user = await getUser(userId);

            // Re-fetch players and calculate team index AFTER async call to prevent race conditions
            const currentPlayers = server.getRoomStorage(roomId)?.players || [];
            const teamAmount = server.getRoomStorage(roomId)?.teamAmount;
            if (currentPlayers.find(p => p.clientId === clientId)) return; // If client is already present, exit (second check to prevent race condition)

            let teamIndex = 0;
            if (teamAmount > 1) {
                if (server.getRoomStorage(roomId)?.matchmakingRoom) {
                    // For matchmaking rooms: fill teams sequentially (team 0 first, then team 1, etc.)
                    const roomSize = server.rooms[roomId]?.size || teamAmount;
                    const teamSize = Math.floor(roomSize / teamAmount);
                    teamIndex = Math.min(Math.floor(currentPlayers.length / teamSize), teamAmount - 1);
                } else {
                    // For regular rooms: round-robin assignment
                    teamIndex = currentPlayers.length % teamAmount;
                }
            }

            // Sanitize the guest name, as it is client-provided and shown to strangers in matchmaking (censoring mirrors the client's guest name picker, min 3 & max 30 chars)
            let guestName = typeof data?.guestName === "string" ? censor(data.guestName).replace(/\s+/g, " ").trim().slice(0, 30).trim() : null;
            if (guestName?.length < 3) guestName = null;

            const playerData = user
                ? { clientId, username: user.user_name, elo: user.elo, score: 0, teamIndex, userId, badge: user.badge, pin: user.pin, supporterLevel: user.supporter_level, spectator: false }
                : { clientId, username: guestName || "(No name)", elo: 0, score: 0, teamIndex, userId: null, badge: null, pin: 0, supporterLevel: 0, spectator: false };

            server.updateRoomStorage(roomId, "players", "array-add-unique", playerData);
            addChat(roomId, "Server", "server", `${playerData.username || "Unknown"} joined.`);
            server.updateRoomStorage(roomId, "highestSupporterLevel", "set", determineHighestSupporterLevel(roomId));
        }

        if (name === 'addToScore') {
            const storage = server.getRoomStorage(roomId);
            const players = storage?.players;
            const player = players?.find(p => p.clientId === clientId);
            if (!player) return "Player not found"; // Bail if player doesn't exist
            if (!Number.isFinite(data)) return "Invalid score value";
            if (storage?.style == "duel" && storage?.currentRound >= 4) data = Math.round(data * 1.5); // Duel multiplier for last 2 rounds
            const newPlayer = { ...player };
            newPlayer.score += data;
            server.updateRoomStorage(roomId, "players", "array-update-matching", player, newPlayer);

            // Update team score (closest guess from each round counts towards the team score)
            const teamScoresEntry = server.getRoomStorage(roomId)?.teamScores?.[player.teamIndex];
            if (!teamScoresEntry) return "Team scores entry missing";
            if (data > teamScoresEntry.roundBest) {
                teamScoresEntry.score += data - teamScoresEntry.roundBest; // Add the difference to the previous best
                teamScoresEntry.roundBest = data;
                server.updateRoomStorage(roomId, "teamScores", "object-set-key", player.teamIndex, teamScoresEntry);
            }
        }

        if (name === 'updateTeam') {
            if (clientId !== server.rooms[roomId]?.host) return "Must be room host";
            const players = server.getRoomStorage(roomId)?.players;
            const player = players?.find(p => p.clientId === data.playerClientId);
            if (!player) return "Player not found";
            if (!Number.isInteger(data.newTeamIndex)) return "Invalid team index value";
            if (data.newTeamIndex < 0 || data.newTeamIndex >= (server.getRoomStorage(roomId)?.teamAmount ?? 0)) return "Team index out of range";
            const newPlayer = { ...player };
            newPlayer.teamIndex = data.newTeamIndex;
            server.updateRoomStorage(roomId, "players", "array-update-matching", player, newPlayer);
        }

        if (name === 'startRoom') {
            if (server.getRoomStorage(roomId)?.matchmakingRoom || server.getRoomStorage(roomId)?.tournamentRoom) return "Tournament or matchmaking rooms start automatically";
            if (clientId !== server.rooms[roomId]?.host) return "Must be room host";
            if (!server.getRoomStorage(roomId).gameStarted) startRoom(roomId);
        }

        if (name === 'confirmGuess') {
            // Ignore confirmations while no round is active - the confirmed array is cleared on round end (right when the timer stops, and timerStart is set to null)
            // and the confirmation would falsely count for the next round if it were allowed here
            if (!server.getRoomStorage(roomId)?.timerStart) return;
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
                setRoomTimeout(roomId, () => {
                    try {
                        server.updateRoomStorage(roomId, "timeReducedOverlay", "set", false);
                    } catch (error) {
                        console.error(`Error hiding timeReducedOverlay:`, error);
                    }
                }, 2000);
            }

            // Check if all guesses are in (which immediately ends the round)
            endRoundIfAllPlayersGuessed(roomId);
        }

        if (name === 'rematch') {
            if (server.getRoomStorage(roomId)?.matchmakingRoom || server.getRoomStorage(roomId)?.tournamentRoom) return "Tournament or matchmaking rooms disallow rematches";
            if (clientId !== server.rooms[roomId]?.host) return "Must be room host";
            if (server.getRoomStorage(roomId)?.gameEnded) rematch(roomId);
        }

        if (name === 'addGuessMarker') {
            if (typeof data.lat !== "number" || typeof data.lon !== "number") return "Invalid coordinate values";
            const player = server.getRoomStorage(roomId).players?.find((e) => e.clientId === clientId);
            if (!player) return "Player not found";
            const existingMarkerElement = server.getRoomStorage(roomId)?.guessLocationsArray?.find((e) => e.id === clientId);
            if (existingMarkerElement) server.updateRoomStorage(roomId, "guessLocationsArray", "array-remove-matching", existingMarkerElement)
            server.updateRoomStorage(roomId, "guessLocationsArray", "array-add-unique", { id: clientId, lat: data.lat, lon: data.lon, username: player.username, pin: player.pin, team: player.teamIndex });
        }

        if (name === "setRoomLock") {
            if (typeof data !== "boolean") return "Invalid lock state value";
            if (server.getRoomStorage(roomId)?.matchmakingRoom || server.getRoomStorage(roomId)?.tournamentRoom) return "Tournament or matchmaking rooms disallow manual locking";
            if (clientId !== server.rooms[roomId]?.host) return "Must be room host";
            server.updateRoomStorage(roomId, "locked", "set", data);
        }

        if (name === "kickClient") {
            if (server.getRoomStorage(roomId)?.matchmakingRoom || server.getRoomStorage(roomId)?.tournamentRoom) return "Cannot kick player from matchmaking or tournament rooms";
            if (clientId !== server.rooms[roomId]?.host) return "Must be room host";
            server.kick(data, "Removed by host");
        }
    });

    server.onEvent("roomDestroyed", (roomId) => {
        roomTimer.stop(roomId);
        cancelAllRoomTimeouts(roomId);
        deleteMatchmakingRoom(roomId);
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

        // Reset team scores
        const teamAmount = playSocketServer.getRoomStorage(roomId)?.teamAmount ?? 1;
        playSocketServer.updateRoomStorage(roomId, "teamScores", "set", Object.fromEntries(Array.from({ length: teamAmount }, (_, i) => [i, { roundBest: 0, score: 0 }])));

        // Generate round
        startRound(roomId);
    } catch (error) {
        console.error("Failed to rematch:", error);
    }
}

export async function startRoom(roomId) {
    playSocketServer.updateRoomStorage(roomId, "gameStarted", "set", true);
    startRound(roomId);
    deleteMatchmakingRoom(roomId);
}

function goToNextRound(roomId) {
    try {
        // Persist the round for division rooms
        if (playSocketServer.getRoomStorage(roomId)?.divisionRoom && playSocketServer.getRoomStorage(roomId)?.currentRound > 0) {
            const guesses = (playSocketServer.getRoomStorage(roomId)?.guessLocationsArray || []).map((g) => {
                const player = playSocketServer.getRoomStorage(roomId)?.players?.find((p) => p.clientId === g.id);
                return { userId: player?.userId ?? null, username: g.username, lat: g.lat, lon: g.lon, totalPoints: player?.score || 0 };
            });
            const roundData = {
                round: playSocketServer.getRoomStorage(roomId)?.currentRound,
                location: playSocketServer.getRoomStorage(roomId)?.location,
                guesses
            };
            saveDuelRoundResults(playSocketServer.getRoomStorage(roomId)?.duelUuid, roundData);
        }

        playSocketServer.updateRoomStorage(roomId, "guessLocationsArray", "set", []); // Reset guesses
        playSocketServer.updateRoomStorage(roomId, "overlay", "set", true);

        // Reset every team's roundBest for the new round
        const teamScores = playSocketServer.getRoomStorage(roomId)?.teamScores;
        if (teamScores) {
            const resetTeamScores = {};
            for (const teamIndex in teamScores) resetTeamScores[teamIndex] = { ...teamScores[teamIndex], roundBest: 0 };
            playSocketServer.updateRoomStorage(roomId, "teamScores", "set", resetTeamScores);
        }

        // Check if this is a division room that has ended and hasn't been processed yet
        if (playSocketServer.getRoomStorage(roomId)?.gameEnded) {
            if (playSocketServer.getRoomStorage(roomId)?.divisionRoom && !playSocketServer.getRoomStorage(roomId)?.duelProcessed) {
                const players = playSocketServer.getRoomStorage(roomId)?.players;
                const sortedPlayers = players?.sort((a, b) => b.score - a.score);
                const winner = sortedPlayers?.[0];
                const loser = sortedPlayers?.[1];
                const isDraw = winner?.score == loser?.score;

                if (winner && loser) {
                    playSocketServer.updateRoomStorage(roomId, "duelProcessed", "set", true);
                    saveDivisionDuelResult(playSocketServer.getRoomStorage(roomId)?.duelUuid, winner.userId, loser.userId, isDraw);
                }
            }

            // Tournament match evaluation
            if (playSocketServer.getRoomStorage(roomId)?.tournamentRoom) processTournamentMatchResults(roomId, playSocketServer.getRoomStorage(roomId)?.tournamentId);

        } else {
            // If the game has not ended, continue with next round
            setRoomTimeout(roomId, () => {
                startRound(roomId);
            }, playSocketServer.getRoomStorage(roomId)?.currentRound === 0 ? 0 : 1500);
        }
    } catch (error) {
        console.error("Error going to the next round:", error);
    }
}

function endRoundIfAllPlayersGuessed(roomId) {
    if (playSocketServer.getRoomStorage(roomId)?.players?.length < 1) return; // Room doesn't exist or lacks added players
    if (playSocketServer.getRoomStorage(roomId)?.confirmedArray?.length >= playSocketServer.getRoomStorage(roomId)?.players?.length && !playSocketServer.getRoomStorage(roomId)?.showResult) {
        roomTimer.stop(roomId);
        endRound(roomId);
    }
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
        if (playSocketServer.getRoomStorage(roomId)?.tournamentRoom) setRoomTimeout(roomId, () => {
            if (playSocketServer.getRoomStorage(roomId)?.showResult) {
                playSocketServer.updateRoomStorage(roomId, "showResult", "set", false);
                goToNextRound(roomId)  // For tournaments, auto-skip result after 10s
            }
        }, 10 * 1000);

    } catch (error) {
        console.error("Error ending round:", error);
    }
}

async function startRound(roomId) {
    let location;
    let bounds;
    try {
        const map = playSocketServer.getRoomStorage(roomId).map;
        const data = await getLocations(map, 1, roomId); // Use room ID for key that ensures no duplicates
        location = data?.locations?.[0];
        bounds = data?.bounds;
    } catch (error) {
        console.error("Error loading location for round:", error);
    }

    try {
        // Abort start if no locations are available (e.g. map doesn't exist but user client is outdated - edge case)
        if (!location) {
            addChat(roomId, "Server", "server", "Couldn't load a location for this map.");
            return;
        }

        playSocketServer.updateRoomStorage(roomId, "mapBounds", "set", bounds); // Set this before location!
        playSocketServer.updateRoomStorage(roomId, "location", "set", location);
        playSocketServer.updateRoomStorage(roomId, "countdownActive", "set", true);
        playSocketServer.updateRoomStorage(roomId, "currentRound", "set", (playSocketServer.getRoomStorage(roomId).currentRound || 0) + 1);
        addChat(roomId, "Server", "server", `Starting round ${playSocketServer.getRoomStorage(roomId).currentRound}.`);
    } catch (error) {
        console.error("Error starting round:", error);
    }

    // After countdown, start timer
    setRoomTimeout(roomId, () => {
        try {
            playSocketServer.updateRoomStorage(roomId, "countdownActive", "set", false);
            playSocketServer.updateRoomStorage(roomId, "overlay", "set", false);
            if (!playSocketServer.getRoomStorage(roomId).firstRoundPlayed) playSocketServer.updateRoomStorage(roomId, "firstRoundPlayed", "set", true);

            // Timer information for clients
            playSocketServer.updateRoomStorage(roomId, "timerStart", "set", { timestamp: Date.now(), length: playSocketServer.getRoomStorage(roomId).roundLength });

            // Server-side timer
            roomTimer.set(roomId, playSocketServer.getRoomStorage(roomId).roundLength * 1000, () => {
                endRound(roomId);
            });
        } catch (error) {
            console.error("Error in timeout within round start:", error);
        }
    }, 4000);
}

export function addChat(roomId, username, clientId, text, teamIndex = null) {
    playSocketServer.updateRoomStorage(roomId, "chats", "array-add", { username, clientId, text, teamIndex });
}

async function getUser(userId) {
    const db = getDB();
    const [rows] = await db.promise().execute(`
        SELECT u.user_name, u.elo, u.supporter_level, p.badge, p.pin
        FROM users u LEFT JOIN profile_data p ON u.id = p.user_id 
        WHERE u.id = ?`, [userId]);
    return rows[0];
}

export function kickAllClientsOfUser(userId, reason) {
    const clientIds = [...authedMultiplayerClients.entries()].filter(([_, id]) => id === Number(userId)).map(([clientId]) => clientId);
    clientIds.forEach(clientId => playSocketServer?.kick(clientId, reason));
}

export function checkIfUserIdIsAssignedClientId(userId, clientId) {
    const userIdForClient = authedMultiplayerClients.get(clientId);
    if (userIdForClient == null || userIdForClient !== Number(userId)) return false;
    return true;
}

export function checkIfTokenMatchesAndInRoom(roomId, clientId, clientToken) {
    // Check if room exists and get participants
    const roomParticipants = playSocketServer?.rooms?.[roomId]?.participants;
    if (!roomParticipants) return false;

    // Verify client token matches
    const registeredClientToken = clientTokens.get(clientId);
    if (!registeredClientToken || registeredClientToken !== clientToken) return false;

    return roomParticipants.includes(clientId); // True if in room, false if not
}

function validateMatchmakingRoomStorage(roomId) {
    const storage = playSocketServer.getRoomStorage(roomId);
    if (!storage) return false;
    if (!storage.matchmakingRoom) return false;
    if (storage.divisionRoom || storage.tournamentRoom || storage.locked) return false;
    if (storage.gameStarted) return false;
    if (storage.style !== "duel") return false;
    return true;
}

export function validateDivisionDuelRoom(roomId) {
    if (!validateMatchmakingRoomStorage(roomId)) return false;
    if (playSocketServer.getRoomStorage(roomId)?.teamAmount !== 1) return false;
    if (playSocketServer.rooms[roomId]?.size !== 2) return false;
    if (playSocketServer.rooms[roomId]?.participants?.length !== 1) return false;
    return true;
}

export function validateTeamDuelRoom(roomId) {
    if (!validateMatchmakingRoomStorage(roomId)) return false;
    if (playSocketServer.getRoomStorage(roomId)?.teamAmount !== 2) return false;
    if (playSocketServer.rooms[roomId]?.size !== 4) return false;
    if (playSocketServer.rooms[roomId]?.participants?.length > 2) return false;
    return true;
}

// Locking makes the game attributable to matchmaking (the only way in now is the server moving a matched player in)
export function lockRoomForMatchmaking(roomId, divisionRoom = false) {
    if (divisionRoom) playSocketServer.updateRoomStorage(roomId, "divisionRoom", "set", true);
    playSocketServer.updateRoomStorage(roomId, "locked", "set", true);
}

export function reviewAndConstructInitialRoomStorage(requestorClientId, storage) {
    if (typeof storage.roundAmount !== "number" || storage.roundAmount < 1 || storage.roundAmount > 10) storage.roundAmount = 3;
    if (typeof storage.roundLength !== "number" || storage.roundLength < 10 || storage.roundLength > 300) storage.roundLength = 60;
    if (typeof storage.teamAmount !== "number" || storage.teamAmount > 10 || storage.teamAmount < 1) storage.teamAmount = 1;
    if (!["standard", "duel"].includes(storage.style)) storage.style = "standard";
    if (typeof storage.highestSupporterLevel !== "number" || storage.highestSupporterLevel > 4 || storage.highestSupporterLevel < 0) storage.highestSupporterLevel = 0;
    if (!["none", "nmpz", "grayscale", "invert", "hue", "fade"].includes(storage.restriction)) storage.restriction = "none";
    if (typeof storage.map !== "string") storage.map = "World";
    if (typeof storage.matchmakingRoom !== "boolean") storage.matchmakingRoom = false;
    if (requestorClientId !== "server") storage.tournamentRoom = false;
    if (requestorClientId !== "server") storage.tournamentId = null;
    storage.players = []; // Ensure initial players array is empty
    storage.currentRound = 0;
    storage.location = null;
    storage.guessLocationsArray = []; // Guesses from players (with location data)
    storage.confirmedArray = []; // Client IDs that have confirmed their guess
    storage.duelUuid = crypto.randomUUID();
    storage.firstRoundPlayed = false; // Resets with rematch
    storage.chats = [];
    storage.overlay = true;
    storage.timeReducedOverlay = false; // Duel "Opponent has guessed" overlay
    storage.showResult = false;
    storage.gameStarted = false; // Stays always true after the initial start
    storage.gameEnded = false;
    storage.matchIndex = 0;
    storage.countdownActive = false;
    storage.timerStart = false;
    storage.duelProcessed = false;
    storage.mapBounds = null;
    storage.locked = false;
    storage.divisionRoom = false;
    storage.teamScores = Object.fromEntries(Array.from({ length: storage.teamAmount }, (_, i) => [i, { roundBest: 0, score: 0 }]));

    return storage;
}