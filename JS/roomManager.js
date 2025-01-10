const express = require('express');
const roomRouter = express.Router();
const { standardLimiter } = require("./rateLimiters.js");
const { authenticateTokenWithId } = require("./authUtils.js");
const { getDB } = require("./dbConnection.js");

// Post endpoint: /accounts/rooms/host/:code
roomRouter.post('/host/:code', standardLimiter, authenticateTokenWithId, async (req, res) => {
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

// Get endpoint: /accounts/rooms/:index
roomRouter.get('/:index', standardLimiter, async (req, res) => {
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

// Delete endpoint: /accounts/rooms/delete/:code
roomRouter.delete('/delete/:code', standardLimiter, authenticateTokenWithId, async (req, res) => {
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

// Periodic cleanup function to delete room codes older than 10 seconds
const CLEANUP_INTERVAL = 10000; // 10 seconds

setTimeout(() => {
    setInterval(async () => {
        const db = getDB();

        try {
            const deleteQuery = 'DELETE FROM room_code WHERE creation_date < NOW() - INTERVAL 10 SECOND';
            await new Promise((resolve, reject) => {
                db.query(deleteQuery, (err, results) => {
                    if (err) return reject(err);
                    resolve(results);
                });
            });

            console.log('Old room codes cleaned up successfully.');
        } catch (error) {
            console.error('Error during room code cleanup:', error);
        }
    }, CLEANUP_INTERVAL);
}, 1000 * 5 * Math.floor(Math.random())); // Delay the start by 0 - 5 seconds to ensure that if multiple servers are running, this query doesn't execute at the exact same time. 

module.exports = roomRouter;