const fs = require('fs');
const express = require('express');
const competitionsRouter = express.Router();
const { standardLimiter, rankingLimiter, createCompetitionLimiter } = require("./rateLimiters.js");
const { authenticateTokenWithId } = require("./authUtils.js");
const { getDB } = require("./dbConnection.js");
const { body, validationResult } = require('express-validator');

// Map Validation function ----------------------------------------------------------------------------------

const isValidMap = (map) => {
    try {
        if (!map.locations || !Array.isArray(map.locations)) {
            console.log("Submitted map was empty or not an array.");
            return false;
        }
        if (map.locations.length < 1) {
            console.log("Submitted locations were too few.");
            return false;
        }
        if (map.locations.length > 20) {
            console.log("Submitted locations were too many.");
            return false;
        }
        for (let location of map.locations) {
            if (!Array.isArray(location) || location.length !== 2) {
                console.log("Map did not include coordinates at some spots.");
                return false;
            }
            if (typeof location[0] !== 'number' || typeof location[1] !== 'number') {
                console.log("Map coordinates weren't numbers.");
                return false;
            }
        }
        return true;
    } catch (error) {
        console.error("Error occurred during map validation: " + error);
        return false;
    }
};

// Create Daily Competition Function ------------------------------------------------------------------------------------------------------------
// Function to calculate seconds until next 00:00 UTC
const getSecondsUntilNextUTC = () => {
    const now = new Date();
    const nextUTC = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 0, 0, 0));
    return Math.floor((nextUTC - now) / 1000);
};

// Function to create a daily competition
const createDailyCompetition = (callback) => {
    let dailyLocations = null;
    let randomLocation = null;

    try {
        // Read and parse the locations file
        const data = fs.readFileSync('./JSON/dailyLocations.json', 'utf8');
        dailyLocations = JSON.parse(data);

        // Validate the locations array
        if (!dailyLocations.locations || !Array.isArray(dailyLocations.locations) || dailyLocations.locations.length === 0) {
            throw new Error('Invalid or empty locations array in dailyLocations.json');
        }

        // Select a random location
        randomLocation = dailyLocations.locations[Math.floor(Math.random() * dailyLocations.locations.length)];

        // Validate the selected location
        if (!Array.isArray(randomLocation) || randomLocation.length !== 2) {
            throw new Error('Invalid location format in dailyLocations.json');
        }

        // Convert coordinates to floats
        randomLocation = randomLocation.map(coord => parseFloat(coord));

        // Ensure coordinates are valid numbers
        if (randomLocation.length !== 2 || randomLocation.some(isNaN)) {
            throw new Error('Coordinates must be valid numbers');
        }

    } catch (error) {
        console.error("Error getting random daily location using JSON parse: ", error);
        if (callback) callback(error);
        return;
    }

    // Calculate the duration until the next UTC midnight
    const duration = getSecondsUntilNextUTC();

    const competitionData = {
        name: 'Daily Competition',
        author: 'PaulPlay',
        author_id: 0,
        restriction: 'standard',
        duration: duration,
        round_length: 120,
        description: "Formerly known as the Daily Challenge, this competition presents you with a new random location every day.",
        location_amount: 1,
        locations: JSON.stringify({ locations: [randomLocation] }),
        private: true
    };

    const db = getDB();

    // Insert the competition into the database
    db.execute(
        'INSERT INTO competitions (name, author, author_id, playercount, restriction, duration, round_length, description, location_amount, locations, expired, private) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [
            competitionData.name,
            competitionData.author,
            competitionData.author_id,
            0,
            competitionData.restriction,
            competitionData.duration,
            competitionData.round_length,
            competitionData.description,
            competitionData.location_amount,
            competitionData.locations,
            0,
            competitionData.private
        ],
        (err) => {
            if (err) {
                console.error('Error creating daily competition:', err);
                if (callback) callback(err);
            } else {
                console.log('Daily competition created successfully.');
                if (callback) callback(null);
            }
        }
    );
};

