import express from 'express';
import { standardLimiter, mapFailOrUpdateLimiter, successfulMapSubmissionLimiter } from "./rateLimiters.js";
import { authenticateTokenWithId } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import { cacheResponse, clearResponseCache } from "./responseCache.js";
import { body, validationResult } from 'express-validator';
import { getPublicObjectURL, spacesClient } from './spacesConnection.js';
import { s3Config } from "./config.js";
import { PutObjectCommand, DeleteObjectCommand } from '@aws-sdk/client-s3';
import { removeMapFromCache } from './locations.js';
import { check } from 'fast-profanity-filter';

const communityMapRouter = express.Router();

function clearMapPageCaches() {
    clearResponseCache("maps-index");
    clearResponseCache("maps-category");
    clearResponseCache("maps-favourites");
    clearResponseCache("maps-by-user");
    clearResponseCache("maps-by-name");
}

function buildMapsResult(results) {
    return results.map(map => ({
        name: map.name,
        author: map.author,
        authorId: map.author_id,
        description: map.description,
        favourite: Boolean(map.favourite),
        category: map.category,
        likes: map.likes
    }));
}

function returnSortColumnByQuery(req, res) {
    const sort = req.query["sort"] || "likes";

    if (!["likes", "newest", "oldest", "a-z"].includes(sort)) {
        res.status(400).json({ error: "Invalid sort option." });
        return { isReturn: true };
    }

    let columnName;
    let isDesc;

    switch (sort) {
        case "likes": {
            columnName = "likes";
            isDesc = true;
            break;
        }
        case "newest": {
            columnName = "created_at";
            isDesc = true;
            break;
        }
        case "oldest": {
            columnName = "created_at";
            isDesc = false;
            break;
        }
        case "a-z": {
            columnName = "name";
            isDesc = false;
            break;
        }
    }

    return { columnName, direction: isDesc ? "DESC" : "ASC", isReturn: false };
}

// Return the next 50 maps starting from a given index (without map data!)
communityMapRouter.get('/index/:index', standardLimiter, cacheResponse("maps-index"), (req, res) => {
    const db = getDB();
    const limit = 50;

    const startIndex = parseInt(req.params.index, 10);
    if (isNaN(startIndex) || startIndex < 0) return res.status(400).json({ error: 'Invalid start index.' });

    const { columnName, direction, isReturn } = returnSortColumnByQuery(req, res);
    if (isReturn) return;

    // the questionmarks in the sql are then being filled in by the array's content!
    db.query(`SELECT name, author, description, favourite, category, author_id, likes FROM maps ORDER BY ${columnName} ${direction} LIMIT ?, ?`, [startIndex, limit], (err, results) => {
        if (err) {
            console.error('Error fetching maps:', err);
            return res.status(500).json({ error: 'Failed to fetch maps.' });
        }

        const communityMaps = buildMapsResult(results);
        res.json({ communityMaps });
    });
});

// Filter maps by category with pagination
communityMapRouter.get('/category/:category/:index', standardLimiter, cacheResponse("maps-category"), (req, res) => {
    const db = getDB();
    const limit = 50;

    const category = req.params.category;
    const startIndex = parseInt(req.params.index, 10);
    if (isNaN(startIndex) || startIndex < 0) return res.status(400).json({ error: 'Invalid start index.' });

    const { columnName, direction, isReturn } = returnSortColumnByQuery(req, res);
    if (isReturn) return;

    db.query(`SELECT name, author, description, favourite, category, author_id, likes FROM maps WHERE category = ? ORDER BY ${columnName} ${direction} LIMIT ? OFFSET ?`, [category, limit, startIndex], (err, results) => {
        if (err) {
            console.error('Error fetching maps by category:', err);
            return res.status(500).json({ error: 'Failed to fetch maps.' });
        }

        const communityMaps = buildMapsResult(results);
        res.json({ communityMaps });
    });
});

// Get maps created by a certain user (user id)
communityMapRouter.get('/by-user/:id/:index', standardLimiter, cacheResponse("maps-by-user"), (req, res) => {
    const db = getDB();
    const limit = 50;
    const authorId = parseInt(req.params.id, 10);
    const startIndex = parseInt(req.params.index, 10);

    if (isNaN(authorId) || authorId < 0) return res.status(400).json({ error: 'Invalid author ID.' });
    if (isNaN(startIndex) || startIndex < 0) return res.status(400).json({ error: 'Invalid start index.' });

    const { columnName, direction, isReturn } = returnSortColumnByQuery(req, res);
    if (isReturn) return;

    // Filter by author_id and maintain the same ordering by likes
    db.query(
        `SELECT name, author, description, favourite, category, author_id, likes FROM maps WHERE author_id = ? ORDER BY ${columnName} ${direction} LIMIT ?, ?`,
        [authorId, startIndex, limit],
        (err, results) => {
            if (err) {
                console.error('Error fetching maps by author:', err);
                return res.status(500).json({ error: 'Failed to fetch maps.' });
            }

            const communityMaps = buildMapsResult(results);
            res.json({ communityMaps });
        }
    );
});

