import express from 'express';
import { standardLimiter } from "./rateLimiters.js";
import { authenticateTokenWithId } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import { kickAllClientsOfUser, checkIfUserIdIsAssignedClientId, playSocketServer, validateDivisionDuelRoom, validateTeamDuelRoom, lockRoomForMatchmaking, startRoom, checkIfTokenMatchesAndInRoom, isReturningPlayer, reviewAndConstructInitialRoomStorage } from './playSocketEvents.js';
import { reportWebhookSecret } from './config.js';
import crypto from 'crypto';
import { processEloRefunds } from './processDivisionResult.js';
import { cacheResponse } from './responseCache.js';

const matchmakingRouter = express.Router();

// In-memory matchmaking room store
// Room structure: { code, createdAt, userId, clientId, clientToken, userElo, map, type, username, eloRange, manualEloRange, paused }
const matchmakingRoomCodes = [];

// Players who provide a user ID must be guaranteed to actually be that user
const authenticateIfUserIdProvided = (req, res, next) => {
    if (req.body.id == null) next();
    else authenticateTokenWithId(req, res, next);
}

matchmakingRouter.post('/submit-room/:code', standardLimiter, authenticateIfUserIdProvided, async (req, res) => {
    const db = getDB();
    const { code } = req.params;
    const { id: userId, type, clientId, clientToken } = req.body;

    if (userId == null && type !== "team-duel") return res.status(400).json({ error: "This room type cannot be submitted by guests." });
    if (typeof code !== "string" || code.length > 10) return res.status(400).json({ error: 'Invalid code format.' });
    if (typeof clientToken !== "string" || clientToken.length > 64) return res.status(400).json({ error: 'Invalid client token format.' });
    if (!code || !type || clientId == null || !clientToken) return res.status(400).json({ error: 'Code, type, client ID and client token are required.' });

    try {
        let userElo = null;
        let username = null;

        if (userId != null) {
            // Get user's ELO and username
            const getUserEloQuery = 'SELECT elo, user_name FROM users WHERE id = ?';
            const userData = await new Promise((resolve, reject) => {
                db.execute(getUserEloQuery, [userId], (err, results) => {
                    if (err) return reject(err);
                    resolve(results[0]);
                });
            });

            if (!userData) return res.status(404).json({ error: 'User not found.' });
            userElo = userData.elo;
            username = userData.user_name;

            // Ensure user is authed as the provided client ID
            if (!checkIfUserIdIsAssignedClientId(userId, clientId)) return res.status(400).json({ error: 'Client is authenticated as another user ID or unauthenticated.' });
        }

        // Ensure that this client is actually in the room with the provided room code
        // This check is performed both for guests as well as authenticated users, since both the guest as well as the auth path should be valid for room deletion
        if (!checkIfTokenMatchesAndInRoom(code, clientId, clientToken)) return res.status(400).json({ error: "Room does not exist, you are not a part of it, or the provided client ID or client token are incorrect." });

        // Get map
        const map = playSocketServer.getRoomStorage(code).map;

        // Validate room, lock it & push to matchmaking synchronously (nothing async in between!)
        switch (type) {
            case "division-duel":
                if (!validateDivisionDuelRoom(code)) return res.status(400).json({ error: 'This is not a valid division-duel room.' });
                lockRoomForMatchmaking(code, true);
                break;
            case "team-duel":
                if (!validateTeamDuelRoom(code)) return res.status(400).json({ error: 'This is not a valid team-duel room.' });
                lockRoomForMatchmaking(code, false);
                break;
        }

        // Delete any existing room with this roomId (deduplication)
        const existingRoomIndex = matchmakingRoomCodes.findIndex(room => room.code === code);
        if (existingRoomIndex !== -1) matchmakingRoomCodes.splice(existingRoomIndex, 1);

        // Division duel elo range (a range a player/room can be matched with that expands over time)
        let eloRange;
        if (type === "division-duel") {
            const clampedElo = Math.min(2000, Math.max(1000, userElo)); // Below 1000 / above 2000 is one bucket each, as these players are rare
            eloRange = {
                clampedElo,
                initialOffset: 125, // Initial +/- offset applied in both directions from user's elo (125 * 2 is 250, one division's width)
                finalOffset: Math.max(clampedElo - 1000, 2000 - clampedElo), // Final offset at the end of the expansion (whatever is further away, lower or upper bound, is reached)
                expandDuration: Math.min(30_000, 5_000 + getDivisionDuelPlayerAmount() * 500) // 5s base + 0.5s per online duel player, capped at 30s
            }
        }

        // Add new room to in-memory store
        matchmakingRoomCodes.push({
            code,
            createdAt: new Date(),
            userId: userId ? Number(userId) : null,
            clientId,
            clientToken,
            userElo,
            map,
            type,
            username,
            eloRange,
            manualEloRange: null, // Set by the player if they wish to manually define the range
            paused: false
        });

        res.status(201).json({ message: 'Matchmaking room submitted successfully.', eloRange });
    } catch (error) {
        console.error('Error submitting matchmaking room:', error);
        res.status(500).json({ error: 'An error occurred while submitting the room code.' });
    }
});