// Delete expired competitions and their entries 7 days after the expiration + handle setting expired competitions to expired
const cleanupCompetitions = () => {
    // Mark competitions whose durations have passed as expired
    const db = getDB();

    const markExpiredQuery = `
    UPDATE competitions
    SET expired = TRUE
    WHERE (competitions.created_at + INTERVAL competitions.duration SECOND) < NOW() 
      AND expired = FALSE`;

    db.execute(markExpiredQuery, (err) => {
        if (err) {
            console.error('Error marking competitions as expired:', err);
        } else {
            console.log('Competitions marked as expired where duration has passed.');
        }
    });

    // Delete competitions that have been expired for more than seven days
    const deleteExpiredCompetitionsQuery = `
    DELETE c, e
    FROM competitions c
    LEFT JOIN competition_entries e ON c.id = e.competition_id
    WHERE (c.created_at + INTERVAL c.duration SECOND) < NOW() 
      AND c.expired = TRUE 
      AND ((c.created_at + INTERVAL c.duration SECOND + INTERVAL 7 DAY) < NOW())`;

    db.execute(deleteExpiredCompetitionsQuery, (err) => {
        if (err) {
            console.error('Error deleting expired competitions:', err);
        } else {
            console.log('Potentially expired competitions deleted after 7 days.');
        }
    });
};

// Schedule the cleanup every 15 minutes
setInterval(cleanupCompetitions, 15 * 60 * 1000);

// Get list of active competitions
competitionsRouter.put('/:index', standardLimiter, (req, res) => {
    const { index = 0 } = req.params;
    const userId = req.body.id || null;
    const limit = 10;
    const offset = parseInt(index, 10);
    const db = getDB();

    let query = `
      SELECT c.*, IF(e.user_id IS NOT NULL, TRUE, FALSE) AS entered 
      FROM competitions c
      LEFT JOIN competition_entries e ON c.id = e.competition_id AND e.user_id = ?
      WHERE c.expired = FALSE AND c.private = FALSE
      ORDER BY c.ranking DESC
      LIMIT ${limit} OFFSET ${offset}`;

    db.execute(query, [userId], (err, results) => {
        if (err) {
            console.error('Error fetching competitions:', err);
            return res.status(500).json({ status: 500, error: 'Failed to fetch competitions.' });
        }

        const competitions = results.map(comp => {
            const { locations, ...rest } = comp;
            return {
                ...rest,
                remainingDuration: Math.max(0, comp.duration - Math.floor((Date.now() - new Date(comp.created_at).getTime()) / 1000)),
                expired: false,
                entered: !!comp.entered
            };
        });

        res.json({ competitions });
    });
});

// Get list of active competitions that the user hasn't already entered
competitionsRouter.put('/notentered/:index', standardLimiter, (req, res) => {
    const { index = 0 } = req.params;
    const userId = req.body.id || null;
    const limit = 10;
    const offset = parseInt(index, 10);
    const db = getDB();

    let query = `
      SELECT c.*
      FROM competitions c
      LEFT JOIN competition_entries e ON c.id = e.competition_id AND e.user_id = ?
      WHERE c.expired = FALSE AND c.private = FALSE AND e.user_id IS NULL
      ORDER BY c.ranking DESC
      LIMIT ${limit} OFFSET ${offset}`;

    db.execute(query, [userId], (err, results) => {
        if (err) {
            console.error('Error fetching competitions:', err);
            return res.status(500).json({ status: 500, error: 'Failed to fetch competitions.' });
        }

        const competitions = results.map(comp => {
            const { locations, ...rest } = comp;
            return {
                ...rest,
                remainingDuration: Math.max(0, comp.duration - Math.floor((Date.now() - new Date(comp.created_at).getTime()) / 1000)),
                expired: false,
                entered: false  // Since we're only returning not entered competitions, this will always be false
            };
        });

        res.json({ competitions });
    });
});

// Search for active competitions
competitionsRouter.put('/search/:index', standardLimiter, (req, res) => {
    const { index = 0 } = req.params;
    const userId = req.body.id || null;
    const searchQuery = req.body.search || '';
    const limit = 10;
    const offset = parseInt(index, 10);
    const db = getDB();

    // Sanitize the search query to prevent SQL injection
    const sanitizedSearchQuery = `%${searchQuery.replace(/%/g, '\\%').replace(/_/g, '\\_')}%`;

    let query = `
      SELECT c.*, IF(e.user_id IS NOT NULL, TRUE, FALSE) AS entered 
      FROM competitions c
      LEFT JOIN competition_entries e ON c.id = e.competition_id AND e.user_id = ?
      WHERE c.expired = FALSE AND c.private = FALSE
        AND (c.name LIKE ? OR c.author LIKE ?)
      ORDER BY c.ranking DESC
      LIMIT ${limit} OFFSET ${offset}`;

    db.execute(query, [userId, sanitizedSearchQuery, sanitizedSearchQuery], (err, results) => {
        if (err) {
            console.error('Error fetching competitions:', err);
            return res.status(500).json({ status: 500, error: 'Failed to fetch competitions.' });
        }

        const competitions = results.map(comp => {
            const { locations, ...rest } = comp;
            return {
                ...rest,
                remainingDuration: Math.max(0, comp.duration - Math.floor((Date.now() - new Date(comp.created_at).getTime()) / 1000)),
                expired: false,
                entered: !!comp.entered
            };
        });

        res.json({ competitions });
    });
});

