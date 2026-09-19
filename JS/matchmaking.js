import express from 'express';
import { standardLimiter } from "./rateLimiters.js";
import { authenticateTokenWithId } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import { kickAllClientsOfUser, checkIfUserIdIsAssignedClientId, playSocketServer, validateDivisionDuelRoom, validateTeamDuelRoom, lockRoomForMatchmaking, startRoom, checkIfTokenMatchesAndInRoom } from './playSocketEvents.js';
import { reportWebhookSecret } from './config.js';
import crypto from 'crypto';
import { processEloRefunds } from './processDivisionResult.js';
import { cacheResponse } from './responseCache.js';

const matchmakingRouter = express.Router();

// In-memory matchmaking room store
// Room structure: { code, createdAt, userId, userElo, skillBased, map, type, username }
const matchmakingRoomCodes = [];

// Players who provide a user ID must be guaranteed to actually be that user
const authenticateIfUserIdProvided = (req, res, next) => {
    if (req.body.id == null) next();
    else authenticateTokenWithId(req, res, next);
}

matchmakingRouter.post('/submit-room/:code', standardLimiter, authenticateIfUserIdProvided, async (req, res) => {
    const db = getDB();
    const { code } = req.params;
    const { id: userId, skillBased, type, map = "World", clientId, clientToken } = req.body;

    if (userId == null && type !== "team-duel") return res.status(400).json({ error: "This room type cannot be submitted by guests." });
    if (typeof code !== "string" || code.length > 10) return res.status(400).json({ error: 'Invalid code format.' });
    if (typeof clientToken !== "string" || clientToken.length > 64) return res.status(400).json({ error: 'Invalid client token format.' });
    if (!code || !map || !type || clientId == null || !clientToken) return res.status(400).json({ error: 'Code, map, type, client ID and client token are required.' });

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

        // Add new room to in-memory store
        matchmakingRoomCodes.push({
            code,
            createdAt: new Date(),
            userId: userId ? Number(userId) : null,
            clientId,
            clientToken,
            userElo,
            skillBased: Boolean(skillBased),
            map,
            type,
            username
        });

        res.status(201).json({ message: 'Matchmaking room submitted successfully.' });
    } catch (error) {
        console.error('Error submitting matchmaking room:', error);
        res.status(500).json({ error: 'An error occurred while submitting the room code.' });
    }
});

matchmakingRouter.post('/find-division-duel', standardLimiter, async (req, res) => {
    const { code, clientToken } = req.body;

    try {
        // Find the requesting user's room in the matchmaking queue
        const requestingRoom = matchmakingRoomCodes.find(room => room.code === code && room.type === 'division-duel');
        if (!requestingRoom) return res.status(400).json({ error: 'There is no division-duel room in the matchmaking queue matching that room code.' });
        if (requestingRoom.clientToken !== clientToken) return res.status(400).json({ error: 'Client token mismatch.' });
        if (playSocketServer.rooms[code]?.participants?.length !== 1) return res.status(400).json({ error: 'Room has too many players for matchmaking.' });

        // Find the requesting user's ELO division
        const breakpoints = [0, 1200, 1400, 1600, 2000, 100000];
        let divIndex = 0;
        while (divIndex < breakpoints.length - 1 && requestingRoom.userElo >= breakpoints[divIndex + 1]) divIndex++;

        const minElo = breakpoints[divIndex];
        const maxElo = breakpoints[divIndex + 1];

        // Find the compatible player that has been queueing the longest
        const opponentRoom = matchmakingRoomCodes
            .filter(room => room.type === 'division-duel' && room.userId !== requestingRoom.userId) // The user ID also rules out the requesting user's own room
            .filter(room => (requestingRoom.skillBased || room.skillBased) ? (room.userElo >= minElo && room.userElo < maxElo) : true) // Skill-based is opt-in, but binding for both sides
            .sort((a, b) => a.createdAt - b.createdAt)[0];

        if (!opponentRoom) return res.json({ matched: false });

        // The room that was queued first becomes the target room - the other one empties out, which destroys it
        const [targetRoom, roomToEmpty] = opponentRoom.createdAt <= requestingRoom.createdAt ? [opponentRoom, requestingRoom] : [requestingRoom, opponentRoom];
        playSocketServer.move(playSocketServer.rooms[roomToEmpty.code].participants[0], targetRoom.code);

        // Start the game and delete target room from matchmaking (delete is called inside startRoom)
        startRoom(targetRoom.code);

        return res.json({ matched: true, targetRoom: targetRoom.code });
    } catch (error) {
        console.error('Error during division duel match formation:', error);
        return res.status(500).json({ error: 'Failed to form match.' });
    }
});

// Find and form a team duel (2v2) match by combining rooms
matchmakingRouter.post('/find-team-duel', standardLimiter, async (req, res) => {
    const { code, clientToken } = req.body;

    try {
        // Find the requesting user's room in the matchmaking queue
        const requestingRoom = matchmakingRoomCodes.find(room => room.code === code && room.type === 'team-duel');
        if (!requestingRoom) return res.status(400).json({ error: 'There is no team-duel room in the matchmaking queue matching that room code.' });
        if (requestingRoom.clientToken !== clientToken) return res.status(400).json({ error: 'Client token mismatch.' });

        const roomCapacity = playSocketServer.rooms[code].size;
        const teamAmount = playSocketServer.getRoomStorage(code)?.teamAmount || 2;
        const maxPlayersPerTeam = Math.floor(roomCapacity / teamAmount);
        const requestingRoomPlayerCount = playSocketServer.rooms[code].participants.length;

        // Validate that this room doesn't have more players than allowed per team
        if (requestingRoomPlayerCount > maxPlayersPerTeam) return res.status(400).json({ error: 'Room has too many players for matchmaking.' });

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
            if (currentPlayerCount + room.playerCount > roomCapacity) continue; // Skip rooms that would exceed target (safety check, technically not possible with 2 vs. 2)
            roomsToMerge.push(room);
            currentPlayerCount += room.playerCount;
            if (currentPlayerCount === roomCapacity) break;
        }

        // If we can't form a valid match, return not found
        if (currentPlayerCount !== roomCapacity) return res.json({ matched: false });

        // Determine the largest room (target room where everyone moves to)
        const allRoomsInMatch = [{ ...requestingRoom, playerCount: requestingRoomPlayerCount }, ...roomsToMerge];
        allRoomsInMatch.sort((a, b) => b.playerCount - a.playerCount);
        const targetRoom = allRoomsInMatch[0];
        const roomsToEmpty = allRoomsInMatch.slice(1);

        // Move all players from smaller rooms into target room
        for (const room of roomsToEmpty) {
            const participants = [...(playSocketServer.rooms[room.code]?.participants || [])];
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
        res.status(500).json({ error: "An internal server error occured processing the OpenReport webhook." });
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