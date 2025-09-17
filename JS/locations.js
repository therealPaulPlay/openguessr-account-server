import express from 'express';
import { spacesClient } from './spacesConnection.js';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { getDB } from './dbConnection.js';
import { s3Config } from './config.js';
import { calculateMapBounds } from './calculateMapBounds.js';
import cron from "node-cron";

const locationRouter = express.Router();

let mapCache = {};

async function getMap(name) {
    const cacheEntry = mapCache[name];

    if (cacheEntry) {
        return cacheEntry;

    } else {
        // Community map check
        const db = getDB();
        const isCommunityMap = name.includes("community_");

        let storageKey;

        // If it's a community map, get the map file key
        if (isCommunityMap) {
            const [results] = await db.promise().execute('SELECT * FROM maps WHERE LOWER(name) = ?', [name.replace("community_", "")]);
            if (results.length === 0) throw new Error("Map not found!");
            storageKey = results[0]?.storage_key;
        } else {
            storageKey = "openguessr-official-maps/" + name + ".json";
        }

        // Get from S3
        const response = await spacesClient.send(new GetObjectCommand({
            Bucket: s3Config.bucketName,
            Key: storageKey
        }));
        const jsonString = await response.Body.transformToString();
        const mapData = JSON.parse(jsonString);
        const mapBounds = calculateMapBounds(mapData.locations);

        // Construct map object
        const mapObject = {
            data: mapData,
            bounds: mapBounds
        }

        // Set cache
        mapCache[name] = mapObject;

        return mapObject;
    }
}

function removeMapFromCache(name) {
    delete mapCache[name];
}

let keyLocationsCache = {};

// Key is a unique identifier for this user, room etc. to avoid duplicates
async function getLocations(mapName, amount, key) {
    let keyCache = keyLocationsCache[key];

    // If this is a different map or no entry exists, reset / initialize
    if (!keyCache || keyCache.mapName !== mapName || !Array.isArray(keyCache.prevIndexes)) {
        keyCache = keyLocationsCache[key] = { mapName, prevIndexes: [] };
    }

    // Get the map
    const map = await getMap(mapName);
    const locations = map?.data?.locations;
    const locationsLength = locations?.length || 0;
    const bounds = map?.bounds;

    // Previous indexes
    if (locationsLength * 0.65 < keyCache.prevIndexes.length)  keyCache.prevIndexes = []; // In case e.g. the map file was changed and the prevIndexes are too many, reset them
    const previousIndexes = keyCache.prevIndexes;

    const randomLocationIndexes = Array.from({ length: amount }, () => {
        let index;
        do { index = Math.floor(Math.random() * locationsLength); } while (previousIndexes.includes(index));
        previousIndexes.unshift(index); // Add index at the front of the array

        // if the array is longer than half of the total amount or 500, pop last one out
        if (previousIndexes.length > locationsLength / 2 || previousIndexes.length > 500) previousIndexes.pop();
        return index;
    });

    const batchLocations = randomLocationIndexes?.map(index => locations[Number(index)])?.filter(location => location !== undefined);
    return { locations: batchLocations, bounds };
}

// Locations are taken from S3 and either fixed or continuously updated (by the location generation server) files
locationRouter.put('/:mapName', async (req, res) => {
    const { amount = 5 } = req.body;
    const { mapName = "standard" } = req.params;

    try {
        // Validate that indexes exists and is an array
        if (!amount || !Number.isSafeInteger(amount) || amount < 1 || amount > 100) return res.status(400).json({ error: "Amount is invalid or too big." });
        const data = await getLocations(mapName, Number(amount), req.clientIp);

        res.json(data);
    } catch (error) {
        console.error(`Error sending out locations (${amount}) for map "${mapName}":`, error.message);
        res.status(500).json({ error: "Error sending out locations: " + error.message });
    }
});

// Reset caches periodically to prevent it from growing a lot
cron.schedule('0 */6 * * *', () => {
    mapCache = {};
    keyLocationsCache = {};
    console.log("Successfully cleared map locations cache.");
});

export { locationRouter, getLocations, removeMapFromCache };