// Find and form a division duel (1v1) by combining rooms
setInterval(() => {
    // Check if an elo value is in a target room's elo range
    const roomUserInEloRange = (elo, room) => {
        const { clampedElo, initialOffset, finalOffset, expandDuration } = room.eloRange;
        const timeFactor = Math.min(1, (Date.now() - room.createdAt) / expandDuration); // 0 at start, 1 when fully expanded
        const offset = initialOffset + (finalOffset - initialOffset) * timeFactor; // Current offset (expands over time)
        const lower = room.manualEloRange?.lower ?? clampedElo - offset;
        const upper = room.manualEloRange?.upper ?? clampedElo + offset;
        return (lower <= 1000 || elo >= lower) && (upper >= 2000 || elo <= upper); // Reaching 1000 / 2000 includes everyone beyond, so e.g. if the range goes from 1000-2000, any user elo would fit in (even 2300)
    };

    try {
        matchmakingRoomCodes
            .filter(room => room.type === 'division-duel' && !room.paused)
            .forEach(requestingRoom => {
                if (!matchmakingRoomCodes.includes(requestingRoom)) return; // Also skips rooms matched earlier in the loop (via the .includes)

                // Find the compatible player (the room codes array has oldest first so this prefers long-time queuers)
                const opponentRoom = matchmakingRoomCodes.find(room =>
                    room.type === 'division-duel' && !room.paused && room.userId !== requestingRoom.userId && // Ensure it's a different user (and room)
                    roomUserInEloRange(room.userElo, requestingRoom) && roomUserInEloRange(requestingRoom.userElo, room) // Ensure in range for both sides
                );
                if (!opponentRoom) return;

                // Server-created so the room persists while both players are away
                const { id: duelRoomId } = playSocketServer.createRoom(reviewAndConstructInitialRoomStorage(null, playSocketServer.getRoomStorage(requestingRoom.code)));
                lockRoomForMatchmaking(duelRoomId, true);

                // Emptied rooms get destroyed and removed from matchmaking
                [requestingRoom, opponentRoom].forEach((room) => {
                    playSocketServer.rooms[room.code].participants.forEach((clientId) => playSocketServer.move(clientId, duelRoomId));
                });

                startRoom(duelRoomId);
            });
    } catch (error) {
        console.error('Error during periodic division duel match check:', error);
    }
}, 1000);

