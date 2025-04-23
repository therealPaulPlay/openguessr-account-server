const express = require('express');
const duelRouter = express.Router();
const { standardLimiter } = require("./rateLimiters.js");
const { authenticateTokenWithId } = require("./authUtils.js");
const { sendEventToClient } = require("./serverSentEvents.js");
const { getDB } = require("./dbConnection.js");
const cron = require("node-cron");

const calculateEloChange = (winnerElo, loserElo) => {
    const K = 32;
    const eloDiff = Math.abs(winnerElo - loserElo);
    const expectedScore = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));

    // Ensure minimum gain of 1 unless difference is extreme (>1500)
    if (eloDiff > 1500) return 0;
    const change = Math.max(5, Math.min(30, Math.round(K * (1 - expectedScore))));
    return change;
};

// Helper function to process duel results
async function processDuelResult(connection, late = false, uuid) {
    const [duels] = await connection.query(
        'SELECT * FROM duel_entries WHERE uuid = ? AND processed = 0 FOR UPDATE', // Only allow processing duels that aren't already processed
        [uuid]
    );

    let winner;
    let loser;

    // Check which player did not submit a result, and pick winner + loser accordingly
    if (duels.length) {
        if (duels[0].user1_win !== null && duels[0].user2_win !== null) {
            if (duels[0].user1_win === duels[0].user2_win) {
                // Notify both players of the suspicious submission
                [duels[0].user1_id, duels[0].user2_id].forEach(playerId => {
                    sendEventToClient(playerId, {
                        type: 'duel-result-error',
                        message: `Both players submitted the same result. This can happen when the p2p connection drops and both players finish independently. Player 1: ${duels[0].user1_id}, Player 2: ${duels[0].user2_id}.`
                    });
                });
                console.error(`Both players submitted the same result - IDs: Player 1: ${duels[0].user1_id}, Player 2: ${duels[0].user2_id}`);
                // Delete the duel entry so that no result is recorded
                await connection.query('DELETE FROM duel_entries WHERE uuid = ?', [uuid]);
                return;
            }
            winner = duels[0].user1_win ? duels[0].user1_id : duels[0].user2_id;
            loser = duels[0].user1_win ? duels[0].user2_id : duels[0].user1_id;

        } else if (duels[0].user1_win !== null || duels[0].user2_win !== null) {
            winner = duels[0].user1_win !== null ? duels[0].user1_id : duels[0].user2_id;
            loser = duels[0].user1_win !== null ? duels[0].user2_id : duels[0].user1_id;
        } else {
            await connection.query('DELETE FROM duel_entries WHERE uuid = ?', [uuid]); // Remove entry if both results are null
            return;
        }
    } else {
        return; // If the duel doesn't exist, exit
    }

    const [players] = await connection.query(
        'SELECT id, user_name, elo FROM users WHERE id IN (?, ?) FOR UPDATE',
        [winner, loser]
    );

    if (players.length !== 2) {
        throw new Error('One or both users not found');
    }

    const winningPlayer = players.find(p => Number(p.id) === Number(winner));
    const losingPlayer = players.find(p => Number(p.id) === Number(loser));
    const eloChange = calculateEloChange(winningPlayer.elo, losingPlayer.elo);

    // Update duel entry with names using the uuid, and set processed = 1 (true)
    await connection.query(
        `UPDATE duel_entries SET 
            user1_name = CASE WHEN user1_id = ? THEN ? ELSE ? END,
            user2_name = CASE WHEN user2_id = ? THEN ? ELSE ? END,
            processed = 1
        WHERE uuid = ?`,
        [
            winningPlayer.id, winningPlayer.user_name, losingPlayer.user_name,  // For user1_name
            winningPlayer.id, winningPlayer.user_name, losingPlayer.user_name,  // For user2_name
            uuid
        ]
    );

    // Update users' ELO (after setting processed)
    await connection.query(
        'UPDATE users SET elo = CASE ' +
        'WHEN id = ? THEN elo + ? ' +
        'WHEN id = ? THEN GREATEST(0, elo - ?) ' +
        'END WHERE id IN (?, ?)',
        [winningPlayer.id, eloChange, losingPlayer.id, eloChange, winningPlayer.id, losingPlayer.id]
    );

    // Send WebSocket notifications
    const eloChanges = { [winningPlayer.id]: eloChange, [losingPlayer.id]: -eloChange };
    const resultMessage = {
        type: late ? 'duel-late-result' : 'duel-result',
        eloChanges
    };

    [winningPlayer.id, losingPlayer.id].forEach(playerId => {
        sendEventToClient(playerId, resultMessage);
    });
}