// Get list of expired competitions
competitionsRouter.put('/expired/:index', standardLimiter, (req, res) => {
    const { index = 0 } = req.params;
    const userId = req.body.id || null;
    const limit = 10;
    const offset = parseInt(index, 10);
    const db = getDB();

    let query = `
      SELECT c.*, IF(e.user_id IS NOT NULL, TRUE, FALSE) AS entered 
      FROM competitions c
      LEFT JOIN competition_entries e ON c.id = e.competition_id AND e.user_id = ?
      WHERE c.expired = TRUE AND c.private = FALSE
      ORDER BY c.ranking DESC
      LIMIT ${limit} OFFSET ${offset}`;

    db.execute(query, [userId], (err, results) => {
        if (err) {
            console.error('Error fetching competitions:', err);
            return res.status(500).json({ status: 500, error: 'Failed to fetch competitions.' });
        }

        const competitions = results.map(comp => {
            const { locations, ...rest } = comp;
            return {
                ...rest,
                remainingDuration: Math.max(0, comp.duration - Math.floor((Date.now() - new Date(comp.created_at).getTime()) / 1000)),
                expired: true,
                entered: !!comp.entered
            };
        });

        res.json({ competitions });
    });
});

// Get competition details by id
competitionsRouter.post('/details/:id', standardLimiter, authenticateTokenWithId, (req, res) => {
    const { id } = req.params; // parameter from the url, the id of the competition
    const userId = req.body.id;
    const db = getDB();

    db.execute(
        'SELECT * FROM competitions WHERE id = ? AND expired = FALSE',
        [id],
        (err, results) => {
            if (err) {
                console.error('Error fetching competition:', err);
                return res.status(500).json({ status: 500, error: 'Failed to fetch competition details.' });
            }

            if (results.length == 0) {
                return res.status(404).json({ status: 404, error: 'Competition not found or expired.' });
            }

            const competition = results[0];

            // check if the user trying to play the comp is the author (which would be not allowed)
            if (competition.author_id == userId) {
                return res.status(403).json({ status: 403, error: 'You cannot participate in your own competition, as you have chosen the locations.' });
            }

            db.execute(
                'SELECT COUNT(*) AS count FROM competition_entries WHERE competition_id = ? AND user_id = ?',
                [id, userId],
                (err, entryResults) => {
                    if (err) {
                        console.error('Error checking entry:', err);
                        return res.status(500).json({ status: 500, error: 'Failed to check entry.' });
                    }

                    // check if user has already entered competition
                    if (entryResults[0].count > 0) {
                        return res.status(403).json({ status: 403, error: 'You have already entered this competition.' });
                    }

                    db.execute(
                        'UPDATE competitions SET playercount = playercount + 1, ranking = ranking + 1 WHERE id = ?',
                        [id],
                        (err) => {
                            if (err) {
                                console.error('Error updating player count:', err);
                                return res.status(500).json({ status: 500, error: 'Failed to update player count.' });
                            }

                            const remainingDuration = Math.max(0, competition.duration - Math.floor((Date.now() - new Date(competition.created_at).getTime()) / 1000));
                            res.json({ ...competition, remainingDuration, expired: false });
                        }
                    );
                }
            );
        }
    );
});

