import jwt from 'jsonwebtoken';
import { getClientIp } from './clientIp.js';
import { fetchReportData } from './reportFetch.js';
import { getDB } from './dbConnection.js';
import { cancelAllRoomTimeouts, roomTimer, setRoomTimeout } from './roomTimer.js';
import { processDivisionDuelMatchResults as processDivisionDuelResult, processDivisionDuelAbandon } from './processDivisionResult.js';
import { saveDuelRoundResults } from './dbWriteHelpers.js';
import { jwtSecret as SECRET_KEY } from "./config.js";
import { getLocations } from './locations.js';
import PlaySocketServer from 'playsocketjs/server';
import { processTournamentMatchResult } from './tournaments.js';
import { deleteMatchmakingRoom, deleteRoomMoveTokens } from './matchmaking.js';
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
            const ip = getClientIp(info.req);
            if (isWsUpgradeRateLimited(ip)) return callback(false, 429, 'Too Many Requests');
            callback(true);
        }
    });
    attachPlaySocketEvents(playSocketServer); // Attach events AFTER initialization
}

const clientTokens = new Map(); // Client ID -> client token
const authedMultiplayerClients = new Map(); // Client ID -> User ID (a user can have several clients, e.g. when playing on multiple devices)
const guestNames = new Map(); // Client ID -> guest name (for unauthenticated clients)