// Register duel endpoint
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
        const [rows] = await connection.query(
            'SELECT user1_id, user2_id FROM duel_entries WHERE uuid = ?',
            [uuid]
        );
        if (!rows.length) {
            await connection.rollback();
            return res.status(400).json({ error: 'Duel entry not found.' });
        }
        const entry = rows[0];
        let isFirstPlayer;

        if (entry.user1_id === id) {
            // Note: if the same player calls this again, the query won’t change anything,
            // and MySQL will report affectedRows = 0. In that case, we treat it as a duplicate.
            if (result.affectedRows === 0) {
                await connection.rollback();
                return res.status(400).json({ error: 'You are already registered for this duel.' });
            }
            isFirstPlayer = true;
        } else if (entry.user2_id === id) {
            isFirstPlayer = false;
        } else {
            await connection.rollback();
            return res.status(400).json({ error: 'This duel is already full.' });
        }

        // Set up timeouts for duel registration cleanup or result submission.
        if (isFirstPlayer) {
            // For the first player, wait 5 seconds for a second player.
            setTimeout(async () => {
                try {
                    const [duel] = await pool.promise().query(
                        'SELECT * FROM duel_entries WHERE uuid = ? AND user2_id IS NULL',
                        [uuid]
                    );

                    // If second player did not register, send notification + remove entry
                    if (duel.length) {
                        await pool.promise().query('DELETE FROM duel_entries WHERE uuid = ?', [uuid]);

                        // SSE
                        sendEventToClient(id, {
                            type: 'duel-registration-error',
                            message: 'Other player did not register for the duel.'
                        });
                    }
                } catch (err) {
                    console.error('Error in registration cleanup:', err);
                }
            }, 5000);
        } else {
            // For the second player, set a 10-minute timeout for result submission.
            setTimeout(async () => {
                await handleTimeoutResult(uuid);
            }, 10 * 60000);
        }

        await connection.commit();
        res.status(201).json({
            message: 'Duel registration successful.',
            isFirstPlayer
        });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error registering duel:', error);
        res.status(500).json({ error: 'An error occurred while registering the duel.' });
    } finally {
        if (connection) connection.release();
    }
});

// Handle timeout result
async function handleTimeoutResult(uuid) {
    const pool = getDB();
    let connection;

    try {
        connection = await pool.promise().getConnection();
        await connection.beginTransaction();
        await processDuelResult(connection, true, uuid);
        await connection.commit();
    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error processing timeout result:', error);
    } finally {
        if (connection) connection.release();
    }
}

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

        const [duels] = await connection.query(
            'SELECT * FROM duel_entries WHERE uuid = ? FOR UPDATE',
            [uuid]
        );

        if (!duels.length || duels[0]?.processed !== 0) {
            await connection.rollback();
            return res.status(404).json({ error: 'Duel not found or already processed.' });
        }

        const isUser1 = Number(duels[0].user1_id) === id;
        const isUser2 = Number(duels[0].user2_id) === id;

        if (!isUser1 && !isUser2) {
            await connection.rollback();
            return res.status(403).json({ error: 'You are not part of this duel.' });
        }

        // Update the result
        await connection.query(
            `UPDATE duel_entries SET 
             ${isUser1 ? 'user1_win' : 'user2_win'} = ?
             WHERE uuid = ?`,
            [result ? 1 : 0, uuid]
        );

        // Check if both players have submitted results
        const [updatedDuelRows] = await connection.query(
            'SELECT * FROM duel_entries WHERE uuid = ? FOR UPDATE',
            [uuid]
        );

        // If both results are in now...
        if (updatedDuelRows[0].user1_win !== null && updatedDuelRows[0].user2_win !== null) {
            await processDuelResult(connection, false, uuid);
        }

        await connection.commit();
        res.status(200).json({ message: 'Result submitted successfully.' });
    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error processing duel result:', error);
        res.status(500).json({ error: 'Error occurred submitting duel result: ' + error });
    } finally {
        if (connection) connection.release();
    }
});

// Get duel history ---------------------------------------------------------------------------------------------------------------
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