// Create a new competition
competitionsRouter.post('/create', createCompetitionLimiter, authenticateTokenWithId, [
    body('name').isLength({ min: 3, max: 30 }).withMessage('Name must be between 3 and 30 characters.'),
    body('author').isLength({ max: 255 }).withMessage('Author name must be up to 255 characters.'),
    body('restriction').isLength({ max: 1000 }).withMessage('Restriction data cannot exceed 1000 characters.'),
    body('duration').isInt({ min: 600, max: 604800 }).withMessage('Duration must be between 10 minutes and 7 days.'),
    body('roundLength').isInt({ min: 3, max: 300 }).withMessage('Round length must be between 3 seconds and 5 minutes.'),
    body('description').isLength({ min: 15, max: 70 }).withMessage('Description must be between 15 and 70 characters.'),
    body('locations').isLength({ max: 10000 }).withMessage('Location data cannot exceed 10,000 characters.'),
    body('private').isBoolean().withMessage('Private must be a boolean.'),
], (req, res) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ status: 400, errors: errors.array() });
    }

    const { name, author, id, restriction, duration, roundLength, description, rawLocations, private } = req.body;

    let parsedMapData;
    let locations;
    let locationAmount = 0;

    try {
        parsedMapData = JSON.parse(rawLocations);

        // Convert locations to ensure lat/lng are numbers and maintain structure
        locations = parsedMapData.locations.map(coord => [
            parseFloat(coord[0]),
            parseFloat(coord[1])
        ]);

        // Count the number of locations
        locationAmount = locations.length;

        if (!isValidMap({ locations })) {
            return res.status(400).json({ status: 400, error: 'Invalid map data. Must contain valid coordinates.' });
        }

        // Validate location amount
        if (locationAmount < 1 || locationAmount > 20) {
            return res.status(400).json({ status: 400, error: `Location count must be between 1 and 20. Currently it is ${locationAmount}.` });
        }

    } catch (error) {
        console.error('Error parsing JSON:', error);
        return res.status(400).json({ status: 400, error: 'Invalid JSON format for map data. Failed to parse.' });
    }

    const db = getDB();

    db.execute(
        'INSERT INTO competitions (name, author, author_id, restriction, duration, round_length, description, location_amount, locations, private) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        [name, author, id, restriction, duration, roundLength, description, locationAmount, JSON.stringify({ locations }), private],
        function (err, result) {
            if (err) {
                console.error('Error creating competition:', err);
                return res.status(500).json({ status: 500, error: 'Failed to create competition.' });
            }

            const newCompetitionId = result.insertId; // Get the ID of the newly created competition

            res.status(201).json({
                status: 201,
                message: 'Competition created successfully.',
                competitionId: newCompetitionId // Return the ID of the newly created competition
            });
        }
    );
});

// Submit competition results
competitionsRouter.post('/submit/:id', standardLimiter, authenticateTokenWithId, (req, res) => {
    const compId = req.params.id;
    const { username, id, score } = req.body;
    let supporter_level = req.body.supporter_level;
    const db = getDB();

    if (supporter_level == null) supporter_level = 0;

    // the == null operator also catches undefined, whereas === null doesn't apply to undefined
    if (username == null || id == null || score == null || compId == null) {
        return res.status(400).json({ status: 400, error: 'Username, user id, competition Id and score are required' });
    }

    db.execute(
        'SELECT COUNT(*) AS count FROM competition_entries WHERE competition_id = ? AND user_id = ?',
        [compId, id],
        (err, results) => {
            if (err) {
                console.error('Error checking entry:', err);
                return res.status(500).json({ status: 500, error: 'Failed to check entry for ensuring that it it isn not a duplicate submission.' });
            }

            if (results[0].count > 0) {
                return res.status(403).json({ status: 403, error: 'You have already submitted results for this competition.' });
            }

            db.execute(
                'INSERT INTO competition_entries (competition_id, user_id, username, score, supporter_level) VALUES (?, ?, ?, ?, ?)',
                [compId, id, username, score, supporter_level],
                (err) => {
                    if (err) {
                        console.error('Error submitting results:', err);
                        return res.status(500).json({ status: 500, error: 'Failed to submit results.' });
                    }
                    res.status(201).json({ status: 201, message: 'Results submitted successfully.' });
                }
            );
        }
    );
});