// Find and form a team duel (2v2) match by combining rooms
matchmakingRouter.post('/find-team-duel', standardLimiter, async (req, res) => {
    const { code, clientToken } = req.body;

    try {
        // Find the requesting user's room in the matchmaking queue
        const requestingRoom = matchmakingRoomCodes.find(room => room.code === code && room.type === 'team-duel');
        if (!requestingRoom) return res.status(400).json({ error: 'There is no team-duel room in the matchmaking queue matching that room code.' });
        if (requestingRoom.clientToken !== clientToken) return res.status(400).json({ error: 'Client token mismatch.' });

        const requestingRoomPlayerCount = playSocketServer.rooms[code].participants.length;

        // Validate that this room doesn't have more players than allowed per team
        if (requestingRoomPlayerCount > 2) return res.status(400).json({ error: 'Room cannot start with more than 2 players for matchmaking.' });

        // Get all team-duel rooms with their current player counts
        const teamDuelRooms = matchmakingRoomCodes
            .filter(room => room.type === 'team-duel')
            .map(room => ({
                ...room,
                playerCount: playSocketServer.rooms[room.code]?.participants?.length || 0
            }));

        // Sort other rooms by player count (largest first) to find matches
        const otherRooms = teamDuelRooms
            .filter(r => r.code !== code)
            .sort((a, b) => b.playerCount - a.playerCount);

        // Find combination that reaches exactly target player count
        const roomsToMerge = [];
        let currentPlayerCount = requestingRoomPlayerCount;
        for (const room of otherRooms) {
            if (currentPlayerCount + room.playerCount > 4) continue; // Skip room merges that would exceed 4 players (e.g. 1 + 2 + 2)
            roomsToMerge.push(room);
            currentPlayerCount += room.playerCount;
            if (currentPlayerCount === 4) break; // Full 2v2
        }

        // If we can't form a valid match, return not found
        if (currentPlayerCount !== 4) return res.json({ matched: false });

        // Determine the largest room (target room where everyone moves to)
        const allRoomsInMatch = [{ ...requestingRoom, playerCount: requestingRoomPlayerCount }, ...roomsToMerge];
        allRoomsInMatch.sort((a, b) => b.playerCount - a.playerCount);
        const targetRoom = allRoomsInMatch[0];
        const roomsToEmpty = allRoomsInMatch.slice(1);

        // Move all players from smaller rooms into target room
        for (const room of roomsToEmpty) {
            const participants = playSocketServer.rooms[room.code].participants; // (rooms returns a clone, this doesn't mutate)
            for (const clientId of participants) {
                playSocketServer.move(clientId, targetRoom.code); // All players get moved out -> room destroyed -> room gets removed from matchmaking
            }
        }

        // Start the game and delete target room from matchmaking (delete is called inside startRoom)
        startRoom(targetRoom.code);

        return res.json({ matched: true, targetRoom: targetRoom.code });
    } catch (error) {
        console.error('Error during team duel match formation:', error);
        return res.status(500).json({ error: 'Failed to form match.' });
    }
});

const moveTokens = {};

// Move a teammate into a new team duel (2v2) room for "play another" functionality
matchmakingRouter.post('/prepare-move-team-duel-teammate', standardLimiter, async (req, res) => {
    const { currentCode, clientId, clientToken } = req.body;

    try {
        // Check if clientToken and room are valid
        if (!checkIfTokenMatchesAndInRoom(currentCode, clientId, clientToken)) return res.status(400).json({ error: "Not in room or invalid client token." });

        // Get the teammate
        const players = playSocketServer.getRoomStorage(currentCode).players;
        const thisPlayer = players.find((p) => p.clientId === clientId);
        const teammate = players.find((p) => p.clientId !== clientId && p.teamIndex === thisPlayer.teamIndex && !p.disconnected);
        if (!teammate) return res.status(400).json({ error: "Teammate has already left." });

        // Room code + team
        const moveKey = currentCode + "-" + thisPlayer.teamIndex;

        // Add entry to room storage for reactive display on the client (e.g. 1/2 accepted)
        const addRoomStorageEntry = () => {
            const teamMoves = playSocketServer.getRoomStorage(currentCode).teamMoveClients;
            const current = teamMoves[thisPlayer.teamIndex] ?? [];
            if (!current.includes(clientId)) playSocketServer.updateRoomStorage(currentCode, "teamMoveClients", "object-set-key", thisPlayer.teamIndex, [...current, clientId]);
        }

        // Check if a move is already prepared, or if they are the initiator
        const entry = moveTokens[moveKey];
        if (entry) {
            if (entry.moveClientId === clientId) return res.status(400).json({ error: "Already waiting for teammate." });
            addRoomStorageEntry();
            return res.json({ create: true, moveKey, moveToken: entry.moveToken });
        } else {
            moveTokens[moveKey] = { moveToken: crypto.randomUUID(), roomId: currentCode, moveClientId: clientId };
            addRoomStorageEntry();
            return res.json({ create: false });
        }
    } catch (error) {
        console.error('Error preparing team duel teammate move:', error);
        return res.status(500).json({ error: 'Failed to prepare teammate move.' });
    }
});