// Search maps by query with pagination
communityMapRouter.get('/search/:query/:index', standardLimiter, (req, res) => {
    const db = getDB();
    const limit = 50;

    const rawQuery = req.params.query.slice(0, 255);
    const query = `%${rawQuery}%`;
    const startIndex = parseInt(req.params.index, 10);
    if (isNaN(startIndex) || startIndex < 0) return res.status(400).json({ error: 'Invalid start index.' });

    const { columnName, direction, isReturn } = returnSortColumnByQuery(req, res);
    if (isReturn) return;

    db.query(`SELECT name, author, description, favourite, category, author_id, likes FROM maps WHERE name LIKE ? OR author LIKE ? ORDER BY ${columnName} ${direction} LIMIT ? OFFSET ?`, [query, query, limit, startIndex], (err, results) => {
        if (err) {
            console.error('Error searching maps:', err);
            return res.status(500).json({ error: 'Failed to search maps.' });
        }

        const communityMaps = buildMapsResult(results);
        res.json({ communityMaps });
    });
});

// Return all favourite maps
communityMapRouter.get('/favourites', standardLimiter, cacheResponse("maps-favourites"), (req, res) => {
    const db = getDB();

    db.execute('SELECT name, author, description, favourite, category, author_id, likes FROM maps WHERE favourite = TRUE ORDER BY likes DESC', (err, results) => {
        if (err) {
            console.error('Error fetching favourite maps:', err);
            return res.status(500).json({ error: 'Failed to fetch favourite maps.' });
        }

        const communityMaps = buildMapsResult(results);
        res.json({ communityMaps });
    });
});

// Get the actual map data by the name of the map
communityMapRouter.get('/:name', standardLimiter, cacheResponse("maps-by-name"), async (req, res) => {
    const db = getDB();
    const name = req.params.name.toLowerCase().replaceAll("_", " ");

    try {
        const [results] = await db.promise().execute('SELECT * FROM maps WHERE LOWER(name) = ?', [name]);
        if (results.length === 0) return res.status(404).json({ error: 'Map not found.' });
        const { id, name: mapName, author, author_id: authorId, description, storage_key, favourite, category, likes } = results[0];

        // Check if this author has other maps
        const [otherMaps] = await db.promise().execute(
            'SELECT name, author, description, favourite, category, author_id, likes FROM maps WHERE author_id = ? AND id != ? ORDER BY likes DESC LIMIT 50',
            [authorId, id]
        );

        let mapDataUrl = await getPublicObjectURL(storage_key);

        const response = {
            id,
            name: mapName,
            author,
            authorId,
            description,
            favourite: Boolean(favourite),
            category,
            likes,
            map_data_url: mapDataUrl, // Include file url
            otherMaps: buildMapsResult(otherMaps)
        };

        res.json(response);
    } catch (err) {
        console.error('Error fetching map:', err);
        return res.status(500).json({ error: 'Failed to fetch map.' });
    }
});


