const express = require('express');
const divisionDataRouter = express.Router();
const { standardLimiter } = require("./rateLimiters.js");
const { getDB } = require("./dbConnection.js");
const cron = require("node-cron");

// Get duel history ----------------------------------------------------------------------------------------------------------------------------------------------------
divisionDataRouter.get('/duel-history', standardLimiter, async (req, res) => {
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
                    won: duel.user1_win === 1
                },
                player2: {
                    id: duel.user2_id,
                    name: duel.user2_name,
                    won: duel.user2_win === 1
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

// Delete old duel entries at the start of each month -----------------------------------------------------------------------
cron.schedule('0 2 1 * *', async () => {
    try {
        const pool = getDB();

        // Delete duel entries older than x days
        await pool.promise().query(
            'DELETE FROM duel_entries WHERE created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)'
        );
    } catch (error) {
        console.error('Error during monthly duel entry cleanup:', error);
    }
});

module.exports = divisionDataRouter;