import express from 'express';
import { standardLimiter, failedSubmissionLimiter, successfulSubmissionLimiter } from "./rateLimiters.js";
import { authenticateTokenWithId } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import { body, validationResult } from 'express-validator';
import { getPublicObjectURL, spacesClient } from './spacesConnection.js';
import { s3Config } from "./config.js";
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { removeMapFromCache } from './locations.js';
import { check } from 'fast-profanity-filter';

const communityMapRouter = express.Router();

// Return the next 50 maps starting from a given index (without map data!)
communityMapRouter.get('/index/:index', standardLimiter, (req, res) => {
    const db = getDB();
    const limit = 50;

    const startIndex = parseInt(req.params.index, 10);
    if (isNaN(startIndex) || startIndex < 0) return res.status(400).json({ error: 'Invalid start index' });

    // the questionmarks in the sql are then being filled in by the array's content!
    db.query('SELECT name, author, description, favourite, category, author_id, likes FROM maps ORDER BY likes DESC LIMIT ?, ?', [startIndex, limit], (err, results) => {
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

// Filter maps by category with pagination
communityMapRouter.get('/category/:category/:index', standardLimiter, (req, res) => {
    const db = getDB();

    const category = req.params.category;
    const startIndex = parseInt(req.params.index, 10);
    if (isNaN(startIndex) || startIndex < 0) return res.status(400).json({ error: 'Invalid start index' });

    const limit = 50;

    db.query('SELECT name, author, description, favourite, category, author_id, likes FROM maps WHERE category = ? ORDER BY likes DESC LIMIT ? OFFSET ?', [category, limit, startIndex], (err, results) => {
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

// Get maps created by a certain user (user id)
communityMapRouter.get('/by-user/:id/:index', standardLimiter, (req, res) => {
    const db = getDB();
    const limit = 50;
    const authorId = parseInt(req.params.id, 10);
    const startIndex = parseInt(req.params.index, 10);

    if (isNaN(authorId) || authorId < 0) return res.status(400).json({ error: 'Invalid author ID' });
    if (isNaN(startIndex) || startIndex < 0) return res.status(400).json({ error: 'Invalid start index' });

    // Filter by author_id and maintain the same ordering by likes
    db.query(
        'SELECT name, author, description, favourite, category, author_id, likes FROM maps WHERE author_id = ? ORDER BY likes DESC LIMIT ?, ?',
        [authorId, startIndex, limit],
        (err, results) => {
            if (err) {
                console.error('Error fetching maps by author:', err);
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
        }
    );
});

// Search maps by query with pagination
communityMapRouter.get('/search/:query/:index', standardLimiter, (req, res) => {
    const db = getDB();

    const query = `%${req.params.query}%`;
    const startIndex = parseInt(req.params.index, 10);
    if (isNaN(startIndex) || startIndex < 0) return res.status(400).json({ error: 'Invalid start index' });

    const limit = 50;

    db.query('SELECT name, author, description, favourite, category, author_id, likes FROM maps WHERE name LIKE ? OR author LIKE ? ORDER BY likes DESC LIMIT ? OFFSET ?', [query, query, limit, startIndex], (err, results) => {
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

// Return all favourite maps
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

// Get the actual map data by the name of the map
communityMapRouter.get('/:name', standardLimiter, async (req, res) => {
    const db = getDB();
    const name = req.params.name.toLowerCase().replaceAll("_", " ");

    try {
        const [results] = await db.promise().execute('SELECT * FROM maps WHERE LOWER(name) = ?', [name]);
        if (results.length === 0) return res.status(404).json({ error: 'Map not found.' });
        const { id, name: mapName, author, author_id: authorId, description, storage_key, favourite, category, likes } = results[0];

        let mapDataUrl = await getPublicObjectURL(storage_key);

        const map = {
            id,
            name: mapName,
            author,
            authorId,
            description,
            favourite: !!favourite, // Boolean conversion
            category,
            likes,
            map_data_url: mapDataUrl // Include file url
        };

        res.json(map);
    } catch (err) {
        console.error('Error fetching map:', err);
        return res.status(500).json({ error: 'Failed to fetch map.' });
    }
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
        const seenLocations = new Set();
        for (let location of map.locations) {
            if (!Array.isArray(location) || location.length !== 2) {
                console.log("Map did not include coordinates at some spots.");
                return false;
            }
            if (typeof location[0] !== 'number' || typeof location[1] !== 'number') {
                console.log("Map coordinates weren't numbers.");
                return false;
            }
            const locationKey = JSON.stringify(location);
            if (seenLocations.has(locationKey)) {
                console.log("Map contains duplicate coordinates.");
                return false;
            }
            seenLocations.add(locationKey);
        }
        return true;
    } catch (error) {
        console.error("Error occurred during map validation: " + error);
        return false;
    }
};

// Endpoint to submit a new map
communityMapRouter.post('/', [
    failedSubmissionLimiter, authenticateTokenWithId,
    body('name').isLength({ min: 3, max: 25 }).withMessage('Map name must be between 3 and 25 characters.').custom((value) => {
        if (!check(value)) throw new Error('Map name is empty or contains inappropriate words.');
        return true;
    }),
    body('description').isLength({ min: 50, max: 300 }).withMessage('Description must be between 50 and 300 characters.').custom((value) => {
        if (!check(value)) throw new Error('Map description is empty or contains inappropriate words.');
        return true;
    }),
    body('mapData').isLength({ max: 600000 }).withMessage('Map data cannot exceed 600,000 characters (approx. 10,000 locations).'),
], async (req, res) => {
    const { id: player_id, name: rawName, description: rawDescription, mapData, category } = req.body;

    const db = getDB();

    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!player_id || !rawName || !rawDescription || !mapData) return res.status(400).json({ error: 'All input fields are required.' });

    try {
        // Fetch the user to get the actual username
        const [userResults] = await db.promise().execute('SELECT user_name FROM users WHERE id = ?', [player_id]);
        if (userResults.length === 0) return res.status(404).json({ error: 'User not found.' });

        const author = userResults[0].user_name;

        // Remove illegal link symbols
        let name = rawName.split("_").join(" ");
        name = name.split("/").join(" ");
        name = name.split("+").join(" ");
        name = name.split("&").join(" ");
        name = name.split("#").join(" ");
        name = name.split("?").join(" ");
        name = name.replace(/\s+/g, " ").trim();

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

            if (!isValidMap({ locations })) return res.status(400).json({ error: 'Invalid map data. Must contain at least 50 locations with valid coordinates.' });
        } catch (error) {
            console.error('Error parsing JSON:', error);
            return res.status(400).json({ error: 'Invalid JSON format for map data. Failed to parse.' });
        }

        // Check for duplicate map names
        const [duplicateMap] = await db.promise().execute(
            'SELECT * FROM maps WHERE LOWER(TRIM(name)) = LOWER(TRIM(?))',
            [name]
        );
        if (duplicateMap.length > 0) return res.status(409).json({ error: 'Map with this name already exists.' });

        // Check rate limit BEFORE uploading or saving to database – this only counts for successful submissions that made it so far
        await new Promise((resolve, reject) => {
            successfulSubmissionLimiter(req, res, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Insert basic map info into the database first (without map data)
        const [result] = await db.promise().execute(
            'INSERT INTO maps (name, author, description, favourite, category, author_id, likes) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, author, description, false, category || null, player_id, 0]
        );

        const mapId = result.insertId;
        const mapDataJson = JSON.stringify({ locations });
        const storageKey = `openguessr-maps/${mapId}.json`;

        try {
            // Upload map data to Spaces
            await spacesClient.send(
                new PutObjectCommand({
                    Bucket: s3Config.bucketName,
                    Key: storageKey,
                    Body: mapDataJson,
                    ContentType: 'application/json',
                    ACL: 'public-read', // Make publicly readable
                })
            );
        } catch (uploadError) {
            // Delete the database entry if upload fails
            await db.promise().execute('DELETE FROM maps WHERE id = ?', [mapId]);
            throw uploadError; // Re-throw to be caught by outer catch
        }

        // Update the map record with the storage key
        await db.promise().execute(
            'UPDATE maps SET storage_key = ? WHERE id = ?',
            [storageKey, mapId]
        );

        res.status(201).json({ message: 'Map submitted successfully!' });

    } catch (err) {
        console.error('Error inserting map:', err);
        return res.status(500).json({ error: 'Failed to submit map.' });
    }
});

// Update map
communityMapRouter.put('/', [
    failedSubmissionLimiter, authenticateTokenWithId,
    body('mapData').isLength({ max: 600000 }).withMessage('Map data cannot exceed 600,000 characters (approx. 10,000 locations).'),
], async (req, res) => {
    const { id: player_id, name, mapData } = req.body;

    const db = getDB();
    const errors = validationResult(req);

    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!player_id || !name || !mapData) return res.status(400).json({ error: 'Name, player ID and data is required.' });

    let parsedMapData;
    let locations; // here locations are converted to numbers in case they are strings

    try {
        parsedMapData = JSON.parse(mapData);
        locations = parsedMapData.locations.map(coord => [
            parseFloat(coord[0]),
            parseFloat(coord[1])
        ]);

        if (!isValidMap({ locations })) return res.status(400).json({ error: 'Invalid map data. Must contain at least 50 locations with valid coordinates.' });

    } catch (error) {
        console.error('Error parsing JSON:', error);
        const mapDataSnippet = mapData.substring(0, 100) + '...';
        return res.status(400).json({ error: 'Invalid JSON format for map data. Failed to parse: ' + mapDataSnippet });
    }

    try {
        // Check if the map exists and if the requesting user is the owner
        const [map] = await db.promise().execute('SELECT id, storage_key FROM maps WHERE LOWER(name) = ? AND author_id = ?', [name.toLowerCase(), player_id]);
        if (map.length === 0) return res.status(404).json({ error: 'Map not found or you do not have permission to update this map.' });

        const mapDataJson = JSON.stringify({ locations });
        const storageKey = map[0].storage_key;
        if (!storageKey) return res.status(400).json({ error: 'This map does not yet have a storage key assigned.' });

        // Upload updated map data to Spaces
        await spacesClient.send(
            new PutObjectCommand({
                Bucket: s3Config.bucketName,
                Key: storageKey,
                Body: mapDataJson,
                ContentType: 'application/json',
                ACL: 'public-read', // Make publicly readable
            })
        );

        // Remove from cache so that the new version will be pulled
        removeMapFromCache("community_" + name.toLowerCase());

        res.status(200).json({ message: 'Map updated successfully!' });
    } catch (err) {
        console.error('Error updating map:', err);
        return res.status(500).json({ error: 'Failed to update map.' });
    }
});

// Delete map
communityMapRouter.delete('/:name', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const name = req.params.name.toLowerCase();
    const author_id = req.body.id;
    const db = getDB();

    try {
        // Check if the map exists and if the author_id matches
        const [results] = await db.promise().execute('SELECT id, storage_key FROM maps WHERE LOWER(name) = ? AND author_id = ?', [name, author_id]);

        if (results.length === 0) {
            return res.status(404).json({ error: 'Map not found or you do not have permission to delete this map.' });
        }

        const { id, storage_key } = results[0];

        // If the map has a storage key, delete from Spaces
        if (storage_key) {
            try {
                await spacesClient.send(
                    new DeleteObjectCommand({
                        Bucket: s3Config.bucketName,
                        Key: storage_key
                    })
                );
            } catch (error) {
                throw new Error("Error deleting map from S3: " + error.message)
            }
        }

        // Delete from the database
        await db.promise().execute('DELETE FROM maps WHERE id = ?', [id]);

        res.status(200).json({ message: 'Map deleted successfully.' });
    } catch (err) {
        console.error('Error deleting map:', err);
        return res.status(500).json({ error: 'Failed to delete map.' });
    }
});

// Like or Dislike map
communityMapRouter.post('/like/:name', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const name = req.params.name.toLowerCase();
    const player_id = req.body.id;
    const db = getDB();

    try {
        // Check if the map exists
        const [mapResults] = await db.promise().execute('SELECT * FROM maps WHERE LOWER(name) = ?', [name]);
        if (mapResults.length === 0) return res.status(404).json({ error: 'Map not found.' });

        const map = mapResults[0];
        const mapId = map.id;

        // Check if the player has already liked the map
        const [likeResults] = await db.promise().execute('SELECT * FROM map_likes WHERE map_id = ? AND player_id = ?', [mapId, player_id]);

        if (likeResults.length > 0) {
            // Player already liked the map, so this is a dislike
            await db.promise().execute('DELETE FROM map_likes WHERE map_id = ? AND player_id = ?', [mapId, player_id]);
            await db.promise().execute('UPDATE maps SET likes = GREATEST(likes - 1, 0) WHERE id = ?', [mapId]); // Decrement the map's like count, ensuring it doesn't go below 0

            return res.status(200).json({ message: 'Map disliked successfully.' });
        } else {
            // Player hasn't liked the map yet, so this is a like
            await db.promise().execute('INSERT INTO map_likes (map_id, map_name, player_id) VALUES (?, ?, ?)', [mapId, map.name, player_id]);
            await db.promise().execute('UPDATE maps SET likes = IFNULL(likes, 0) + 1 WHERE id = ?', [mapId]); // Increment the map's like count
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
        if (mapResults.length === 0) return res.status(404).json({ error: 'Map not found.' });

        const likeAmount = mapResults[0].likes;
        let liked = false;

        if (player_id) {
            // Check if the player has liked the map
            const [likeResults] = await db.promise().execute('SELECT 1 FROM map_likes WHERE map_id = (SELECT id FROM maps WHERE LOWER(name) = ?) AND player_id = ?', [name, player_id]);
            if (likeResults.length > 0) liked = true;
        }

        return res.status(200).json({ likeAmount, liked });
    } catch (error) {
        console.error("Error fetching map rating:", error);
        return res.status(500).json({ error: 'An error occurred while fetching the map rating.' });
    }
});

export default communityMapRouter;