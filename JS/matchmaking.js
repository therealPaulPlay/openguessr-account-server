import express from 'express';
import { standardLimiter } from "./rateLimiters.js";
import { authenticateTokenWithId } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import { authedMultiplayerUserIds, checkIfUserIsAuthedAndInRoom, playSocketServer, validateDivisionDuelRoom, validateTeamDuelRoom, startRoom } from './playSocketEvents.js';
import { reportWebhookSecret } from './config.js';
import crypto from 'crypto';

const matchmakingRouter = express.Router();

// In-memory matchmaking room store
// Room structure: { code, createdAt, userId, userElo, skillBased, map, type, username }
const matchmakingRoomCodes = [];

matchmakingRouter.post('/submit-room/:code', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { code } = req.params;
    const { id: userId, skillBased, type, map = "World" } = req.body;

    if (!code || !userId || !map || !type) return res.status(400).json({ error: 'Code, user ID, map, and type are required.' });
    if (typeof code !== "string" || code.length > 10) return res.status(400).json({ error: 'Invalid code format.' });

    try {
        // Get user's ELO and username
        const getUserEloQuery = 'SELECT elo, user_name FROM users WHERE id = ?';
        const userData = await new Promise((resolve, reject) => {
            db.execute(getUserEloQuery, [userId], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (!userData) return res.status(404).json({ error: 'User not found.' });
        const userElo = userData.elo;
        const username = userData.user_name;

        // Validate room & push to matchmaking synchronously (nothing async in between!)
        if (!checkIfUserIsAuthedAndInRoom(code, userId)) return res.status(400).json({ error: 'Room does not exist, you are not part of it, or you are not authenticated.' });
        if (type == "division-duel" && !validateDivisionDuelRoom(code)) return res.status(400).json({ error: 'This is not a valid division-duel room.' });
        if (type == "team-duel" && !validateTeamDuelRoom(code)) return res.status(400).json({ error: 'This is not a valid team-duel room.' });

        // Delete any existing room from this user
        const existingRoomIndex = matchmakingRoomCodes.findIndex(room => room.userId === Number(userId));
        if (existingRoomIndex !== -1) matchmakingRoomCodes.splice(existingRoomIndex, 1);

        // Add new room to in-memory store
        matchmakingRoomCodes.push({
            code,
            createdAt: new Date(),
            userId: Number(userId),
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

matchmakingRouter.put('/get-room/:index', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: userId, elo = 1000, type, skillBased = false } = req.body;
    const index = parseInt(req.params.index, 10);

    if (isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid index.' });
    if (!type) return res.status(400).json({ error: 'Room type is required.' });
    if (elo && isNaN(elo)) return res.status(400).json({ error: 'Elo must be a number.' });

    try {
        // Find user's ELO division
        const breakpoints = [0, 1200, 1400, 1600, 2000, 100000];
        let divIndex = 0;
        while (divIndex < breakpoints.length - 1 && elo >= breakpoints[divIndex + 1]) divIndex++;

        const minElo = breakpoints[divIndex];
        const maxElo = breakpoints[divIndex + 1];

        // Filter rooms based on skill-based matching rules
        let filteredRooms = matchmakingRoomCodes.filter(room => {
            if (room.userId === Number(userId)) return false; // Don't match with own room
            if (room.type !== type) return false; // Must be same type

            if (skillBased) return room.userElo >= minElo && room.userElo < maxElo; // Skill-based: Only match with players in user's ELO range
            else return !room.skillBased || (room.userElo >= minElo && room.userElo < maxElo); // Match with non-skill-based players AND skill-based players in their range
        });

        // Sort by creation time (oldest first)
        filteredRooms.sort((a, b) => a.createdAt - b.createdAt);

        // Get room at specified index
        const room = filteredRooms[index] || null;
        const roomCode = room ? room.code : null;

        res.json({ code: roomCode });
    } catch (error) {
        console.error('Error fetching room code:', error);
        res.status(500).json({ error: 'An error occurred while fetching the room code.' });
    }
});

// Find and form a team duel (2v2) match by combining rooms
matchmakingRouter.post('/find-team-duel', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: userId } = req.body;

    try {
        // Find the requesting user's room in the matchmaking queue
        const requestingRoom = matchmakingRoomCodes.find(room => room.userId === Number(userId) && room.type === 'team-duel');
        if (!requestingRoom) return res.status(400).json({ error: 'You do not have a team-duel room in the matchmaking queue.' });

        const requestingRoomId = requestingRoom.code;
        const roomCapacity = playSocketServer.rooms[requestingRoomId].size;
        const teamAmount = playSocketServer.getRoomStorage(requestingRoomId)?.teamAmount || 2;
        const maxPlayersPerTeam = Math.floor(roomCapacity / teamAmount);
        const requestingRoomPlayerCount = playSocketServer.rooms[requestingRoomId].participants.length;

        // Validate that this room doesn't have more players than allowed per team
        if (requestingRoomPlayerCount > maxPlayersPerTeam) {
            return res.status(400).json({ error: 'Your room has too many players for matchmaking.' });
        }

        // Lock the room to prevent additional players from joining after having started matchmaking
        playSocketServer.updateRoomStorage(requestingRoomId, "locked", "set", true);

        // Get all team-duel rooms with their current player counts
        const teamDuelRooms = matchmakingRoomCodes
            .filter(room => room.type === 'team-duel')
            .map(room => ({
                ...room,
                playerCount: playSocketServer.rooms[room.code]?.participants?.length || 0
            }));

        // Sort other rooms by player count (largest first) to find matches
        const otherRooms = teamDuelRooms
            .filter(r => r.code !== requestingRoomId)
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

export async function deleteMatchmakingRoom(code) {
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

// Webhook for OpenReport – kick banned players out of multiplayer immediately
matchmakingRouter.post('/openreport-webhook', standardLimiter, async (req, res) => {
    const signature = req.headers['x-webhook-signature'];

    try {
        if (verifyWebhook(req.body, signature, reportWebhookSecret)) {
            const { type, data = {} } = req.body;
            if (type === "blacklist-entry-added" || type === "blacklist-entry-added-manually") {
                const userId = Number(data.referenceId?.replace("user-", ""));
                const clientId = authedMultiplayerUserIds.get(userId);
                if (clientId) playSocketServer?.kick(clientId, "Banned.");
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