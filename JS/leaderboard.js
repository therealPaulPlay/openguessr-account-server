import express from 'express';
import { standardLimiter } from "./rateLimiters.js";
import { getDB } from "./dbConnection.js";
import { cacheResponse } from "./responseCache.js";
import cron from 'node-cron';
import { authenticateTokenWithId } from './authUtils.js';
import { RankApproximator } from './rankApproximator.js';

const leaderboardRouter = express.Router();

// Logarithmic buckets for XP (~80 buckets across 0-400M)
const xpRank = new RankApproximator('experience', {
    bucketExpr: 'FLOOR(LOG10(GREATEST(experience, 1)) * 10)',
    toBucket: v => Math.floor(Math.log10(Math.max(v, 1)) * 10),
    toUpperBound: v => Math.pow(10, (Math.floor(Math.log10(Math.max(v, 1)) * 10) + 1) / 10),
});

// Fixed-width 25-point buckets for elo
const eloBuckets = {
    bucketExpr: 'FLOOR(elo / 25)',
    toBucket: v => Math.floor(v / 25),
    toUpperBound: v => (Math.floor(v / 25) + 1) * 25,
    baseline: 1000,
};

const eloRank = new RankApproximator('elo', eloBuckets);
const eloActiveRank = new RankApproximator('elo', {
    ...eloBuckets,
    join: `JOIN (SELECT user1_id AS id FROM duel_entries UNION SELECT user2_id FROM duel_entries) active
        ON active.id = users.id`
});

// Endpoint for Top 100 leaderboard by experience
leaderboardRouter.get('/experience', standardLimiter, cacheResponse("experience-leaderboard"), async (req, res) => {
    const db = getDB();

    try {
        const leaderboardQuery = `
            SELECT user_name, experience, supporter_level, id,
                (@rank := @rank + 1) as position
            FROM users, (SELECT @rank := 0) r
            ORDER BY experience DESC
            LIMIT 100
        `;
        const [experienceLeaderboard] = await db.promise().execute(leaderboardQuery);
        res.json(experienceLeaderboard);
    } catch (err) {
        console.error("Error fetching leaderboard:", err);
        res.status(500).json({ error: 'An error occurred while fetching the leaderboard.' });
    }
});

// Endpoint for user-specific experience leaderboard
leaderboardRouter.put('/experience-user-section', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const userId = req.body.id;
    if (userId == null) return res.status(400).json({ error: 'User ID not provided.' });

    try {
        const [[user]] = await db.promise().execute(
            'SELECT user_name, experience, supporter_level FROM users WHERE id = ?', [userId]
        );
        if (!user) return res.status(404).json({ error: 'User not found.' });

        await xpRank.ensureLoaded();
        const userPosition = xpRank.getRank(user.experience);

        // Fetch the next player above within the same bucket
        const [[upperUser]] = await db.promise().execute(`
            SELECT user_name, experience, supporter_level, id
            FROM users
            WHERE experience > ? AND experience <= ?
            ORDER BY experience DESC
            LIMIT 1
        `, [user.experience, xpRank.toUpperBound(user.experience)]);

        if (!upperUser) return res.json([{ ...user, position: userPosition, id: userId }]);

        const upperUserPosition = Math.max(Math.min(xpRank.getRank(upperUser.experience), userPosition - 1), 1);

        res.json([
            { ...upperUser, position: upperUserPosition },
            { ...user, position: userPosition, id: userId }
        ]);
    } catch (err) {
        console.error(`Error fetching experience leaderboard for user ${userId}:`, err);
        res.status(500).json({ error: 'An error occurred while fetching the experience user leaderboard.' });
    }
});

// Elo Leaderboard Top 100
leaderboardRouter.get('/elo', standardLimiter, cacheResponse("elo-leaderboard"), async (req, res) => {
    const db = getDB();

    try {
        const leaderboardQuery = `
            SELECT user_name, elo, id, supporter_level,
                (@rank := @rank + 1) as position
            FROM users, (SELECT @rank := 0) r
            ORDER BY elo DESC
            LIMIT 100
        `;

        const [eloLeaderboard] = await db.promise().execute(leaderboardQuery);
        res.json(eloLeaderboard);
    } catch (err) {
        console.error("Error fetching elo leaderboard:", err);
        res.status(500).json({ error: 'An error occurred while fetching the elo leaderboard.' });
    }
});

// Elo leaderboard, but only active duel players
leaderboardRouter.get('/elo-active', standardLimiter, cacheResponse("elo-active-leaderboard"), async (req, res) => {
    const db = getDB();

    try {
        const leaderboardQuery = `
            SELECT u.user_name, u.elo, u.id, u.supporter_level,
                (@rank := @rank + 1) as position
            FROM users u, (SELECT @rank := 0) r
            WHERE EXISTS (SELECT 1 FROM duel_entries d WHERE d.user1_id = u.id)
            OR EXISTS (SELECT 1 FROM duel_entries d WHERE d.user2_id = u.id)
            ORDER BY u.elo DESC
            LIMIT 100
        `;

        const [eloLeaderboard] = await db.promise().execute(leaderboardQuery);
        res.json(eloLeaderboard);
    } catch (err) {
        console.error("Error fetching elo leaderboard:", err);
        res.status(500).json({ error: 'An error occurred while fetching the elo leaderboard.' });
    }
});