function attachPlaySocketEvents(server) {
    playSocketServer = server; // Assign server

    server.onEvent("clientRegistrationRequested", async (clientId, data) => {
        let userId = null;

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
                userId = Number(decoded.userId);

                // Fetch OpenReport status
                const banStatus = await fetchReportData("blacklist", "user", "user-" + userId);
                if (banStatus?.listed) return `You are banned for "${banStatus?.entry?.reason}" until ${new Date(banStatus?.entry?.expires_at)?.toLocaleDateString() || "forever"} – If you need help, please contact the moderators via Discord`;

            } catch (error) {
                return "An error occurred decoding the authentication token";
            }
        }

        return { ...data, userId }; // Update the customData to pass the verified user ID on to clientRegistered
    });

    server.onEvent("clientRegistered", (clientId, data) => {
        if (data.userId != null) authedMultiplayerClients.set(clientId, data.userId);

        // All clients carry a clientToken so that guests can prove they own that client ID
        if (data?.clientToken && typeof data?.clientToken === "string" && data?.clientToken.length <= 64) clientTokens.set(clientId, data.clientToken);

        // Sanitize guest name
        if (typeof data?.guestName === "string") {
            const guestName = censor(data.guestName.trim()).slice(0, 30);
            if (guestName.length >= 3) guestNames.set(clientId, guestName);
        }
    });

    server.onEvent("clientLeftRoom", async (clientId, roomId) => {
        const players = server.getRoomStorage(roomId)?.players;
        const player = players?.find(p => p.clientId === clientId);
        if (player) {
            // Authenticated players stay (as disconnected) so they can rejoin, guests and players that left a matchmaking or tournament game before its start are removed
            // Players that disconnected are only shown for the match they took part in - if they left before gameStarted or after a rematch, they are hidden
            const leftBeforeAutoStart = !server.getRoomStorage(roomId).gameStarted && (server.getRoomStorage(roomId).matchmakingRoom || server.getRoomStorage(roomId).tournamentRoom);
            if (player.userId != null && !leftBeforeAutoStart) server.updateRoomStorage(roomId, "players", "array-update-matching", player, { ...player, clientId: null, disconnected: true, hidden: !server.getRoomStorage(roomId).gameStarted }); // Client ID is cleared since another client could register with it
            else server.updateRoomStorage(roomId, "players", "array-remove-matching", player);
            addChat(roomId, { username: "Server", clientId: null, text: `${player?.username || "Unknown"} left.` });

            // Update highest supporter level
            server.updateRoomStorage(roomId, "highestSupporterLevel", "set", determineHighestSupporterLevel(roomId));

            // Remove client from teamMoveClients
            const clients = server.getRoomStorage(roomId)?.teamMoveClients;
            const teamIndex = player.teamIndex;
            if (clients?.[teamIndex] && clients[teamIndex].includes(clientId)) {
                server.updateRoomStorage(roomId, "teamMoveClients", "object-set-key", teamIndex, clients[teamIndex].filter(c => c !== clientId));
            }
        }

        // Check if all remaining participants have confirmed guesses
        endRoundIfAllPlayersGuessed(roomId);

        // Process division duel if user was in an ongoing one
        const userId = authedMultiplayerClients.get(clientId);
        if (userId != null && server.getRoomStorage(roomId).divisionRoom && server.getRoomStorage(roomId).gameStarted && !server.getRoomStorage(roomId).divisionDuelProcessed) {
            // Inform opponent if they stay disconnected (delayed to avoid printing this page reload)
            roomTimer.set(roomId, 3_000, () => {
                if (!server.getRoomStorage(roomId).divisionDuelProcessed) addChat(roomId, { username: "Server", clientId: null, text: "If they don't return within 30s, the game ends." });
            }, "division-abandon-info-" + userId);

            // The player loses if they don't return within 30s (rejoining aborts this timer)
            roomTimer.set(roomId, 30_000, () => {
                if (!server.getRoomStorage(roomId).divisionDuelProcessed) processDivisionDuelAbandon(roomId, userId); // Skip if game ended or the opponent's timer ran out beforehand
                if (server.rooms[roomId].participants.length === 0) server.destroyRoom(roomId); // If the room is now empty, destroy
            }, "division-rejoin-" + userId);
        }

        // Destroy the duel room after it has been processed and everyone left (division duel rooms are server-created & need manual cleanup)
        if (server.getRoomStorage(roomId).divisionDuelProcessed && server.rooms[roomId].participants.length === 0) server.destroyRoom(roomId);
    });

    server.onEvent("clientDisconnected", async (clientId) => {
        authedMultiplayerClients.delete(clientId);
        clientTokens.delete(clientId);
        guestNames.delete(clientId);
    });

    server.onEvent("clientJoinRequested", (clientId, roomId) => {
        const userId = authedMultiplayerClients.get(clientId);

        // Returning players can always rejoin
        if (!isReturningPlayer(roomId, userId)) {
            if ((server.getRoomStorage(roomId)?.divisionRoom || server.getRoomStorage(roomId)?.tournamentRoom) && userId == null) return "You need to be authenticated to participate in this game";
            if ((server.getRoomStorage(roomId)?.matchmakingRoom || server.getRoomStorage(roomId)?.tournamentRoom) && server.getRoomStorage(roomId)?.gameStarted) return "This game has already started and prohibits joining late";
            if (server.getRoomStorage(roomId)?.locked) return "This room is locked";
        }

        // Check room size limit (other clients by this user will be kicked on join & therefore don't count towards the limit)
        let participantCount = 0;
        server.rooms[roomId].participants.forEach((participantId) => {
            if (userId == null || authedMultiplayerClients.get(participantId) !== userId) participantCount++;
        });
        if (participantCount >= 500) return "Room is full"; // 500 is the limit (for performance reasons)

        // Update client IDs for room data linked to the same user ID (if the user ID matches)
        const previousGuess = server.getRoomStorage(roomId)?.guesses?.find((g) => userId != null && g.userId === userId);
        if (previousGuess) {
            server.updateRoomStorage(roomId, "guesses", "array-update-matching", previousGuess, { ...previousGuess, clientId });
            if (server.getRoomStorage(roomId)?.confirmedGuessClients?.includes(previousGuess.clientId)) server.updateRoomStorage(roomId, "confirmedGuessClients", "array-update-matching", previousGuess.clientId, clientId);
        }
    });

    server.onEvent("clientJoinedRoom", async (clientId, roomId) => {
        const userId = authedMultiplayerClients.get(clientId);

        // Kick other clients of this user, like another tab or the old client after a reload, so this client takes over their player entry
        if (userId != null) {
            server.rooms[roomId].participants.forEach((participantId) => {
                if (participantId !== clientId && authedMultiplayerClients.get(participantId) === userId) server.kick(participantId, "You joined this room from another session");
            });
            roomTimer.stop(roomId, "division-rejoin-" + userId); // Cancel the 30s rejoin grace period
            roomTimer.stop(roomId, "division-abandon-info-" + userId);
        }

        // Fetch user data if authenticated (proceed without user if account no longer exists)
        const user = userId ? await getUser(userId) : null;
        if (!server.rooms[roomId]?.participants?.includes(clientId)) return; // Client left the room during the async call

        // Re-assign players and calculate team index AFTER async call to prevent race conditions
        const currentPlayers = server.getRoomStorage(roomId)?.players || [];
        const teamAmount = server.getRoomStorage(roomId)?.teamAmount;
        if (currentPlayers.find(p => p.clientId === clientId)) return;

        // A returning player continues with their previous entry (score, team & spectator state)
        const previousPlayer = user ? currentPlayers.find((p) => p.userId === userId) : null;
        if (previousPlayer) {
            server.updateRoomStorage(roomId, "players", "array-update-matching", previousPlayer, { ...previousPlayer, clientId, disconnected: false, hidden: false });
            server.updateRoomStorage(roomId, "highestSupporterLevel", "set", determineHighestSupporterLevel(roomId));
            addChat(roomId, { username: "Server", clientId: null, text: `${previousPlayer.username || "Unknown"} joined.` });
            return;
        }

        // Assign team (hidden players don't count since they aren't playing)
        const visiblePlayerCount = currentPlayers.filter((p) => !p.hidden).length;
        let teamIndex = 0;
        if (teamAmount > 1) {
            if (server.getRoomStorage(roomId)?.matchmakingRoom) {
                // For team duels: Fill team 0 up until two players, then team 1
                teamIndex = Math.min(Math.floor(visiblePlayerCount / 2), teamAmount - 1);
            } else {
                // For regular rooms: round-robin assignment
                teamIndex = visiblePlayerCount % teamAmount;
            }
        }

        const playerData = user
            ? { clientId, username: user.user_name, elo: user.elo, score: 0, teamIndex, userId, badge: user.badge, pin: user.pin, flag: user.flag ?? null, supporterLevel: user.supporter_level, spectator: false, disconnected: false, hidden: false }
            : { clientId, username: guestNames.get(clientId) || "(No name)", elo: 0, score: 0, teamIndex, userId: null, badge: null, pin: 0, flag: null, supporterLevel: 0, spectator: false, disconnected: false, hidden: false };

        server.updateRoomStorage(roomId, "players", "array-add-unique", playerData);
        server.updateRoomStorage(roomId, "highestSupporterLevel", "set", determineHighestSupporterLevel(roomId));
        addChat(roomId, { username: "Server", clientId: null, text: `${playerData.username || "Unknown"} joined.` });
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
        if (key === "divisionDuelProcessed") return false;

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
        if (key === "highestSupporterLevel") return false;
        if (key === "timerStart") return false;
        if (key === "overlay") return false;
        if (key === "location") return false;
        if (key === "mapBounds") return false;
        if (key === "locked") return false;
        if (key === "teamMoveClients") return false;

        // Restrict updates
        if (key === "chats") {
            if (type !== "array-add") return "Invalid chat update type";
            if (value?.username !== storage.players?.find((e) => e.clientId === clientId)?.username) return "Chat username mismatch";
            if (value?.clientId !== clientId) return "Invalid chat client ID";
            if (value?.userId != null && value?.userId !== storage.players?.find((e) => e.clientId === clientId)?.userId) return "Chat user ID mismatch";
            if (value?.teamIndex != null && value?.teamIndex !== storage.players?.find((e) => e.clientId === clientId)?.teamIndex) return "Chat teamindex mismatch";
        }

        if (key === "guesses") {
            const player = storage.players?.find((e) => e.clientId === clientId);
            const existingGuess = storage.guesses?.find((e) => e.clientId === clientId);
            const guess = type === "array-update-matching" ? secondValue : value;

            if (!player) return "Player not found";
            if (!storage.timerStart) return "Round not active";
            if (type !== "array-add" && type !== "array-update-matching") return "Invalid guess update type";
            if (type === "array-add" && existingGuess) return "Client already has guess";
            if (type === "array-update-matching" && value?.clientId !== clientId) return "Cannot update guess from different client";
            if (existingGuess?.scoreAdded) return "Score already added"; // If a score was added for this round, the guess can't be changed again
            if (storage.confirmedGuessClients?.includes(clientId)) return "Already locked in (confirmed) another guess";

            if (guess?.clientId !== clientId) return "Invalid guess client ID";
            if (guess?.userId !== player.userId) return "Guess user ID mismatch";
            if (guess?.username !== player.username) return "Guess username mismatch";
            if (guess?.pin !== player.pin) return "Guess pin mismatch";
            if (guess?.teamIndex !== player.teamIndex) return "Guess team mismatch";
            if (guess?.scoreAdded !== false) return "Invalid guess scoreAdded value";
            if (!Number.isFinite(guess?.lat) || !Number.isFinite(guess?.lon)) return "Invalid guess coordinates";
        }

        if (key === "confirmedGuessClients") {
            if (type !== "array-add-unique" || value !== clientId) return "Can only confirm own guess";
            if (!storage.timerStart) return "Round not active"; // Ignore late-arriving confirmations (they'd count for the next round)
            if (!storage.guesses?.some((g) => g.clientId === clientId)) return "No guess placed";
            if (storage.confirmedGuessClients?.includes(clientId)) return "Already confirmed";
        }

        if (key === "showResult" && (type !== "set" || value !== false)) return false;

        // React to update before it has happened & ensure showResult was previously true (and not already false)
        if (key === "showResult" && value === false && storage.showResult === true) goToNextRound(roomId);
    });

    server.onEvent("storageUpdated", ({ roomId, clientId, update }) => {
        const { key } = server.getUpdateDetails(update);

        if (key === "confirmedGuessClients") {
            if (!clientId) return; // Server-authored update

            // Time reduced overlay
            const remainingTimerTime = server.getRoomStorage(roomId).timerStart?.length * 1000 - (Date.now() - server.getRoomStorage(roomId).timerStart?.timestamp); // In ms

            // Show the time reduced overlay if there are more than 3s left in the round, otherwise it would just be distraction
            if (server.getRoomStorage(roomId).style === "duel" && server.getRoomStorage(roomId).confirmedGuessClients?.length === 1 && remainingTimerTime > 3000) {
                server.updateRoomStorage(roomId, "timeReducedOverlay", "set", true);
                if (remainingTimerTime > 15_000) {
                    server.updateRoomStorage(roomId, "timerStart", "set", { timestamp: Date.now(), length: 15 }); // Reduce timer to 15s if it has longer than that remaining
                    if (roomTimer.isRunning(roomId)) roomTimer.adjust(roomId, 15_000);
                    else {
                        // For rooms without a timer, start one
                        roomTimer.set(roomId, 15_000, () => {
                            endRound(roomId);
                        });
                    }
                }

                // Wait shortly, hide overlay
                setRoomTimeout(roomId, () => server.updateRoomStorage(roomId, "timeReducedOverlay", "set", false), 2000);
            }

            // Check if all guesses are in (which immediately ends the round)
            endRoundIfAllPlayersGuessed(roomId);
        }
    });

    server.onEvent("roomCreationRequested", ({ clientId, initialStorage }) => {
        return reviewAndConstructInitialRoomStorage(clientId, initialStorage);
    });

    // Handle requests
    server.onEvent("requestReceived", async ({ roomId, clientId, name, data }) => {
        if (!roomId) return;

        if (name === 'addToScore') {
            if (!Number.isFinite(data)) return "Invalid score value";
            const storage = server.getRoomStorage(roomId);

            // Get player
            const players = storage?.players;
            const player = players?.find(p => p.clientId === clientId);
            if (!player) return "Player not found"; // Bail if player doesn't exist

            // Get guess (& mark score as added)
            const guess = storage.guesses?.find(g => g.clientId === clientId);
            if (!guess) return "No guess from client found";
            if (guess.scoreAdded) return "Score already added";
            server.updateRoomStorage(roomId, "guesses", "array-update-matching", guess, { ...guess, scoreAdded: true });

            // Add and calc score
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

        if (name === 'rematch') {
            if (server.getRoomStorage(roomId)?.matchmakingRoom || server.getRoomStorage(roomId)?.tournamentRoom) return "Tournament or matchmaking rooms disallow rematches";
            if (clientId !== server.rooms[roomId]?.host) return "Must be room host";
            if (server.getRoomStorage(roomId)?.gameEnded) rematch(roomId);
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
            if (!server.rooms[roomId].participants.includes(data)) return "Player not in same room";
            const userId = authedMultiplayerClients.get(data);
            server.kick(data, "Removed by host");

            // Remove player entry to keep client from rejoining
            const kickedPlayer = server.getRoomStorage(roomId).players.find((p) => userId != null && p.userId === userId);
            if (kickedPlayer) server.updateRoomStorage(roomId, "players", "array-remove-matching", kickedPlayer);
        }
    });

    server.onEvent("roomDestroyed", (roomId) => {
        roomTimer.stopAll(roomId);
        cancelAllRoomTimeouts(roomId);
        deleteMatchmakingRoom(roomId);
        deleteRoomMoveTokens(roomId);
    });

    function determineHighestSupporterLevel(roomId) {
        const players = server.getRoomStorage(roomId)?.players;
        let highestSupporterLevel = 0;

        players?.filter((e) => !e.disconnected).forEach((e) => {
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
        if (players && players.length) {
            const resetPlayers = players.map(p => ({ ...p, score: 0, hidden: p.disconnected })); // Players still disconnected from the last match become hidden
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

export function startRoom(roomId) {
    playSocketServer.updateRoomStorage(roomId, "gameStarted", "set", true);
    deleteMatchmakingRoom(roomId);

    // Short waiting period for matchmade games to give players time to see their opponent(s)
    if (playSocketServer.getRoomStorage(roomId)?.matchmakingRoom) setRoomTimeout(roomId, () => startRound(roomId), 3_000);
    else startRound(roomId);
}

function goToNextRound(roomId) {
    try {
        // Persist the round for division rooms
        if (playSocketServer.getRoomStorage(roomId)?.divisionRoom && playSocketServer.getRoomStorage(roomId)?.currentRound > 0) {
            const guesses = (playSocketServer.getRoomStorage(roomId)?.guesses || []).map((g) => {
                const player = playSocketServer.getRoomStorage(roomId)?.players?.find((p) => p.userId === g.userId);
                return { userId: player?.userId ?? null, username: g.username, lat: g.lat, lon: g.lon, totalPoints: player?.score || 0 };
            });
            const roundData = {
                round: playSocketServer.getRoomStorage(roomId)?.currentRound,
                location: playSocketServer.getRoomStorage(roomId)?.location,
                guesses
            };
            saveDuelRoundResults(playSocketServer.getRoomStorage(roomId)?.duelUuid, roundData);
        }

        playSocketServer.updateRoomStorage(roomId, "guesses", "set", []); // Reset guesses
        playSocketServer.updateRoomStorage(roomId, "overlay", "set", true);

        // Reset every team's roundBest for the new round
        const teamScores = playSocketServer.getRoomStorage(roomId)?.teamScores;
        if (teamScores) {
            const resetTeamScores = {};
            for (const teamIndex in teamScores) resetTeamScores[teamIndex] = { ...teamScores[teamIndex], roundBest: 0 };
            playSocketServer.updateRoomStorage(roomId, "teamScores", "set", resetTeamScores);
        }

        // If game has ended...
        if (playSocketServer.getRoomStorage(roomId)?.gameEnded) {
            // Division duel evaluation
            if (playSocketServer.getRoomStorage(roomId)?.divisionRoom && !playSocketServer.getRoomStorage(roomId)?.divisionDuelProcessed) processDivisionDuelResult(roomId);

            // Tournament match evaluation
            if (playSocketServer.getRoomStorage(roomId)?.tournamentRoom) processTournamentMatchResult(roomId, playSocketServer.getRoomStorage(roomId)?.tournamentId);

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

// True if that user is in the players array of this room (which includes disconnected players)
export const isReturningPlayer = (roomId, userId) => userId != null && playSocketServer.getRoomStorage(roomId).players.some((p) => p.userId === userId);

function endRoundIfAllPlayersGuessed(roomId) {
    if (playSocketServer.rooms[roomId]?.participants?.length < 1) return; // Room is empty
    if (playSocketServer.rooms[roomId]?.participants?.every((clientId) => playSocketServer.getRoomStorage(roomId)?.confirmedGuessClients?.includes(clientId))) {
        roomTimer.stop(roomId);
        endRound(roomId);
    }
}

function endRound(roomId) {
    try {
        playSocketServer.updateRoomStorage(roomId, "timerStart", "set", null);
        playSocketServer.updateRoomStorage(roomId, "timeReducedOverlay", "set", false);

        // If any connected players have no guess submitted, add 0, 0 as the guess
        const players = playSocketServer.getRoomStorage(roomId)?.players;
        const guessArray = playSocketServer.getRoomStorage(roomId)?.guesses;
        players?.filter((p) => !p.disconnected).forEach((p) => {
            const correspondingGuess = guessArray?.find((g) => (g.clientId === p.clientId));
            if (!correspondingGuess) guessArray.push({ clientId: p.clientId, userId: p.userId, lat: 0, lon: 0, username: p.username, pin: p.pin, teamIndex: p.teamIndex, scoreAdded: false });
        });
        playSocketServer.updateRoomStorage(roomId, "guesses", "set", guessArray);

        playSocketServer.updateRoomStorage(roomId, "showResult", "set", true);
        playSocketServer.updateRoomStorage(roomId, "confirmedGuessClients", "set", []);

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
            addChat(roomId, { username: "Server", clientId: null, text: "Couldn't load a location for this map." });
            return;
        }

        playSocketServer.updateRoomStorage(roomId, "mapBounds", "set", bounds); // Set this before location!
        playSocketServer.updateRoomStorage(roomId, "location", "set", location);
        playSocketServer.updateRoomStorage(roomId, "countdownActive", "set", true);
        playSocketServer.updateRoomStorage(roomId, "currentRound", "set", (playSocketServer.getRoomStorage(roomId).currentRound || 0) + 1);
        addChat(roomId, { username: "Server", clientId: null, text: `Starting round ${playSocketServer.getRoomStorage(roomId).currentRound}.` });
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

            // Server-side timer (Infinity means no timer)
            if (playSocketServer.getRoomStorage(roomId).roundLength !== Infinity) {
                roomTimer.set(roomId, playSocketServer.getRoomStorage(roomId).roundLength * 1000, () => {
                    endRound(roomId);
                });
            }
        } catch (error) {
            console.error("Error in timeout within round start:", error);
        }
    }, 4000);
}

export function addChat(roomId, { username, clientId, userId = null, text, teamIndex = null }) {
    playSocketServer.updateRoomStorage(roomId, "chats", "array-add", { username, clientId, userId, text, teamIndex });
}

async function getUser(userId) {
    const db = getDB();
    const [rows] = await db.promise().execute(`
        SELECT u.user_name, u.elo, u.supporter_level, p.badge, p.pin, p.flag
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
    if (playSocketServer.rooms[roomId]?.participants?.length !== 1) return false;
    return true;
}

export function validateTeamDuelRoom(roomId) {
    if (!validateMatchmakingRoomStorage(roomId)) return false;
    if (playSocketServer.getRoomStorage(roomId)?.teamAmount !== 2) return false;
    if (playSocketServer.rooms[roomId]?.participants?.length > 2) return false;
    return true;
}

// Locking makes the game attributable to matchmaking (the only way in now is the server moving a matched player in + rejoins)
export function lockRoomForMatchmaking(roomId, divisionRoom = false) {
    if (divisionRoom) playSocketServer.updateRoomStorage(roomId, "divisionRoom", "set", true);
    playSocketServer.updateRoomStorage(roomId, "locked", "set", true);
}

export function reviewAndConstructInitialRoomStorage(requestorClientId, storage) {
    if (typeof storage.roundAmount !== "number" || Number.isNaN(storage.roundAmount) || storage.roundAmount < 1 || storage.roundAmount > 10) storage.roundAmount = 3;
    if (typeof storage.roundLength !== "number" || Number.isNaN(storage.roundLength) || storage.roundLength < 10 || (storage.roundLength > 300 && storage.roundLength !== Infinity)) storage.roundLength = 60; // Infinity means no timer and is allowed
    if (typeof storage.teamAmount !== "number" || Number.isNaN(storage.teamAmount) || storage.teamAmount > 10 || storage.teamAmount < 1) storage.teamAmount = 1;
    if (!["standard", "duel"].includes(storage.style)) storage.style = "standard";
    if (typeof storage.highestSupporterLevel !== "number" || storage.highestSupporterLevel > 4 || storage.highestSupporterLevel < 0) storage.highestSupporterLevel = 0;
    if (!["none", "nmpz", "grayscale", "invert", "hue", "fade"].includes(storage.restriction)) storage.restriction = "none";
    if (typeof storage.map !== "string") storage.map = "World";
    if (typeof storage.matchmakingRoom !== "boolean") storage.matchmakingRoom = false;
    if (requestorClientId != null) storage.tournamentRoom = false; // Server-created rooms pass null
    if (requestorClientId != null) storage.tournamentId = null;
    storage.players = [];
    storage.currentRound = 0;
    storage.location = null;
    storage.guesses = []; // Guesses from players (with location data)
    storage.confirmedGuessClients = []; // Client IDs that have confirmed their guess
    storage.duelUuid = crypto.randomUUID();
    storage.firstRoundPlayed = false; // Resets with rematch
    storage.chats = [];
    storage.overlay = true;
    storage.timeReducedOverlay = false;
    storage.showResult = false;
    storage.gameStarted = false; // Stays always true after the initial start
    storage.gameEnded = false;
    storage.matchIndex = 0;
    storage.countdownActive = false;
    storage.timerStart = false;
    storage.divisionDuelProcessed = false;
    storage.mapBounds = null;
    storage.locked = false;
    storage.divisionRoom = false;
    storage.teamScores = Object.fromEntries(Array.from({ length: storage.teamAmount }, (_, i) => [i, { roundBest: 0, score: 0 }]));
    storage.teamMoveClients = {};

    return storage;
}