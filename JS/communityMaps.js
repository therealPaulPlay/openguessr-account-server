const express = require('express');
const communityMapRouter = express.Router();
const { standardLimiter, failedSubmissionLimiter, successfulSubmissionLimiter } = require("./rateLimiters.js");
const { authenticateTokenWithId } = require("./authUtils.js");
const { getDB } = require("./dbConnection.js");
const { body, validationResult } = require('express-validator');

// 1) Return a list of ALL maps (without map_data)
communityMapRouter.get('/', standardLimiter, (req, res) => {
    const db = getDB();

    db.execute('SELECT name, author, description, favourite, category, author_id, likes FROM maps ORDER BY likes DESC', (err, results) => {
        if (err) {
            console.error('Error fetching maps:', err);
            return res.status(500).json({ error: 'Failed to fetch maps.' });
        }

        const communityMaps = results.map(map => ({
            name: map.name,
            author: map.author,
            authorId: map.author_id,
            description: map.description,
            favourite: !!map.favourite, // convert to boolean
            category: map.category, // include category
            likes: map.likes
        }));

        res.json({ communityMaps });
    });
});

// 1.1) Return the next 50 maps starting from a given index
communityMapRouter.get('/index/:index', standardLimiter, (req, res) => {
    const db = getDB();

    const startIndex = parseInt(req.params.index, 10);

    if (isNaN(startIndex) || startIndex < 0) {
        return res.status(400).json({ error: 'Invalid start index' });
    }

    const limit = 50;

    // the questionmarks in the sql are then being filled in by the array's content!
    db.execute('SELECT name, author, description, favourite, category, author_id, likes FROM maps ORDER BY likes DESC LIMIT ?, ?', [startIndex, limit], (err, results) => {
        if (err) {
            console.error('Error fetching maps:', err);
            return res.status(500).json({ error: 'Failed to fetch maps.' });
        }

        const communityMaps = results.map(map => ({
            name: map.name,
            author: map.author,
            authorId: map.author_id,
            description: map.description,
            favourite: !!map.favourite,
            category: map.category,
            likes: map.likes
        }));

        res.json({ communityMaps });
    });
});

// 1.2) Filter maps by category with pagination
communityMapRouter.get('/category/:category/:index', standardLimiter, (req, res) => {
    const db = getDB();

    const category = req.params.category;
    const startIndex = parseInt(req.params.index, 10);

    if (isNaN(startIndex) || startIndex < 0) {
        return res.status(400).json({ error: 'Invalid start index' });
    }

    const limit = 50;

    db.execute('SELECT name, author, description, favourite, category, author_id, likes FROM maps WHERE category = ? ORDER BY likes DESC LIMIT ? OFFSET ?', [category, limit, startIndex], (err, results) => {
        if (err) {
            console.error('Error fetching maps by category:', err);
            return res.status(500).json({ error: 'Failed to fetch maps.' });
        }

        const communityMaps = results.map(map => ({
            name: map.name,
            author: map.author,
            authorId: map.author_id,
            description: map.description,
            favourite: !!map.favourite,
            category: map.category,
            likes: map.likes
        }));

        res.json({ communityMaps });
    });
});

// 1.3) Search maps by query with pagination
communityMapRouter.get('/search/:query/:index', standardLimiter, (req, res) => {
    const db = getDB();

    const query = `%${req.params.query}%`;
    const startIndex = parseInt(req.params.index, 10);

    if (isNaN(startIndex) || startIndex < 0) {
        return res.status(400).json({ error: 'Invalid start index' });
    }

    const limit = 50;

    db.execute('SELECT name, author, description, favourite, category, author_id, likes FROM maps WHERE name LIKE ? OR author LIKE ? ORDER BY likes DESC LIMIT ? OFFSET ?', [query, query, limit, startIndex], (err, results) => {
        if (err) {
            console.error('Error searching maps:', err);
            return res.status(500).json({ error: 'Failed to search maps.' });
        }

        const communityMaps = results.map(map => ({
            name: map.name,
            author: map.author,
            authorId: map.author_id,
            description: map.description,
            favourite: !!map.favourite,
            category: map.category,
            likes: map.likes
        }));

        res.json({ communityMaps });
    });
});

// 1.4) Return all favourite maps
communityMapRouter.get('/favourites', standardLimiter, (req, res) => {
    const db = getDB();

    db.execute('SELECT name, author, description, favourite, category, author_id, likes FROM maps WHERE favourite = TRUE ORDER BY likes DESC', (err, results) => {
        if (err) {
            console.error('Error fetching favourite maps:', err);
            return res.status(500).json({ error: 'Failed to fetch favourite maps.' });
        }

        const communityMaps = results.map(map => ({
            name: map.name,
            author: map.author,
            authorId: map.author_id,
            description: map.description,
            favourite: !!map.favourite, // convert to boolean
            category: map.category, // include category
            likes: map.likes
        }));

        res.json({ communityMaps });
    });
});