// Helper function to validate map structure, also used by competitions with stricter limits
export const isValidMap = (map, { minLocations = 50, maxLocations = null } = {}) => {
    try {
        if (!map.locations || !Array.isArray(map.locations)) return 'Map locations must be a non-empty array.';
        if (map.locations.length < minLocations) return `Map must contain at least ${minLocations} location${minLocations === 1 ? '' : 's'} (got ${map.locations.length}).`;
        if (maxLocations && map.locations.length > maxLocations) return `Map cannot contain more than ${maxLocations} locations (got ${map.locations.length}).`;

        const seenLocations = new Set();

        for (let location of map.locations) {
            if (!Array.isArray(location) || location.length < 2 || location.length > 3) return 'Each location must be an array of two coordinates and an optional data object.';
            if (!Number.isFinite(location[0]) || !Number.isFinite(location[1])) return 'Location coordinates must be numbers.';

            const additionalData = location[2]; // Optional third entry

            // Validate additional data if provided
            if (additionalData !== undefined) {
                if (!additionalData || typeof additionalData !== 'object' || Array.isArray(additionalData)) return 'Invalid location data provided, must be an object.';
                if (Object.keys(additionalData).length === 0) return 'The location data object cannot be empty.';
                for (const key of Object.keys(additionalData)) {
                    if (!["heading", "pitch", "panoramaId"].includes(key)) return `Unknown key "${key}" in the location data object.`;
                }
                if ("heading" in additionalData && additionalData.heading !== null && !Number.isFinite(additionalData.heading)) return 'Heading must be a number or null.';
                if ("pitch" in additionalData && additionalData.pitch !== null && !Number.isFinite(additionalData.pitch)) return 'Pitch must be a number or null.';
                if ("panoramaId" in additionalData && additionalData.panoramaId !== null && (typeof additionalData.panoramaId !== 'string' || !additionalData.panoramaId.length || additionalData.panoramaId.length > 64)) return 'Panorama ID must be a string of at most 64 characters or null.';
            }

            // Check for duplicates
            const locationKey = `${location[0]},${location[1]}`;
            if (seenLocations.has(locationKey)) return `Map contains duplicate location: [${location[0]}, ${location[1]}]`;
            seenLocations.add(locationKey);
        }
        return null;
    } catch (error) {
        console.error("Error occurred during map validation: " + error);
        return 'An error occurred during map validation.';
    }
};

// Shared by map submission and description update
const descriptionValidator = body('description').isString().withMessage('Description must be provided.').bail().isLength({ min: 50, max: 300 }).withMessage('Description must be between 50 and 300 characters.').custom((value) => {
    if (!check(value)) throw new Error('Description is empty or contains inappropriate words.');
    return true;
});