// Get leaderboard for a specific competition
competitionsRouter.post('/leaderboard/:id', standardLimiter, (req, res) => {
    const { id } = req.params || 0;
    const userId = req.body.id || null;
    const db = getDB();

    const getCompetitionNameQuery = `
    SELECT name 
    FROM competitions 
    WHERE id = ?`;

    const getLeaderboardQuery = `
    SELECT user_id AS id, supporter_level, username AS userName, score,
      RANK() OVER (ORDER BY score DESC) AS position
    FROM competition_entries
    WHERE competition_id = ?
    ORDER BY score DESC
    LIMIT 100`;

    const getUserRankQuery = `
    SELECT id, userName, score, position, supporter_level FROM (
      SELECT user_id AS id, username AS userName, score, supporter_level,
        RANK() OVER (ORDER BY score DESC) AS position
      FROM competition_entries
      WHERE competition_id = ?
    ) AS subquery
    WHERE id = ?`;

    db.execute(getCompetitionNameQuery, [id], (err, competitionResults) => {
        if (err) {
            console.error('Error fetching competition name:', err);
            return res.status(500).json({ status: 500, error: 'Failed to fetch competition name' });
        }

        if (competitionResults.length === 0) {
            return res.status(404).json({ status: 404, error: 'Competition not found' });
        }

        const competitionName = competitionResults[0].name;

        db.execute(getLeaderboardQuery, [id], (err, leaderboardResults) => {
            if (err) {
                console.error('Error fetching leaderboard:', err);
                return res.status(500).json({ status: 500, error: 'Failed to fetch leaderboard' });
            }

            if (userId) {
                db.execute(getUserRankQuery, [id, userId], (err, userRankResults) => {
                    if (err) {
                        console.error('Error fetching user rank:', err);
                        return res.status(500).json({ status: 500, error: 'Failed to fetch user rank' });
                    }

                    res.json({
                        leaderboard: leaderboardResults,
                        userRank: userRankResults[0] || null,
                        name: competitionName
                    });
                });
            } else {
                res.json({ leaderboard: leaderboardResults, name: competitionName });
            }
        });
    });
});

// Fetch daily competition
competitionsRouter.put('/daily/daily-competition', standardLimiter, (req, res) => {
    const userId = req.body.id || null;
    const db = getDB();
    const query = `
    SELECT c.*, IF(e.user_id IS NOT NULL, TRUE, FALSE) AS entered 
    FROM competitions c
    LEFT JOIN competition_entries e ON c.id = e.competition_id AND e.user_id = ?
    WHERE c.name = 'Daily Competition' 
    AND c.expired = FALSE 
    AND c.author_id = 0
    LIMIT 1`;

    db.execute(query, [userId], (err, results) => {
        if (err) {
            console.error('Error fetching daily competition:', err);
            return res.status(500).json({ status: 500, error: 'Failed to fetch daily competition.' });
        }

        if (results.length === 0) {
            createDailyCompetition((createErr) => {
                if (createErr) {
                    return res.status(500).json({ status: 500, error: 'Failed to create daily competition.' });
                }

                db.execute(query, [userId], (err, newResults) => {
                    if (err) {
                        console.error('Error fetching newly created daily competition:', err);
                        return res.status(500).json({ status: 500, error: 'Failed to fetch newly created daily competition.' });
                    }

                    if (newResults.length === 0) {
                        return res.status(404).json({ status: 404, error: 'No daily competition found.' });
                    }

                    const comp = newResults[0];
                    const { locations, ...rest } = comp;

                    const competitions = [{
                        ...rest,
                        remainingDuration: Math.max(0, comp.duration - Math.floor((Date.now() - new Date(comp.created_at).getTime()) / 1000)),
                        expired: false,
                        entered: !!comp.entered
                    }];

                    res.json({ competitions });
                });
            });
        } else {
            const comp = results[0];
            const { locations, ...rest } = comp;

            const competitions = [{
                ...rest,
                remainingDuration: Math.max(0, comp.duration - Math.floor((Date.now() - new Date(comp.created_at).getTime()) / 1000)),
                expired: false,
                entered: !!comp.entered
            }];

            res.json({ competitions });
        }
    });
});

// Update ranking of competition
competitionsRouter.post('/ranking', rankingLimiter, authenticateTokenWithId, async (req, res) => {
    const { id, compId, updateFactor } = req.body;
    const db = getDB();

    try {
        // Convert updateFactor to a number and check it's valid
        const factor = Number(updateFactor);
        if (!Number.isInteger(factor) || factor < -10 || factor > 5) {
            return res.status(400).json({ status: 400, error: 'Invalid updateFactor.' });
        }

        if (!Number.isInteger(compId)) {
            return res.status(400).json({ status: 400, error: 'Invalid competition id.' });
        }

        // Update ranking with updateFactor for the given ID
        const [result] = await db.promise().execute(
            `UPDATE competitions 
         SET ranking = ranking + ? 
         WHERE id = ?`,
            [factor, compId]
        );

        return res.status(200).json({ status: 200, message: "Ranking submitted successfully." });
    } catch (error) {
        console.error("Error occured during ranking update:", error);
        return res.status(500).json({ status: 500, error: 'An unexpected error occured.' });
    }
});

module.exports = competitionsRouter;