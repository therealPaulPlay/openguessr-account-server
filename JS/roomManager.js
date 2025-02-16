const express = require('express');
const roomRouter = express.Router();
const { standardLimiter } = require("./rateLimiters.js");
const { authenticateTokenWithId } = require("./authUtils.js");
const { getDB } = require("./dbConnection.js");

// Post endpoint: /accounts/rooms/host-duel/:code
roomRouter.post('/host-duel/:code', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { code } = req.params;
    const { id: userId } = req.body;

    if (!code || !userId) {
        return res.status(400).json({ error: 'Code and user ID are required.' });
    }

    try {
        // First, check for existing room code
        const checkCodeQuery = 'SELECT id FROM room_code WHERE code = ?';
        const existingRoom = await new Promise((resolve, reject) => {
            db.query(checkCodeQuery, [code], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (existingRoom) {
            return res.status(409).json({ error: 'Room code already exists in the db. Try again in 10s.' });
        }

        // Check and delete any existing entry for this user
        const deleteQuery = 'DELETE FROM room_code WHERE user_id = ?';
        await new Promise((resolve, reject) => {
            db.query(deleteQuery, [userId], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        // Insert new room code
        const insertQuery = 'INSERT INTO room_code (id, code, creation_date, user_id) VALUES (UUID(), ?, NOW(), ?)';
        await new Promise((resolve, reject) => {
            db.query(insertQuery, [code, userId], (err, results) => {
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

// Get endpoint: /accounts/rooms/join-duel/:index
roomRouter.get('/join-duel/:index', standardLimiter, async (req, res) => {
    const db = getDB();
    const index = parseInt(req.params.index, 10);

    if (isNaN(index) || index < 0) {
        return res.status(400).json({ error: 'Invalid index.' });
    }

    try {
        // Query to get the room code at the specified index
        const selectQuery = `
            SELECT code
            FROM room_code
            ORDER BY creation_date
            LIMIT 1 OFFSET ?
        `;
        const roomCode = await new Promise((resolve, reject) => {
            db.query(selectQuery, [index], (err, results) => {
                if (err) return reject(err);
                resolve(results[0] ? results[0].code : null);
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
            db.query(deleteQuery, [code, userId], (err, results) => {
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
            db.query(upsertQuery, [code, playerCount, map, id], (err, results) => {
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

    if (!code || !id) {
        return res.status(400).json({ error: 'Code and ID are required.' });
    }

    try {
        const deleteQuery = 'DELETE FROM open_rooms WHERE room_code = ?';
        const result = await new Promise((resolve, reject) => {
            db.query(deleteQuery, [code], (err, results) => {
                if (err) return reject(err);
                resolve(results.affectedRows);
            });
        });

        if (result === 0) {
            return res.status(404).json({ error: 'Open room not found.' });
        }

        res.json({ message: 'Open room deleted successfully.' });
    } catch (error) {
        console.error('Error deleting open room:', error);
        res.status(500).json({ error: 'An error occurred while deleting the open room.' });
    }
});

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
                db.query(deleteRoomCodesQuery, (err, results) => {
                    if (err) return reject(err);
                    resolve(results);
                });
            });

            // Delete old open rooms
            const deleteOpenRoomsQuery = 'DELETE FROM open_rooms WHERE created_at < NOW() - INTERVAL 10 SECOND';
            await new Promise((resolve, reject) => {
                db.query(deleteOpenRoomsQuery, (err, results) => {
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

module.exports = roomRouter;