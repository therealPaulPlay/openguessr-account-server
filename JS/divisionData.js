import express from 'express';
import { standardLimiter } from "./rateLimiters.js";
import { getDB } from "./dbConnection.js";
import { cacheResponse } from "./responseCache.js";
import cron from "node-cron";

const divisionDataRouter = express.Router();

// Get duel history ----------------------------------------------------------------------------------------------------------------------------------------------------
divisionDataRouter.get('/duel-history', standardLimiter, cacheResponse("duel-history", 1000), async (req, res) => {
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
                elo_change,
                refunded,
                created_at
            FROM duel_entries
        `;

        const queryParams = [];

        // Add ID filter if provided
        if (userId) {
            query += ` WHERE (user1_id = ? OR user2_id = ?)`;
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
                    won: Boolean(duel.user1_win)
                },
                player2: {
                    id: duel.user2_id,
                    name: duel.user2_name,
                    won: Boolean(duel.user2_win)
                },
                eloChange: duel.elo_change,
                refunded: Boolean(duel.refunded),
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

        // Delete duel entries older than 2 weeks
        await pool.promise().query(
            'DELETE FROM duel_entries WHERE created_at < DATE_SUB(NOW(), INTERVAL 14 DAY)'
        );
    } catch (error) {
        console.error('Error during monthly duel entry cleanup:', error);
    }
});

export default divisionDataRouter;