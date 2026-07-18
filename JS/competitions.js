import fs from 'fs';
import express from 'express';
import { standardLimiter, rankingLimiter, createCompetitionLimiter } from "./rateLimiters.js";
import { authenticateTokenWithId } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import { body, validationResult } from 'express-validator';
import { updateProfileData } from './dbWriteHelpers.js';
import { fetchReportData } from './reportFetch.js';
import { check } from 'fast-profanity-filter';
import { cacheResponse, clearResponseCache } from "./responseCache.js";
import { isValidMap } from './communityMaps.js';

const competitionsRouter = express.Router();

function clearCompetitionListCaches() {
    clearResponseCache("competitions-active");
    clearResponseCache("competitions-expired");
}

// Helper functions
const getSecondsUntilNextUTC = () => {
    const now = new Date();
    const nextUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    return Math.floor((nextUTC - now) / 1000);
};

const createDailyCompetition = async () => {
    try {
        const data = fs.readFileSync('./JSON/dailyLocations.json', 'utf8');
        const dailyLocations = JSON.parse(data);

        if (!dailyLocations.locations || !Array.isArray(dailyLocations.locations) || dailyLocations.locations.length === 0) {
            throw new Error('Invalid or empty locations array in dailyLocations.json');
        }

        const randomLocation = dailyLocations.locations[Math.floor(Math.random() * dailyLocations.locations.length)]
            .map(coord => parseFloat(coord));

        if (randomLocation.length !== 2 || randomLocation.some(isNaN)) {
            throw new Error('Invalid coordinates in location data');
        }

        const competitionData = {
            name: 'Daily Competition',
            author: 'PaulPlay',
            author_id: null,
            restriction: 'none',
            duration: getSecondsUntilNextUTC(),
            round_length: 120,
            description: "This competition presents you with a new random location every day.",
            location_amount: 1,
            locations: JSON.stringify({ locations: [randomLocation] }),
            private: true
        };

        const db = getDB();
        await db.promise().execute(
            'INSERT INTO competitions (name, author, author_id, restriction, duration, round_length, description, location_amount, locations, private) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [competitionData.name, competitionData.author, competitionData.author_id, competitionData.restriction,
            competitionData.duration, competitionData.round_length, competitionData.description,
            competitionData.location_amount, competitionData.locations, competitionData.private]
        );

        console.log('Daily competition created successfully.');
    } catch (error) {
        console.error('Error creating daily competition:', error);
        throw error;
    }
};

// Cleanup expired competitions
const cleanupCompetitions = async () => {
    try {
        const db = getDB();

        // Mark expired competitions
        await db.promise().execute(`
            UPDATE competitions
            SET expired = TRUE
            WHERE (competitions.created_at + INTERVAL competitions.duration SECOND) < NOW() 
              AND expired = FALSE
        `);

        // Delete old expired competitions and their entries
        await db.promise().execute(`
            DELETE c, e
            FROM competitions c
            LEFT JOIN competition_entries e ON c.id = e.competition_id
            WHERE (c.created_at + INTERVAL c.duration SECOND) < NOW() 
              AND c.expired = TRUE 
              AND ((c.created_at + INTERVAL c.duration SECOND + INTERVAL 7 DAY) < NOW())
        `);

        clearCompetitionListCaches();
        console.log('Competition cleanup completed.');
    } catch (error) {
        console.error('Error during cleanup:', error);
    }
};

// Clean up old competitions & mark expired ones every 15 minutes
setInterval(cleanupCompetitions, 15 * 60 * 1000);

// Helper to format competition data
const formatCompetition = (comp, includeLocations = false) => {
    const { locations, ...rest } = comp;
    return {
        ...rest,
        ...(includeLocations && { locations }),
        remainingDuration: Math.max(0, comp.duration - Math.floor((Date.now() - new Date(comp.created_at).getTime()) / 1000)),
        entered: Boolean(comp.entered)
    };
};

// Get competitions user hasn't entered
competitionsRouter.get('/not-entered/:index', standardLimiter, authenticateTokenWithId, async (req, res) => {
    try {
        const { index = 0 } = req.params;
        const userId = req.query.id;
        const offset = parseInt(index, 10) || 0;
        if (userId == null) return res.status(400).json({ status: 400, error: "User ID is required." });

        const db = getDB();

        const [results] = await db.promise().query(`
            SELECT c.*
            FROM competitions c
            LEFT JOIN competition_entries e ON c.id = e.competition_id AND e.user_id = ?
            WHERE c.expired = FALSE AND c.private = FALSE AND e.user_id IS NULL
            ORDER BY c.ranking DESC
            LIMIT 10 OFFSET ${offset}
        `, [userId]);

        res.json({ competitions: results.map(comp => ({ ...formatCompetition(comp), entered: false })) });
    } catch (error) {
        console.error('Error fetching competitions:', error);
        res.status(500).json({ status: 500, error: 'Failed to fetch competitions.' });
    }
});

