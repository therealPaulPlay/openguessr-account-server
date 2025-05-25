const express = require('express');
const duelRouter = express.Router();
const { standardLimiter } = require("./rateLimiters.js");
const { authenticateTokenWithId } = require("./authUtils.js");
const { sendEventToClient } = require("./serverSentEvents.js");
const { getDB } = require("./dbConnection.js");
const cron = require("node-cron");
const { addUserToOngoingDuel, removeUserFromOngoingDuel } = require('./playSocketEvents.js');
const processDuelResult = require('./processDuelResult.js');

// Register duel endpoint ------------------------------------------------------------------------------------------------------------------------------
duelRouter.post('/duel-register/:uuid', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { uuid } = req.params;
    const { id: rawId } = req.body;
    const id = Number(rawId);
    if (!id) return res.status(400).json({ error: 'Player ID is required.' });

    const pool = getDB();
    let connection;

    try {
        connection = await pool.promise().getConnection();
        await connection.beginTransaction();
        // If no entry exists, insert a new row with user1_id = id.
        // If an entry exists:
        //   - If user1_id equals the new id, do nothing (this prevents duplicate registration).
        //   - If user2_id is null, update it to the new id.
        //   - Otherwise, leave the row unchanged.
        const [result] = await connection.query(
            `INSERT INTO duel_entries (uuid, user1_id, user2_id)
             VALUES (?, ?, NULL)
             ON DUPLICATE KEY UPDATE
             user2_id = CASE
                WHEN user1_id = VALUES(user1_id) THEN user2_id
                WHEN user2_id IS NULL THEN VALUES(user1_id)
                ELSE user2_id
             END`,
            [uuid, id]
        );

        // Fetch the duel entry to check its current state.
        const [rows] = await connection.execute(
            'SELECT user1_id, user2_id FROM duel_entries WHERE uuid = ?',
            [uuid]
        );
        if (!rows.length) throw new Error("Duel not found.");

        const entry = rows[0];
        let isFirstPlayer;

        if (entry.user1_id === id) {
            if (result.affectedRows === 0) {
                // If the same player calls this again, the query won’t change anything, affectedRows will be 0
                throw new Error("You are already registered for this duel.");
            }
            isFirstPlayer = true;
        } else if (entry.user2_id === id) {
            isFirstPlayer = false;
        } else {
            throw new Error("Duel already full.");
        }

        // Add user to ongoing duel – if they are not authenticated, this will throw an error!
        addUserToOngoingDuel(id, uuid);

        // Wait 5 seconds for the second player, otherwise close
        if (isFirstPlayer) {
            setTimeout(async () => {
                try {
                    const [duel] = await pool.promise().execute(
                        'SELECT * FROM duel_entries WHERE uuid = ? AND user2_id IS NULL',
                        [uuid]
                    );

                    // If second player did not register, send notification and delete entry
                    if (duel.length) {
                        await pool.promise().execute('DELETE FROM duel_entries WHERE uuid = ?', [uuid]);
                        sendEventToClient(id, {
                            type: 'duel-registration-error',
                            message: 'Other player did not register for the duel.'
                        });
                    }
                } catch (err) {
                    console.error('Error in registration timeout:', err);
                }
            }, 5000);
        }

        await connection.commit();
        res.status(201).json({ message: 'Duel registration successful.', isFirstPlayer });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error registering duel:', error);
        res.status(500).json({ error: `Error registering duel: ${error}` });
    } finally {
        if (connection) connection.release();
    }
});

// Submit duel result endpoint
duelRouter.post('/duel-result/:uuid', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { uuid } = req.params;
    const { id: rawId, result } = req.body;
    const id = Number(rawId);

    if (!id || result === undefined) return res.status(400).json({ error: 'Player ID and result are required.' });

    const pool = getDB();
    let connection;

    try {
        connection = await pool.promise().getConnection();
        await connection.beginTransaction();

        // Select and LOCK row (using for update) to ensure that in the end, one of the two players sees both entries
        const [duels] = await connection.execute(
            'SELECT * FROM duel_entries WHERE uuid = ? FOR UPDATE',
            [uuid]
        );
        if (!duels.length) throw new Error("Duel not found.");
        if (duels[0]?.processed !== 0) throw new Error("Duel already processed.");

        const isUser1 = Number(duels[0].user1_id) === id;
        const isUser2 = Number(duels[0].user2_id) === id;
        if (!isUser1 && !isUser2) throw new Error("You are not part of this duel.");

        // Update the result
        await connection.query(
            `UPDATE duel_entries SET 
             ${isUser1 ? 'user1_win' : 'user2_win'} = ?
             WHERE uuid = ?`,
            [result ? 1 : 0, uuid]
        );

        removeUserFromOngoingDuel(id); // Remove this player from ongoing duels

        await connection.commit();
        connection.release();

        // If both results are in now, pick a winner
        if ((isUser1 && duels[0]?.user2_win !== null) || (isUser2 && duels[0]?.user1_win !== null)) await processDuelResult(uuid);
        res.status(200).json({ message: 'Result submitted successfully.' });

    } catch (error) {
        if (connection) {
            await connection.rollback();
            connection.release();
        }
        console.error('Error submitting duel result:', error);
        res.status(500).json({ error: 'Error occurred submitting duel result: ' + error });
    }
});

// Get duel history ----------------------------------------------------------------------------------------------------------------------------------------------------
duelRouter.get('/duel-history', standardLimiter, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = 50;
    const offset = (page - 1) * limit;
    const userId = req.query.id;
    const pool = getDB();

    try {
        let query = `
        SELECT
          uuid,
          user1_id,
          user2_id,
          user1_name,
          user2_name,
          user1_win,
          user2_win,
          created_at
        FROM duel_entries
        WHERE processed = 1
      `;

        const queryParams = [];

        // Add ID filter if provided
        if (userId) {
            query += ` AND (user1_id = ? OR user2_id = ?)`;
            queryParams.push(userId, userId);
        }

        // Add ordering and pagination
        query += ` ORDER BY id DESC LIMIT ? OFFSET ?`;
        queryParams.push(limit, offset);

        const [duels] = await pool.promise().query(query, queryParams);

        const response = {
            duels: duels.map(duel => ({
                uuid: duel.uuid,
                player1: {
                    id: duel.user1_id,
                    name: duel.user1_name,
                    won: duel.user1_win === 1,
                    left: duel.user1_win === null
                },
                player2: {
                    id: duel.user2_id,
                    name: duel.user2_name,
                    won: duel.user2_win === 1,
                    left: duel.user2_win === null
                },
                timestamp: duel.created_at
            }))
        };

        res.status(200).json(response);
    } catch (error) {
        console.error('Error fetching duel history:', error);
        res.status(500).json({ error: 'An error occurred while fetching duel history.' });
    }
});

// Reset Elo above 2000 to 2000 on the 1st of each month and delete old duel entries -----------------------------------------------------------------------
cron.schedule('0 1 1 * *', async () => {
    try {
        const pool = getDB();
        await pool.promise().query('UPDATE users SET elo = 2000 WHERE elo > 2000');

        // Delete duel entries older than x days
        await pool.promise().query(
            'DELETE FROM duel_entries WHERE created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)'
        );
    } catch (error) {
        console.error('Error during monthly ELO reset and cleanup:', error);
    }
});

module.exports = duelRouter;