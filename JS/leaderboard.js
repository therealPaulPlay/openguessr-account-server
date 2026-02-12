import express from 'express';
import { standardLimiter } from "./rateLimiters.js";
import { getDB } from "./dbConnection.js";
import cron from 'node-cron';

const leaderboardRouter = express.Router();

// Helper functions for cache
async function calculateSegments(targetSegments = 50) {
    const db = getDB();

    try {
        const query = `
            SELECT 
                MIN(experience) as min_exp,
                MAX(experience) as max_exp,
                COUNT(*) as total_players
            FROM users
            WHERE experience > 0
        `;
        const [[stats]] = await db.promise().execute(query);

        const segments = [];
        const ratio = Math.pow(stats.max_exp / Math.max(1, stats.min_exp), 1 / targetSegments);

        let current = 0;
        for (let i = 0; i < targetSegments; i++) {
            const next = Math.round(i === 0 ? stats.min_exp : current * ratio);
            segments.push({
                lower: current,
                upper: next
            });
            current = next + 1;
        }

        return segments;
    } catch (error) {
        console.error('Error calculating segments:', error);
        throw error;
    }
}

async function updateCache() {
    console.log('Starting leaderboard cache update...');
    const db = getDB();
    let connection;

    try {
        connection = await db.promise().getConnection();

        // Get advisory lock to prevent concurrent updates
        const lockResult = await connection.execute('SELECT GET_LOCK(?, 0) as lock_acquired', ['leaderboard_update']);
        if (!lockResult[0][0].lock_acquired) throw new Error('Could not acquire lock for leaderboard update');

        const segments = await calculateSegments();

        await connection.beginTransaction();
        await connection.query('TRUNCATE TABLE leaderboard_cache');

        for (let i = 0; i < segments.length; i++) {
            const segment = segments[i];
            const query = `
                INSERT INTO leaderboard_cache
                (leaderboard_rank, experience_lower_bound, experience_upper_bound,
                 players_in_range, max_experience_in_range)
                SELECT
                    ?,
                    ?,
                    ?,
                    COUNT(*),
                    IFNULL(MAX(experience), 0)
                FROM users
                WHERE experience > ? AND experience <= ?
            `;
            await connection.execute(query, [
                i + 1,
                segment.lower,
                segment.upper,
                segment.lower,
                segment.upper
            ]);
        }

        await connection.commit();
        console.log('Leaderboard cache update completed successfully.');

        // Release the lock
        await connection.execute('SELECT RELEASE_LOCK(?)', ['leaderboard_update']);

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error updating leaderboard cache:', error);

        try {
            // Make sure to release lock even on error
            if (connection) await connection.execute('SELECT RELEASE_LOCK(?)', ['leaderboard_update']);
        } catch (lockError) {
            console.error('Error releasing lock:', lockError);
        }
    } finally {
        if (connection) connection.release();
    }
}

async function getPlayerRank(experience) {
    const db = getDB();

    try {
        const query = `
        SELECT 
            lc.leaderboard_rank,
            (
                SELECT SUM(players_in_range)
                FROM leaderboard_cache
                WHERE experience_upper_bound >= ?
            ) as approximate_rank
        FROM leaderboard_cache lc
        WHERE ? > lc.experience_lower_bound
        AND ? <= lc.experience_upper_bound
    `;

        const [[result]] = await db.promise().execute(query, [experience, experience, experience]);
        return result ? result.approximate_rank : null;
    } catch (error) {
        console.error('Error getting player rank:', error);
        throw error;
    }
}

// Endpoint for Top 100 leaderboard by experience
leaderboardRouter.get('/experience', standardLimiter, async (req, res) => {
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

// Endpoint for user-specific leaderboard
leaderboardRouter.get('/experience-user-section/:id', standardLimiter, async (req, res) => {
    const db = getDB();
    const userId = req.params.id;

    try {
        // Fetch the user's details (name, experience, and supporter level) from the database
        const [[user]] = await db.promise().execute(`
            SELECT user_name, experience, supporter_level
            FROM users 
            WHERE id = ?
        `, [userId]);

        if (!user) return res.status(404).json({ error: 'User not found.' });

        // Default position for the user (0 XP gets "Max.")
        const userPosition = user.experience === 0 ? "Max." : `~${await getPlayerRank(user.experience) || 0}`;

        // If user has no experience, return only their data
        if (user.experience === 0) return res.json([{ ...user, position: userPosition, id: userId }]);

        // Fetch user's bracket details (lower/upper bounds and players_in_range)
        const [[currentBracket]] = await db.promise().execute(`
            SELECT experience_upper_bound, players_in_range
            FROM leaderboard_cache
            WHERE ? > experience_lower_bound AND ? <= experience_upper_bound
        `, [user.experience, user.experience]);
        if (!currentBracket) return res.json([{ ...user, position: userPosition, id: userId }]);

        // Fetch the upper player within the bracket, ordered by experience (desc)
        const [[upperUser]] = await db.promise().execute(`
            SELECT user_name, experience, supporter_level, id
            FROM users
            WHERE experience > ? AND experience <= ?
            ORDER BY experience DESC
            LIMIT 1
        `, [user.experience, currentBracket.experience_upper_bound]);

        // If no upper user found, just return the user's data
        if (!upperUser) return res.json([{ ...user, position: userPosition, id: userId }]);

        // Calculate the rank of the upper user based on players_in_range
        const halfPlayersInRange = Math.floor(currentBracket.players_in_range / 2);
        const upperUserPosition = `~${Math.max(await getPlayerRank(user.experience) - halfPlayersInRange, 1)}`;

        // Combine the upper user and the current user
        res.json([
            { ...upperUser, position: upperUserPosition },
            { ...user, position: userPosition, id: userId }
        ]);
    } catch (err) {
        console.error(`Error fetching leaderboard for user ${userId}:`, err);
        res.status(500).json({ error: 'An error occurred while fetching the user leaderboard.' });
    }
});

// Elo Leaderboard Top 100
leaderboardRouter.get('/elo', standardLimiter, async (req, res) => {
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

// Run Cached leaderboard update every 10 minutes
cron.schedule('*/10 * * * *', async () => {
    console.log('Running leaderboard cache update...');
    await updateCache();
});

// Monthly resets -----------------------------------------------------------------------------------
cron.schedule('0 0 1 * *', async () => {
    try {
        const pool = getDB();

        // Convert excess elo to tokens before resetting
        await pool.promise().query(
            'UPDATE users SET tokens = COALESCE(tokens, 0) + (elo - 2000) WHERE elo > 2000'
        );

        // Reset elo to 2000 for players above 2000
        await pool.promise().query('UPDATE users SET elo = 2000 WHERE elo > 2000');

        // Halve XP over 100M for players above 100M XP
        await pool.promise().query('UPDATE users SET experience = 100000000 + ROUND((experience - 100000000) / 2) WHERE experience > 100000000');

    } catch (error) {
        console.error('Error during monthly leaderboard resets:', error);
    }
});

export default leaderboardRouter;