matchmakingRouter.post('/perform-move-team-duel-teammate', standardLimiter, async (req, res) => {
    const { moveKey, moveToken, newRoomCode } = req.body;

    try {
        const move = moveTokens[moveKey];
        if (!move) return res.status(400).json({ error: "Teammate has left & former room was destroyed." }); // Room destroyed means teammate must have left
        if (move.moveToken !== moveToken) return res.status(403).json({ error: "Invalid move token." });

        // Delete prepared move to avoid replaying
        delete moveTokens[moveKey];

        // Room is guaranteed to exist since the move would have been deleted if the room was destroyed
        const participantToMove = playSocketServer.rooms[move.roomId].participants.includes(move.moveClientId);
        if (!participantToMove) return res.status(400).json({ error: "Teammate is no longer in room." });

        playSocketServer.move(move.moveClientId, newRoomCode);
        return res.json({ message: "Teammate moved successfully." });
    } catch (error) {
        console.error("Error moving team duel teammate to new room:", error);
        return res.status(500).json({ error: 'Failed to move teammate.' });
    }
});

export function deleteRoomMoveTokens(roomId) {
    Object.entries(moveTokens).forEach(([key, value]) => {
        if (value.roomId === roomId) delete moveTokens[key];
    });
}

// Safely cancel matchmaking by removing the room from the queue and destroying it
// Clients use this instead of leaving directly, since leaving a room that was just matched (but not yet reflected client-side) would be a loss
// Returns { removed } so the client knows whether cancellation succeeded or the game was already matched
matchmakingRouter.delete('/delete-room/:code', standardLimiter, async (req, res) => {
    try {
        const code = req.params.code;
        const { clientId, clientToken } = req.body;

        // Check if the room is still in matchmaking and owned by this client
        const room = matchmakingRoomCodes.find(room => room.code === code);
        if (!room) return res.json({ removed: false });

        // Since client IDs can be re-assigned when the previous client disconnected, we store the clientToken from creation-time on the matchmaking room itself
        if (room.clientId !== clientId || room.clientToken !== clientToken) return res.status(403).json({ error: 'Not the owner of this room.' });

        // Destroying the room also removes it from matchmakingRoomCodes via the roomDestroyed event
        playSocketServer.destroyRoom(code);
        res.json({ removed: true });
    } catch (error) {
        console.error('Error deleting matchmaking room:', error);
        res.status(500).json({ error: 'Failed to delete matchmaking room.' });
    }
});

// Manually set the elo range of a division duel room
matchmakingRouter.post('/set-elo-range/:code', standardLimiter, async (req, res) => {
    try {
        const code = req.params.code;
        const { clientId, clientToken, lower, upper, paused } = req.body;

        const room = matchmakingRoomCodes.find(room => room.code === code && room.type === 'division-duel');
        if (!room) return res.json({ updated: false }); // Already matched or cancelled
        if (room.clientId !== clientId || room.clientToken !== clientToken) return res.status(403).json({ error: 'Not the owner of this room.' });
        if (typeof lower !== "number" || typeof upper !== "number" || lower > upper) return res.status(400).json({ error: 'Invalid range.' });

        room.manualEloRange = { lower, upper };
        room.paused = Boolean(paused); // Allows pausing matchmaking (e.g. while adjusting the range)
        res.json({ updated: true });
    } catch (error) {
        console.error('Error setting matchmaking range:', error);
        res.status(500).json({ error: 'Failed to set matchmaking range.' });
    }
});

export function deleteMatchmakingRoom(code) {
    if (!code) return console.warn("Delete matchmaking room called without code!");
    try {
        const roomIndex = matchmakingRoomCodes.findIndex(room => room.code === code);
        if (roomIndex !== -1) matchmakingRoomCodes.splice(roomIndex, 1);
    } catch (error) {
        console.error(`Error deleting room with code ${code}:`, error);
    }
}

