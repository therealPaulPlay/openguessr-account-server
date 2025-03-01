const express = require('express');
const creatorRouter = express.Router();
const { standardLimiter } = require("./rateLimiters.js");
const { getDB } = require("./dbConnection.js");

creatorRouter.post('/creator-link-statistic', standardLimiter, async (req, res) => {
    try {
        const db = getDB();
        const { creator } = req.body;
        const ip_address = req.clientIp;

        if (!creator || !ip_address) return res.status(400).json({ error: "Creator and ip are required." });

        // Check if combination exists and insert if it doesn't
        const query = `
            INSERT INTO creator_statistics (creator, ip_address)
            SELECT ?, ?
            WHERE NOT EXISTS (
                SELECT 1 FROM creator_statistics 
                WHERE creator = ? AND ip_address = ?
            )
        `;

        const result = await new Promise((resolve, reject) => {
            db.execute(query, [creator.toLowerCase(), ip_address, creator.toLowerCase(), ip_address], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        return res.status(200).json({ message: "Added creator statistic successfully." });

    } catch (error) {
        console.error('Error creating creator link statistic:', error);
        return res.status(500).json({ error: "Internal server error" });
    }
});

module.exports = creatorRouter;