// Search competitions
competitionsRouter.get('/search/:index', standardLimiter, async (req, res) => {
    try {
        const { index = 0 } = req.params;
        const userId = req.query.id || null;
        const searchQuery = req.query.search || '';
        const offset = parseInt(index, 10) || 0;
        const db = getDB();

        const sanitizedSearchQuery = `%${searchQuery.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

        const [results] = await db.promise().query(`
            SELECT c.*, IF(e.user_id IS NOT NULL, TRUE, FALSE) AS entered 
            FROM competitions c
            LEFT JOIN competition_entries e ON c.id = e.competition_id AND e.user_id = ?
            WHERE c.expired = FALSE AND c.private = FALSE
              AND (c.name LIKE ? OR c.author LIKE ?)
            ORDER BY c.ranking DESC
            LIMIT 10 OFFSET ${offset}
        `, [userId, sanitizedSearchQuery, sanitizedSearchQuery]);

        res.json({ competitions: results.map(comp => formatCompetition(comp)) });
    } catch (error) {
        console.error('Error searching competitions:', error);
        res.status(500).json({ status: 500, error: 'Failed to search competitions.' });
    }
});

// Get expired competitions
competitionsRouter.get('/expired/:index', standardLimiter, cacheResponse("competitions-expired"), async (req, res) => {
    try {
        const { index = 0 } = req.params;
        const userId = req.query.id || null;
        const offset = parseInt(index, 10) || 0;
        const db = getDB();

        const [results] = await db.promise().query(`
            SELECT c.*, IF(e.user_id IS NOT NULL, TRUE, FALSE) AS entered 
            FROM competitions c
            LEFT JOIN competition_entries e ON c.id = e.competition_id AND e.user_id = ?
            WHERE c.expired = TRUE AND c.private = FALSE
            ORDER BY c.ranking DESC
            LIMIT 10 OFFSET ${offset}
        `, [userId]);

        res.json({ competitions: results.map(comp => ({ ...formatCompetition(comp), expired: true })) });
    } catch (error) {
        console.error('Error fetching expired competitions:', error);
        res.status(500).json({ status: 500, error: 'Failed to fetch competitions.' });
    }
});

const detailsRequestsMap = new Map(); // Competition ID - user ID -> timestamp of request

// Get competition details
competitionsRouter.post('/details/:id', standardLimiter, authenticateTokenWithId, async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.body.id;
        const db = getDB();

        if (!userId || id == null) return res.status(400).json({ error: 'User ID and competition ID are required.' });

        const [results] = await db.promise().execute(
            'SELECT * FROM competitions WHERE id = ? AND expired = FALSE',
            [id]
        );
        if (results.length === 0) return res.status(404).json({ status: 404, error: 'Competition not found or expired.' });

        const competition = results[0];

        if (competition.author_id == userId) {
            return res.status(403).json({ status: 403, error: 'You cannot participate in your own competition, as you have chosen the locations.' });
        }

        const [entryResults] = await db.promise().execute(
            'SELECT COUNT(*) AS count FROM competition_entries WHERE competition_id = ? AND user_id = ?',
            [id, userId]
        );
        if (entryResults[0].count > 0) return res.status(403).json({ status: 403, error: 'You have already entered this competition.' });

        const requestsKey = id + "-" + userId; // Competition ID + user ID
        if (detailsRequestsMap.has(requestsKey)) return res.status(400).json({ error: 'You have already seen this competition, but did not finish it. Please wait at least one hour before re-playing.' });

        await db.promise().execute(
            'UPDATE competitions SET playercount = playercount + 1, ranking = ranking + 1 WHERE id = ?',
            [id]
        );

        detailsRequestsMap.set(requestsKey, Date.now()); // Track to prevent re-opening the same competition (used by some cheaters)

        const remainingDuration = Math.max(0, competition.duration - Math.floor((Date.now() - new Date(competition.created_at).getTime()) / 1000));
        res.json({ ...competition, remainingDuration, expired: false });
    } catch (error) {
        console.error('Error fetching competition details:', error);
        res.status(500).json({ status: 500, error: 'Failed to fetch competition details.' });
    }
});

// Clean up old detail requests every minute
setInterval(() => {
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    detailsRequestsMap.forEach((value, key) => {
        if (value < oneHourAgo) detailsRequestsMap.delete(key);
    });
}, 60 * 1000);

// Create competition
competitionsRouter.post('/create', createCompetitionLimiter, authenticateTokenWithId, [
    body('name').isString().withMessage('Name must be a string.').bail().trim().isLength({ min: 3, max: 30 }).withMessage('Name must be between 3 and 30 characters.').custom((value) => {
        if (!check(value)) throw new Error('Competition name is empty or contains inappropriate words.');
        return true;
    }),
    body('restriction').isLength({ max: 1000 }).withMessage('Restriction data cannot exceed 1000 characters.'),
    body('duration').isInt({ min: 600, max: 604800 }).withMessage('Duration must be between 10 minutes and 7 days.'),
    body('roundLength').isInt({ min: 3, max: 300 }).withMessage('Round length must be between 3 seconds and 5 minutes.'),
    body('description').isString().withMessage('Description must be a string.').bail().isLength({ min: 15, max: 70 }).withMessage('Description must be between 15 and 70 characters.').custom((value) => {
        if (!check(value)) throw new Error('Description is empty or contains inappropriate words.');
        return true;
    }),
    body('locations').isLength({ max: 10000 }).withMessage('Location data cannot exceed 10,000 characters.'),
    body('private').isBoolean().withMessage('Private must be a boolean.'),
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) {
            return res.status(400).json({ status: 400, errors: errors.array() });
        }

        const { name, id, restriction, duration, roundLength, description, locations: rawLocations, private: isPrivate } = req.body;

        const db = getDB();

        // Fetch the user to get the actual username
        const [userResults] = await db.promise().execute('SELECT user_name FROM users WHERE id = ?', [id]);
        if (userResults.length === 0) return res.status(404).json({ status: 404, error: 'User not found.' });

        const author = userResults[0].user_name;

        const locations = JSON.parse(rawLocations).locations;

        const mapError = isValidMap({ locations }, { minLocations: 1, maxLocations: 20 });
        if (mapError) return res.status(400).json({ status: 400, error: mapError });

        const locationAmount = locations.length;

        const [result] = await db.promise().execute(
            'INSERT INTO competitions (name, author, author_id, restriction, duration, round_length, description, location_amount, locations, private) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
            [name, author, id, restriction, duration, roundLength, description, locationAmount, JSON.stringify({ locations }), isPrivate]
        );

        clearCompetitionListCaches();
        res.status(201).json({
            status: 201,
            message: 'Competition created successfully.',
            competitionId: result.insertId
        });
    } catch (error) {
        console.error('Error creating competition:', error);
        if (error instanceof SyntaxError) {
            return res.status(400).json({ status: 400, error: 'Invalid JSON format for map data.' });
        }
        res.status(500).json({ status: 500, error: 'Failed to create competition.' });
    }
});

// Submit competition results
competitionsRouter.post('/submit/:id', standardLimiter, authenticateTokenWithId, async (req, res) => {
    try {
        const compId = req.params.id;
        const { id, score } = req.body;
        const db = getDB();

        if (id == null || score == null || compId == null) return res.status(400).json({ status: 400, error: 'User id, competition Id and score are required' });

        const banStatus = await fetchReportData("blacklist", "user", "user-" + id);
        if (banStatus?.listed) return res.status(403).json({ error: "You have been banned." });

        const [userResults] = await db.promise().execute(
            'SELECT user_name, supporter_level FROM users WHERE id = ?',
            [id]
        );

        if (!userResults[0]) {
            return res.status(404).json({ status: 404, error: 'User not found' });
        }

        const { user_name, supporter_level } = userResults[0];

        // Check if user has already submitted for this competition
        const [entryCheck] = await db.promise().execute(
            'SELECT COUNT(*) AS count FROM competition_entries WHERE competition_id = ? AND user_id = ?',
            [compId, id]
        );

        if (entryCheck[0].count > 0) return res.status(403).json({ status: 403, error: 'You have already submitted results for this competition.' });

        // Insert the competition entry with data from database
        await db.promise().execute(
            'INSERT INTO competition_entries (competition_id, user_id, username, score, supporter_level) VALUES (?, ?, ?, ?, ?)',
            [compId, id, user_name, score, supporter_level]
        );

        updateProfileData(id, "competitions_entered", true, 1);
        clearResponseCache("competitions-leaderboard");
        res.status(201).json({ status: 201, message: 'Results submitted successfully.' });
    } catch (error) {
        console.error('Error submitting results:', error);
        res.status(500).json({ status: 500, error: 'Failed to submit results.' });
    }
});

// Get competition leaderboard
competitionsRouter.get('/leaderboard/:id', standardLimiter, cacheResponse("competitions-leaderboard"), async (req, res) => {
    try {
        const { id } = req.params;
        const userId = req.query.id || null;
        const db = getDB();

        const [competitionResults] = await db.promise().execute(
            'SELECT name FROM competitions WHERE id = ?',
            [id]
        );

        if (competitionResults.length === 0) {
            return res.status(404).json({ status: 404, error: 'Competition not found' });
        }

        const [leaderboardResults] = await db.promise().execute(`
            SELECT user_id AS id, supporter_level, username AS userName, score,
              RANK() OVER (ORDER BY score DESC) AS position
            FROM competition_entries
            WHERE competition_id = ?
            ORDER BY score DESC
            LIMIT 100
        `, [id]);

        const response = {
            leaderboard: leaderboardResults,
            name: competitionResults[0].name
        };

        if (userId) {
            const [userRankResults] = await db.promise().execute(`
                SELECT id, userName, score, position, supporter_level FROM (
                  SELECT user_id AS id, username AS userName, score, supporter_level,
                    RANK() OVER (ORDER BY score DESC) AS position
                  FROM competition_entries
                  WHERE competition_id = ?
                ) AS subquery
                WHERE id = ?
            `, [id, userId]);

            response.userRank = userRankResults[0] || null;
        }

        res.json(response);
    } catch (error) {
        console.error('Error fetching leaderboard:', error);
        res.status(500).json({ status: 500, error: 'Failed to fetch leaderboard' });
    }
});

// Get daily competition
competitionsRouter.get('/daily/daily-competition', standardLimiter, cacheResponse("daily-competition"), async (req, res) => {
    try {
        const userId = req.query.id || null;
        const db = getDB();

        const query = `
      SELECT c.*, IF(e.user_id IS NOT NULL, TRUE, FALSE) AS entered
      FROM competitions c
      LEFT JOIN competition_entries e ON c.id = e.competition_id AND e.user_id = ?
      WHERE c.name = 'Daily Competition' AND c.author_id IS NULL
      ORDER BY c.expired ASC, c.id DESC
      LIMIT 2
    `;

        let [results] = await db.promise().execute(query, [userId]);

        // If no current competition exists, create one
        if (!results.some(r => !r.expired)) {
            console.log('No daily competition found, creating new one...');
            await createDailyCompetition();
            clearResponseCache("daily-competition");
            [results] = await db.promise().execute(query, [userId]);

            if (!results.some(r => !r.expired)) {
                console.error('Failed to create or fetch daily competition');
                return res.status(500).json({ status: 500, error: 'Failed to create daily competition.' });
            }
            console.log('Daily competition created and fetched successfully.');
        }

        res.json({ competitions: results.map(formatCompetition) });

    } catch (error) {
        console.error('Error with daily competition:', error);
        res.status(500).json({ status: 500, error: 'Failed to fetch daily competition.' });
    }
});

// Get active competitions (must be after other GET routes to avoid /:index catching everything)
competitionsRouter.get('/:index', standardLimiter, cacheResponse("competitions-active"), async (req, res) => {
    try {
        const { index = 0 } = req.params;
        const userId = req.query.id || null;
        const offset = parseInt(index, 10) || 0;
        const db = getDB();

        // Use query() instead of execute() for LIMIT/OFFSET
        const [results] = await db.promise().query(`
            SELECT c.*, IF(e.user_id IS NOT NULL, TRUE, FALSE) AS entered
            FROM competitions c
            LEFT JOIN competition_entries e ON c.id = e.competition_id AND e.user_id = ?
            WHERE c.expired = FALSE AND c.private = FALSE
            ORDER BY c.ranking DESC
            LIMIT 10 OFFSET ${offset}
        `, [userId]);

        res.json({ competitions: results.map(comp => formatCompetition(comp)) });
    } catch (error) {
        console.error('Error fetching competitions:', error);
        res.status(500).json({ status: 500, error: 'Failed to fetch competitions.' });
    }
});

// Update competition ranking
competitionsRouter.post('/ranking', rankingLimiter, authenticateTokenWithId, async (req, res) => {
    try {
        const { compId, updateFactor } = req.body;
        const factor = Number(updateFactor);

        if (!Number.isInteger(factor) || factor < -10 || factor > 5) return res.status(400).json({ status: 400, error: 'Invalid updateFactor.' });
        if (!Number.isInteger(compId)) return res.status(400).json({ status: 400, error: 'Invalid competition id.' });

        const db = getDB();
        await db.promise().execute(
            'UPDATE competitions SET ranking = ranking + ? WHERE id = ?',
            [factor, compId]
        );

        res.status(200).json({ status: 200, message: "Ranking submitted successfully." });
    } catch (error) {
        console.error("Error during ranking update:", error);
        res.status(500).json({ status: 500, error: 'An unexpected error occurred.' });
    }
});

export default competitionsRouter;