// Get current timestamp (for timer resume etc.)
matchmakingRouter.get('/time/timestamp', standardLimiter, async (req, res) => {
    try {
        res.json({ timestamp: Date.now() });
    } catch (error) {
        console.error('Error getting timestamp:', error);
        res.status(500).json({ error: 'Failed to get timestamp.' });
    }
});

// List all rooms of a certain type
matchmakingRouter.get('/all-rooms-of-type/:type', standardLimiter, async (req, res) => {
    const type = req.params.type;

    if (!type) return res.status(400).json({ error: "Room type is required." });

    try {
        const rooms = matchmakingRoomCodes
            .filter(room => room.type === type)
            .slice(0, 50)
            .map(room => ({
                code: room.code,
                map: room.map,
                created_at: room.createdAt,
                user_id: room.userId,
                user_name: room.username
            }));

        res.json({ rooms });
    } catch (error) {
        console.error('Error fetching all rooms:', error);
        res.status(500).json({ error: 'An error occurred while fetching all rooms.' });
    }
});

function getDivisionDuelPlayerAmount() {
    let amount = 0;
    Object.keys(playSocketServer.rooms).forEach((roomId) => {
        if (playSocketServer.getRoomStorage(roomId, { dangerouslySkipCloning: true })?.divisionRoom) amount += playSocketServer.rooms[roomId].participants.length;
    });
    return amount;
}

matchmakingRouter.get('/matchmaking-rooms-player-amount', standardLimiter, cacheResponse("matchmaking-player-amount", 5000), async (req, res) => {
    try {
        const rooms = playSocketServer.rooms;
        const matchmakingRoomCodes = Object.keys(rooms);

        let amount = 0;
        matchmakingRoomCodes.forEach((roomId) => {
            if (playSocketServer.getRoomStorage(roomId, { dangerouslySkipCloning: true })?.matchmakingRoom) amount += rooms[roomId].participants.length;
        });

        return res.json({ amount });
    } catch (error) {
        console.error("Error getting matchmaking player count:", error);
        return res.status(500).json({ error: "Failed to retrieve matchmaking player count." });
    }
});

matchmakingRouter.post('/can-rejoin', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { code } = req.body;
    if (!code) return res.status(400).json({ error: "Room code is required." });

    try {
        // Rejoinable if the room exists and the user is returning to it
        res.json({ rejoinable: Boolean(playSocketServer.rooms[code]) && isReturningPlayer(code, Number(req.body.id)) });

    } catch (error) {
        console.error("Error checking if room is rejoinable:", error);
        return res.status(500).json({ error: "Failed to check if room can be rejoined." });
    }
});

// Webhook for OpenReport – kick banned players out of multiplayer immediately
matchmakingRouter.post('/openreport-webhook', standardLimiter, async (req, res) => {
    const signature = req.headers['x-webhook-signature'];

    try {
        if (verifyWebhook(req.body, signature, reportWebhookSecret)) {
            const { type, data = {} } = req.body;
            if (type === "blacklist-entry-added" || type === "blacklist-entry-added-manually") {
                const userId = Number(data.referenceId?.replace("user-", ""));
                kickAllClientsOfUser(userId, "Banned");

                // For manual bans, refund elo
                if (type === "blacklist-entry-added-manually") processEloRefunds(userId); // Not awaited here
            }

            res.sendStatus(200);
        } else {
            console.error("OpenReport webhook verification failed.");
            console.log(signature);
            res.sendStatus(401);
        }

    } catch (error) {
        console.error("Error in OpenReport webhook:", error);
        res.status(500).json({ error: "An internal server error occurred processing the OpenReport webhook." });
    }
});

function verifyWebhook(payload, signature, secret) {
    const expectedSignature = crypto
        .createHmac('sha256', secret)
        .update(JSON.stringify(payload))
        .digest('hex');

    const receivedSignature = signature.replace('sha256=', '');
    return crypto.timingSafeEqual(
        Buffer.from(expectedSignature, 'hex'),
        Buffer.from(receivedSignature, 'hex')
    );
}

export default matchmakingRouter;