// Endpoint to submit a new map
communityMapRouter.post('/', [
    mapFailOrUpdateLimiter, authenticateTokenWithId,
    body('name').isString().withMessage('Map name must be provided.').bail()
        .customSanitizer((value) => value.replace(/[_/+&#?%]/g, ' ').replace(/\s+/g, ' ').trim())
        .isLength({ min: 3, max: 25 }).withMessage('Map name must be between 3 and 25 characters.').custom((value) => {
            if (!check(value)) throw new Error('Map name is empty or contains inappropriate words.');
            return true;
        }),
    descriptionValidator,
    body('mapData').isLength({ max: 600000 }).withMessage('Map data cannot exceed 600,000 characters (approx. 10,000 locations).'),
    body('category').isString().withMessage('Category must be provided.').bail()
        .isIn(['Nature', 'Architecture', 'Urban', 'Regions', 'Sports', 'Transport', 'Miscellaneous']).withMessage('Invalid map category.'),
], async (req, res) => {
    const { id: player_id, name, description: rawDescription, mapData, category } = req.body;

    const db = getDB();

    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!player_id || !name || !rawDescription || !mapData || !category) return res.status(400).json({ error: 'All input fields are required.' });

    try {
        // Fetch the user to get the actual username
        const [userResults] = await db.promise().execute('SELECT user_name FROM users WHERE id = ?', [player_id]);
        if (userResults.length === 0) return res.status(404).json({ error: 'User not found.' });

        const author = userResults[0].user_name;

        let description = rawDescription.trim();
        description = /[.?!]$/.test(description) ? description : `${description}.`;

        let locations;

        try {
            locations = JSON.parse(mapData).locations;

            const mapError = isValidMap({ locations });
            if (mapError) return res.status(400).json({ error: mapError });
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
            successfulMapSubmissionLimiter(req, res, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });

        // Insert basic map info into the database first (without map data)
        const [result] = await db.promise().execute(
            'INSERT INTO maps (name, author, description, favourite, category, author_id, likes) VALUES (?, ?, ?, ?, ?, ?, ?)',
            [name, author, description, false, category, player_id, 0]
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

        clearMapPageCaches();
        res.status(201).json({ message: 'Map submitted successfully!', name }); // Name is returned since the sanitizer might alter it

    } catch (err) {
        console.error('Error inserting map:', err);
        return res.status(500).json({ error: 'Failed to submit map.' });
    }
});

// Update map
communityMapRouter.put('/', [
    mapFailOrUpdateLimiter, authenticateTokenWithId,
    body('mapData').isLength({ max: 600000 }).withMessage('Map data cannot exceed 600,000 characters (approx. 10,000 locations).'),
], async (req, res) => {
    const { id: player_id, name, mapData } = req.body;

    const db = getDB();
    const errors = validationResult(req);

    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });
    if (!player_id || !name || !mapData) return res.status(400).json({ error: 'Name, player ID and data is required.' });

    let locations;

    try {
        locations = JSON.parse(mapData).locations;

        const mapError = isValidMap({ locations });
        if (mapError) return res.status(400).json({ error: mapError });

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

        clearMapPageCaches();
        res.status(200).json({ message: 'Map updated successfully!' });
    } catch (err) {
        console.error('Error updating map:', err);
        return res.status(500).json({ error: 'Failed to update map.' });
    }
});

// Update map description
communityMapRouter.put('/description', [
    standardLimiter, authenticateTokenWithId,
    body('name').isString().withMessage('Map name must be provided.'),
    descriptionValidator,
], async (req, res) => {
    const { id: player_id, name, description: rawDescription } = req.body;

    const errors = validationResult(req);
    if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

    let description = rawDescription.trim();
    description = /[.?!]$/.test(description) ? description : `${description}.`;

    try {
        const [result] = await getDB().promise().execute('UPDATE maps SET description = ? WHERE LOWER(name) = ? AND author_id = ?', [description, name.toLowerCase(), player_id]);
        if (result.affectedRows === 0) return res.status(404).json({ error: 'Map not found or you do not have permission to update this map.' });

        clearMapPageCaches();
        res.status(200).json({ description });
    } catch (err) {
        console.error('Error updating description:', err);
        return res.status(500).json({ error: 'Failed to update description.' });
    }
});

// Delete map
communityMapRouter.delete('/:name', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const nameLowercase = req.params.name.toLowerCase();
    const author_id = req.body.id;
    const db = getDB();

    try {
        // Check if the map exists and if the author_id matches
        const [results] = await db.promise().execute('SELECT id, storage_key FROM maps WHERE LOWER(name) = ? AND author_id = ?', [nameLowercase, author_id]);

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

        // Remove from cache so locations aren't served after deletion
        removeMapFromCache("community_" + nameLowercase);

        clearMapPageCaches();
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
    const like = req.body.like;
    const db = getDB();

    if (typeof like !== 'boolean') return res.status(400).json({ error: 'Like state is required.' });

    try {
        // Check if the map exists
        const [mapResults] = await db.promise().execute('SELECT * FROM maps WHERE LOWER(name) = ?', [name]);
        if (mapResults.length === 0) return res.status(404).json({ error: 'Map not found.' });

        const map = mapResults[0];
        const mapId = map.id;

        if (like) {
            const [result] = await db.promise().execute('INSERT IGNORE INTO map_likes (map_id, map_name, player_id) VALUES (?, ?, ?)', [mapId, map.name, player_id]);
            if (result.affectedRows > 0) await db.promise().execute('UPDATE maps SET likes = IFNULL(likes, 0) + 1 WHERE id = ?', [mapId]); // Increment the map's like count
        } else {
            const [result] = await db.promise().execute('DELETE FROM map_likes WHERE map_id = ? AND player_id = ?', [mapId, player_id]);
            if (result.affectedRows > 0) await db.promise().execute('UPDATE maps SET likes = GREATEST(likes - 1, 0) WHERE id = ?', [mapId]); // Decrement the map's like count, ensuring it doesn't go below 0
        }

        return res.status(200).json({ liked: like });
    } catch (error) {
        console.error("Error during map like/dislike:", error);
        return res.status(500).json({ error: 'An error occurred while liking or disliking the map.' });
    }
});

// Get map like amount & personal like status if id passed 
communityMapRouter.post('/rating/:name', standardLimiter, async (req, res) => {
    const name = req.params.name.toLowerCase();
    const playerId = req.body.id;
    const db = getDB();

    try {
        // Check if the map exists and retrieve the likes count
        const [mapResults] = await db.promise().execute('SELECT likes FROM maps WHERE LOWER(name) = ?', [name]);
        if (mapResults.length === 0) return res.status(404).json({ error: 'Map not found.' });

        const likeAmount = mapResults[0].likes;
        let liked = false;

        if (playerId) {
            // Check if the player has liked the map
            const [likeResults] = await db.promise().execute('SELECT 1 FROM map_likes WHERE map_id = (SELECT id FROM maps WHERE LOWER(name) = ?) AND player_id = ?', [name, playerId]);
            if (likeResults.length > 0) liked = true;
        }

        return res.status(200).json({ likeAmount, liked });
    } catch (error) {
        console.error("Error fetching map rating:", error);
        return res.status(500).json({ error: 'An error occurred while fetching the map rating.' });
    }
});

export default communityMapRouter;