// Endpoint for user-specific elo leaderboard
leaderboardRouter.put('/elo-user-section', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const userId = req.body.id;
    if (userId == null) return res.status(400).json({ error: 'User ID not provided.' });

    try {
        const [[user]] = await db.promise().execute(
            'SELECT user_name, elo, supporter_level FROM users WHERE id = ?', [userId]
        );
        if (!user) return res.status(404).json({ error: 'User not found.' });

        await eloRank.ensureLoaded();
        const userPosition = eloRank.getRank(user.elo);

        const [[upperUser]] = await db.promise().execute(`
            SELECT user_name, elo, supporter_level, id
            FROM users
            WHERE elo > ? AND elo <= ?
            ORDER BY elo DESC
            LIMIT 1
        `, [user.elo, eloRank.toUpperBound(user.elo)]);

        if (!upperUser) return res.json([{ ...user, position: userPosition, id: userId }]);
        const upperUserPosition = Math.max(Math.min(eloRank.getRank(upperUser.elo), userPosition - 1), 1);

        res.json([
            { ...upperUser, position: upperUserPosition },
            { ...user, position: userPosition, id: userId }
        ]);
    } catch (err) {
        console.error(`Error fetching elo leaderboard for user ${userId}:`, err);
        res.status(500).json({ error: 'An error occurred while fetching the elo user leaderboard.' });
    }
});

// Endpoint for user-specific elo leaderboard, but only with active duel players
leaderboardRouter.put('/elo-active-user-section', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const userId = req.body.id;
    if (userId == null) return res.status(400).json({ error: 'User ID not provided.' });

    try {
        const [[row]] = await db.promise().execute(`
            SELECT u.user_name, u.elo, u.supporter_level,
            (EXISTS (SELECT 1 FROM duel_entries d WHERE d.user1_id = u.id)
            OR EXISTS (SELECT 1 FROM duel_entries d WHERE d.user2_id = u.id)) AS is_active
            FROM users u
            WHERE u.id = ?
        `, [userId]);
        if (!row) return res.status(404).json({ error: 'User not found.' });

        // The requesting user is ranked among the active players even when inactive, but we include a flag
        const { is_active, ...user } = row;
        user.isActive = Boolean(is_active);

        await eloActiveRank.ensureLoaded();
        const userPosition = eloActiveRank.getRank(user.elo);

        const [[upperUser]] = await db.promise().execute(`
            SELECT u.user_name, u.elo, u.supporter_level, u.id
            FROM users u
            WHERE u.elo > ? AND u.elo <= ?
            AND (EXISTS (SELECT 1 FROM duel_entries d WHERE d.user1_id = u.id)
            OR EXISTS (SELECT 1 FROM duel_entries d WHERE d.user2_id = u.id))
            ORDER BY u.elo DESC
            LIMIT 1
        `, [user.elo, eloActiveRank.toUpperBound(user.elo)]);

        if (!upperUser) return res.json([{ ...user, position: userPosition, id: userId }]);
        const upperUserPosition = Math.max(Math.min(eloActiveRank.getRank(upperUser.elo), userPosition - 1), 1);

        res.json([
            { ...upperUser, position: upperUserPosition },
            { ...user, position: userPosition, id: userId }
        ]);
    } catch (err) {
        console.error(`Error fetching active elo leaderboard for user ${userId}:`, err);
        res.status(500).json({ error: 'An error occurred while fetching the active elo user leaderboard.' });
    }
});

// Refresh the rank approximators every 10 minutes, spaced out so the load is spread out
const rankRefreshers = [
    ['experience', xpRank],
    ['elo', eloRank],
    ['active elo', eloActiveRank],
];
const REFRESH_SPACING = 3 * 60 * 1000;

cron.schedule('*/10 * * * *', () => {
    rankRefreshers.forEach(([name, approximator], index) => {
        setTimeout(async () => {
            try {
                await approximator.refresh();
            } catch (error) {
                console.error(`Error refreshing ${name} rank approximator:`, error);
            }
        }, index * REFRESH_SPACING);
    });
});

// Monthly resets -----------------------------------------------------------------------------------
cron.schedule('0 0 1 * *', async () => {
    try {
        const pool = getDB();

        // Halve elo above 2000 and convert the deducted amount into tokens
        await pool.promise().query(
            'UPDATE users SET tokens = COALESCE(tokens, 0) + CEIL((elo - 2000) / 2), elo = 2000 + FLOOR((elo - 2000) / 2) WHERE elo > 2000'
        );

        // Halve XP over 100M for players above 100M XP
        await pool.promise().query('UPDATE users SET experience = 100000000 + ROUND((experience - 100000000) / 2) WHERE experience > 100000000');

    } catch (error) {
        console.error('Error during monthly leaderboard resets:', error);
    }
});

export default leaderboardRouter;