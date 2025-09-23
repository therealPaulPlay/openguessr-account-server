import express from 'express';
import { standardLimiter } from "./rateLimiters.js";
import { authenticateTokenWithId } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import { authedMultiplayerUserIds, checkIfUserIsAuthedAndInRoom, playSocketServer, validateDuelRoom } from './playSocketEvents.js';
import crypto from 'crypto';
import { reportWebhookSecret } from './config.js';

const roomRouter = express.Router();

// Post endpoint: /accounts/rooms/host-duel/:code
roomRouter.post('/host-duel/:code', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { code } = req.params;
    const { id: userId, skillBased } = req.body;

    if (!code || !userId) {
        return res.status(400).json({ error: 'Code and user ID are required.' });
    }

    try {
        if (!checkIfUserIsAuthedAndInRoom(code, userId)) return res.status(400).json({ error: 'Room does not exist, you are not part of it, or you are not authenticated.' });
        if (!validateDuelRoom(code)) return res.status(400).json({ error: 'This room is not a division room.' });

        // Delete any existing room with this user ID
        const deleteExistingRoomQuery = 'DELETE FROM room_code WHERE user_id = ?';
        await new Promise((resolve, reject) => {
            db.execute(deleteExistingRoomQuery, [userId], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        // Get user's ELO from the users table
        const getUserEloQuery = 'SELECT elo FROM users WHERE id = ?';
        const userData = await new Promise((resolve, reject) => {
            db.execute(getUserEloQuery, [userId], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (!userData) return res.status(404).json({ error: 'User not found.' });
        const userElo = userData.elo;

        // Insert new room code with ELO
        const insertQuery = 'INSERT INTO room_code (id, code, creation_date, user_id, user_elo, skill_based) VALUES (UUID(), ?, NOW(), ?, ?, ?)';
        await new Promise((resolve, reject) => {
            db.execute(insertQuery, [code, userId, userElo, skillBased ? 1 : 0], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        res.status(201).json({ message: 'Room code created successfully.' });
    } catch (error) {
        console.error('Error creating room code:', error);
        res.status(500).json({ error: 'An error occurred while creating the room code.' });
    }
});

roomRouter.post('/join-duel/:index', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { id: userId } = req.body;
    const index = parseInt(req.params.index, 10);
    const userElo = parseInt(req.query.elo, 10) || 1000; // Default to 1000 if not provided
    const wantSkillBased = req.query['skill-based'] === 'true'; // Only true if explicitly set to 'true'

    if (isNaN(index) || index < 0) return res.status(400).json({ error: 'Invalid index.' });

    try {
        // Find user's ELO division
        const breakpoints = [0, 1200, 1400, 1600, 2000, 100000];
        let divIndex = 0;
        while (divIndex < breakpoints.length - 1 && userElo >= breakpoints[divIndex + 1]) divIndex++;

        const minElo = breakpoints[divIndex];
        const maxElo = breakpoints[divIndex + 1];

        let whereClause, queryParams;

        if (wantSkillBased) {
            // User wants skill-based: Only match with players in their ELO range
            whereClause = `WHERE user_elo >= ? AND user_elo < ?`;
            queryParams = [minElo, maxElo];
        } else {
            // User takes anyone: Match with non-skill-based players AND skill-based players in their range
            whereClause = `WHERE skill_based = 0 OR skill_based IS NULL OR
                     (skill_based = 1 AND user_elo >= ? AND user_elo < ?)`;
            queryParams = [minElo, maxElo];
        }

        const selectQuery = `
        SELECT code
        FROM room_code
        ${whereClause} AND user_id != ?
        ORDER BY creation_date
        LIMIT 1 OFFSET ?
        `;

        const roomCode = await new Promise((resolve, reject) => {
            queryParams.push(Number(userId), index); // Add userId and index to the query parameters
            db.query(selectQuery, queryParams, (err, results) => {
                if (err) return reject(err);
                resolve(results[0]?.code || null);
            });
        });

        res.json({ code: roomCode });
    } catch (error) {
        console.error('Error fetching room code:', error);
        res.status(500).json({ error: 'An error occurred while fetching the room code.' });
    }
});

// Delete endpoint: /accounts/rooms/delete-duel/:code
roomRouter.delete('/delete-duel/:code', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { code } = req.params;
    const { id: userId } = req.body;

    if (!code || !userId) {
        return res.status(400).json({ error: 'Code and user ID are required.' });
    }

    try {
        // Delete the room code from the database
        const deleteQuery = 'DELETE FROM room_code WHERE code = ? AND user_id = ?';
        const result = await new Promise((resolve, reject) => {
            db.execute(deleteQuery, [code, userId], (err, results) => {
                if (err) return reject(err);
                resolve(results.affectedRows);
            });
        });

        if (result === 0) {
            return res.status(404).json({ error: 'Room code not found or not owned by user.' });
        }

        res.json({ message: 'Room code deleted successfully.' });
    } catch (error) {
        console.error('Error deleting room code:', error);
        res.status(500).json({ error: 'An error occurred while deleting the room code.' });
    }
});

// Time ------------------------------------------------------------------------------------------------------------------------------
// Get current timestamp (for timer resume etc.)
roomRouter.get('/time/timestamp', standardLimiter, async (req, res) => {
    try {
        res.json({ timestamp: Date.now() });
    } catch (error) {
        console.error('Error getting timestamp:', error);
        res.status(500).json({ error: 'Failed to get timestamp.' });
    }
});

// Open Rooms ------------------------------------------------------------------------------------------------------------------------
// Create an open room
roomRouter.post('/open-room/:code', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { code } = req.params;
    const { id, playerCount, map } = req.body;

    if (!code || !id || !playerCount || !map) {
        return res.status(400).json({ error: 'Code, ID, player count, and map are required.' });
    }

    try {
        if (!checkIfUserIsAuthedAndInRoom(code, id)) return res.status(400).json({ error: 'Room does not exist or you are not part of it.' });

        // Check for existing room code and update if found
        const upsertQuery = `
            INSERT INTO open_rooms (room_code, player_count, map, created_at, creator_id)
            VALUES (?, ?, ?, NOW(), ?)
            ON DUPLICATE KEY UPDATE
                player_count = VALUES(player_count),
                map = VALUES(map),
                created_at = NOW()
        `;

        await new Promise((resolve, reject) => {
            db.execute(upsertQuery, [code, playerCount, map, id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        res.status(201).json({ message: 'Open room created/updated successfully.' });
    } catch (error) {
        console.error('Error creating/updating open room:', error);
        res.status(500).json({ error: 'An error occurred while creating/updating the open room.' });
    }
});

// List all open rooms
roomRouter.get('/list-open-rooms', standardLimiter, async (req, res) => {
    const db = getDB();

    try {
        const selectQuery = `
            SELECT room_code, player_count, map, created_at
            FROM open_rooms
            WHERE created_at > NOW() - INTERVAL 10 SECOND
            ORDER BY player_count DESC
            LIMIT 50
        `;
        const rooms = await new Promise((resolve, reject) => {
            db.query(selectQuery, (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        res.json({ rooms });
    } catch (error) {
        console.error('Error fetching open rooms:', error);
        res.status(500).json({ error: 'An error occurred while fetching open rooms.' });
    }
});

// Delete an open room
roomRouter.delete('/open-room/:code', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { code } = req.params;
    const { id } = req.body;

    if (!code || !id) return res.status(400).json({ error: 'Code and ID are required.' });

    try {
        const deleteQuery = 'DELETE FROM open_rooms WHERE room_code = ? AND creator_id = ?';
        const result = await new Promise((resolve, reject) => {
            db.execute(deleteQuery, [code, id], (err, results) => {
                if (err) return reject(err);
                resolve(results.affectedRows);
            });
        });

        if (result === 0) return res.status(404).json({ error: 'Open room not found or not owned by you.' });

        res.json({ message: 'Open room deleted successfully.' });
    } catch (error) {
        console.error('Error deleting open room:', error);
        res.status(500).json({ error: 'An error occurred while deleting the open room.' });
    }
});

// Webhook for OpenReport – kick banned players out of multiplayer immediately
roomRouter.post('/openreport-webhook', standardLimiter, async (req, res) => {
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

// Cleanup ---------------------------------------------------------------------------------------------------------------------------------
// Periodic cleanup function to delete room codes older than 10 seconds
const CLEANUP_INTERVAL = 10000; // 10 seconds

setTimeout(() => {
    setInterval(async () => {
        const db = getDB();

        try {
            // Delete old room codes
            const deleteRoomCodesQuery = 'DELETE FROM room_code WHERE creation_date < NOW() - INTERVAL 10 SECOND';
            await new Promise((resolve, reject) => {
                db.execute(deleteRoomCodesQuery, (err, results) => {
                    if (err) return reject(err);
                    resolve(results);
                });
            });

            // Delete old open rooms
            const deleteOpenRoomsQuery = 'DELETE FROM open_rooms WHERE created_at < NOW() - INTERVAL 10 SECOND';
            await new Promise((resolve, reject) => {
                db.execute(deleteOpenRoomsQuery, (err, results) => {
                    if (err) return reject(err);
                    resolve(results);
                });
            });

            console.log('Old room codes and open rooms cleaned up successfully.');
        } catch (error) {
            console.error('Error during cleanup:', error);
        }
    }, CLEANUP_INTERVAL);
}, 1000 * 5 * Math.floor(Math.random())); // Delay the start by 0 - 5 seconds - if multiple servers are running, this doesn't execute at the same time. 

export default roomRouter;