// 2) Get the actual map data by the name of the map
communityMapRouter.get('/:name', standardLimiter, (req, res) => {
    const db = getDB();

    const name = req.params.name.toLowerCase().replaceAll("_", " ");
    db.execute('SELECT * FROM maps WHERE LOWER(name) = ?', [name], (err, results) => {
        if (err) {
            console.error('Error fetching map:', err);
            return res.status(500).json({ error: 'Failed to fetch map.' });
        }
        if (results.length === 0) {
            return res.status(404).json({ error: 'Map not found.' });
        }

        const { name, author, author_id: authorId, description, map_data, favourite, category } = results[0];

        const map = {
            name,
            author,
            authorId,
            description,
            favourite: !!favourite, // convert to boolean if necessary
            map_data, // map data
            category
        };

        res.json(map);
    });
});


// Helper function to validate map structure
const isValidMap = (map) => {
    try {
        if (!map.locations || !Array.isArray(map.locations)) {
            console.log("Submitted map was empty or not an array.");
            return false;
        }
        if (map.locations.length < 50) {
            console.log("Submitted locations were too few.");
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

// 3) Endpoint to submit a new map
communityMapRouter.post('', [
    failedSubmissionLimiter, authenticateTokenWithId,
    body('name').isLength({ min: 3, max: 17 }).withMessage('Map name must be between 3 and 17 characters.'),
    body('author').isLength({ max: 255 }).withMessage('Author name cannot exceed 255 characters.'),
    body('description').isLength({ min: 50, max: 300 }).withMessage('Description must be between 50 and 300 characters.'),
    body('mapData').isLength({ max: 600000 }).withMessage('Map data cannot exceed 600,000 characters (slightly above 10 000 locations).'),
], async (req, res) => {
    const { id: player_id, name: rawName, author, description: rawDescription, mapData, category } = req.body; // include category
    const ip = req.clientIp;

    const db = getDB();

    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    if (!player_id || !rawName || !author || !rawDescription || !mapData) {
        return res.status(400).json({ error: 'All input fields are required.' });
    }

    let name = rawName.trim().split("_").join(" ");
    name = name.split("/").join(" ");
    name = name.split("+").join(" ");
    name = name.split("&").join(" ");
    name = name.split("#").join(" ");

    // Ensure the description ends with a '.', '?', or '!' 
    let description = rawDescription.trim();
    description = /[.?!]$/.test(description) ? description : `${description}.`;

    let parsedMapData;
    let locations; // here locations are converted to numbers in case they are strings

    try {
        parsedMapData = JSON.parse(mapData);
        locations = parsedMapData.locations.map(coord => [
            parseFloat(coord[0]),
            parseFloat(coord[1])
        ]);

        if (!isValidMap({ locations })) {
            return res.status(400).json({ error: 'Invalid map data. Must contain at least 50 locations with valid coordinates.' });
        }
    } catch (error) {
        console.error('Error parsing JSON:', error);
        return res.status(400).json({ error: 'Invalid JSON format for map data. Failed to parse.' });
    }

    try {
        // Check for duplicate map names
        const [duplicateMap] = await db.promise().execute('SELECT * FROM maps WHERE LOWER(name) = ?', [name.toLowerCase()]);
        if (duplicateMap.length > 0) {
            return res.status(409).json({ error: 'Map with this name already exists.' });
        }

        // Insert into maps table
        await db.promise().execute('INSERT INTO maps (name, author, description, favourite, map_data, category, author_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [name, author, description, false, JSON.stringify({ locations }), category || null, player_id]);

        successfulSubmissionLimiter(req, res, () => {
            console.log(`Successful submission for IP ${ip}`);
            res.status(201).json({ message: 'Map submitted successfully!' });
        });

    } catch (err) {
        console.error('Error inserting map:', err);
        return res.status(500).json({ error: 'Failed to submit map.' });
    }
});

// Update map
communityMapRouter.put('', [
    failedSubmissionLimiter, authenticateTokenWithId,
    body('name').isLength({ min: 3, max: 17 }).withMessage('Map name must be between 3 and 17 characters.'),
    body('mapData').isLength({ max: 600000 }).withMessage('Map data cannot exceed 600,000 characters (slightly above 10 000 locations).'),
], async (req, res) => {
    const { id: player_id, name: rawName, mapData } = req.body; // include player_id
    const ip = req.clientIp;
    let name = rawName;

    const db = getDB();
    const errors = validationResult(req);

    if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
    }

    if (!player_id || !rawName || !mapData) {
        return res.status(400).json({ error: 'All input fields are required.' });
    }

    let parsedMapData;
    let locations; // here locations are converted to numbers in case they are strings

    try {
        parsedMapData = JSON.parse(mapData);
        locations = parsedMapData.locations.map(coord => [
            parseFloat(coord[0]),
            parseFloat(coord[1])
        ]);

        if (!isValidMap({ locations })) {
            return res.status(400).json({ error: 'Invalid map data. Must contain at least 50 locations with valid coordinates.' });
        }
    } catch (error) {
        console.error('Error parsing JSON:', error);
        const mapDataSnippet = mapData.split('\n').slice(0, 10).join('\n');
        return res.status(400).json({ error: 'Invalid JSON format for map data. Failed to parse: ' + mapDataSnippet });
    }

    try {
        // Check if the map exists and if the requesting user is the owner
        const [map] = await db.promise().execute('SELECT * FROM maps WHERE LOWER(name) = ? AND author_id = ?', [name.toLowerCase(), player_id]);

        if (map.length === 0) {
            return res.status(404).json({ error: 'Map not found or you do not have permission to update this map.' });
        }

        // Update the map in the database
        await db.promise().execute('UPDATE maps SET map_data = ? WHERE LOWER(name) = ? AND author_id = ?', [JSON.stringify({ locations }), name.toLowerCase(), player_id]);

        res.status(200).json({ message: 'Map updated successfully!' });

    } catch (err) {
        console.error('Error updating map:', err);
        return res.status(500).json({ error: 'Failed to update map.' });
    }
});

// 3.1) Delete map
communityMapRouter.delete('/:name', standardLimiter, authenticateTokenWithId, (req, res) => {
    const name = req.params.name.toLowerCase();
    const author_id = req.body.id;
    const db = getDB();

    // Check if the map exists and if the author_id matches
    db.execute('SELECT * FROM maps WHERE LOWER(name) = ? AND author_id = ?', [name, author_id], (err, results) => {
        if (err) {
            console.error('Error finding map:', err);
            return res.status(500).json({ error: 'Failed to find map.' });
        }

        if (results.length === 0) {
            return res.status(404).json({ error: 'Map not found or you do not have permission to update this map.' });
        }

        // If map exists and author_id matches, proceed to delete
        db.execute('DELETE FROM maps WHERE LOWER(name) = ?', [name], (deleteErr) => {
            if (deleteErr) {
                console.error('Error deleting map:', deleteErr);
                return res.status(500).json({ error: 'Failed to delete map.' });
            }

            res.status(200).json({ message: 'Map deleted successfully.' });
        });
    });
});

// 3.2) Like or Dislike map
communityMapRouter.post('/like/:name', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const name = req.params.name.toLowerCase();
    const player_id = req.body.id;
    const db = getDB();

    try {
        // Check if the map exists
        const [mapResults] = await db.promise().execute('SELECT * FROM maps WHERE LOWER(name) = ?', [name]);

        if (mapResults.length === 0) {
            return res.status(404).json({ error: 'Map not found.' });
        }

        const map = mapResults[0];
        const mapId = map.id;

        // Check if the player has already liked the map
        const [likeResults] = await db.promise().execute('SELECT * FROM map_likes WHERE map_id = ? AND player_id = ?', [mapId, player_id]);

        if (likeResults.length > 0) {
            // Player already liked the map, so this is a dislike
            await db.promise().execute('DELETE FROM map_likes WHERE map_id = ? AND player_id = ?', [mapId, player_id]);

            // Decrement the likes count, ensuring it doesn't go below 0
            await db.promise().execute('UPDATE maps SET likes = GREATEST(likes - 1, 0) WHERE id = ?', [mapId]);

            return res.status(200).json({ message: 'Map disliked successfully.' });
        } else {
            // Player hasn't liked the map yet, so this is a like
            await db.promise().execute('INSERT INTO map_likes (map_id, map_name, player_id, `like`) VALUES (?, ?, ?, ?)', [mapId, map.name, player_id, 1]);

            // Increment the likes count
            await db.promise().execute('UPDATE maps SET likes = likes + 1 WHERE id = ?', [mapId]);

            return res.status(200).json({ message: 'Map liked successfully.' });
        }
    } catch (error) {
        console.error("Error during map like/dislike:", error);
        return res.status(500).json({ error: 'An error occurred while liking or disliking the map.' });
    }
});

// 3.3) Get map like amount & personal like status if id passed 
communityMapRouter.post('/rating/:name', standardLimiter, async (req, res) => {
    const name = req.params.name.toLowerCase();
    const player_id = req.body.id;
    const db = getDB();

    try {
        // Check if the map exists and retrieve the likes count
        const [mapResults] = await db.promise().execute('SELECT likes FROM maps WHERE LOWER(name) = ?', [name]);

        if (mapResults.length === 0) {
            return res.status(404).json({ error: 'Map not found.' });
        }

        const likeAmount = mapResults[0].likes;
        let liked = false;

        if (player_id) {
            // Check if the player has liked the map
            const [likeResults] = await db.promise().execute('SELECT 1 FROM map_likes WHERE map_id = (SELECT id FROM maps WHERE LOWER(name) = ?) AND player_id = ?', [name, player_id]);

            if (likeResults.length > 0) {
                liked = true;
            }
        }

        return res.status(200).json({ likeAmount, liked });
    } catch (error) {
        console.error("Error fetching map rating:", error);
        return res.status(500).json({ error: 'An error occurred while fetching the map rating.' });
    }
});

module.exports = communityMapRouter;