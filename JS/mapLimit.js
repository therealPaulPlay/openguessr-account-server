import express from 'express';
const mapLimitRouter = express.Router();
import { mapLoadLimiter, supporterMapLoadLimiter } from "./rateLimiters.js";
import jwt from 'jsonwebtoken';
import { getDB } from "./dbConnection.js";
import { jwtSecret as SECRET_KEY } from "./config.js";
import cron from 'node-cron';
import validateCaptcha from './captchaMiddleware.js';

// Function to check the rate limit
function checkRateLimit(req, res) {
    return new Promise((resolve, reject) => {
        mapLoadLimiter(req, res, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

function checkSupporterRateLimit(req, res) {
    return new Promise((resolve, reject) => {
        supporterMapLoadLimiter(req, res, (err) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

// Maplimit endpoint
mapLimitRouter.get('/maplimit', validateCaptcha, async (req, res) => {
    const db = getDB();

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Expires', '0');

    try {
        // Extract Id from authorization header
        const authorizationHeader = req.headers['authorization'];
        let tokenId = null;

        if (authorizationHeader && authorizationHeader.startsWith('Bearer ')) {
            const token = authorizationHeader.substring('Bearer '.length);
            try {
                const decoded = jwt.verify(token, SECRET_KEY);
                tokenId = decoded.userId;
            } catch (jwtError) {
                return res.status(403).json({ status: 403, error: "An error occurred decoding the Authentication token." });
            }
        }

        let shouldSkipRateLimit = tokenId !== null && tokenId <= 5; // Developers can skip
        let isSupporter = false;

        // Check for supporter status
        try {
            if (tokenId) {
                const userIsSupporterQuery = 'SELECT supporter_level FROM users WHERE id = ?';
                const userWithSupporter = await new Promise((resolve, reject) => {
                    db.execute(userIsSupporterQuery, [tokenId], (err, results) => {
                        if (err) return reject(err);
                        resolve(results[0]);
                    });
                });

                if (userWithSupporter && userWithSupporter.supporter_level >= 1) {
                    isSupporter = true;
                }
            }
        } catch (error) {
            console.error("Error occurred during supporter check for map limit:", error);
        }

        // Apply rate limits
        if (!shouldSkipRateLimit) {
            try {
                if (!isSupporter) {
                    await checkRateLimit(req, res);
                } else {
                    await checkSupporterRateLimit(req, res);
                    console.log("User used supporter map limit.");
                }
            } catch (rateLimitError) {
                if (rateLimitError.message && typeof rateLimitError.message === 'object' && rateLimitError.message.error) {
                    return res.status(429).json({ error: rateLimitError.message.error });
                }
                // If it's not a rate limit error, re-throw it to be caught by the outer catch block
                throw rateLimitError;
            }
        }

        // Capture map load for statistics
        try {
            const ipAddress = req.clientIp || 'anonymous'; // Use client IP address or 'anonymous' if not available

            // Insert the map load record into the database
            const insertQuery = 'INSERT INTO cost_statistics (ip_address) VALUES (?)';
            await new Promise((resolve, reject) => {
                db.execute(insertQuery, [ipAddress], (err, results) => {
                    if (err) return reject(err);
                    resolve(results);
                });
            });
        } catch (error) {
            console.error("Error capturing maplimit statistic:", error);
        }

        // Fetch rate limit headers
        let rateLimitLimit;
        let rateLimitUsed;

        try {
            rateLimitLimit = res.get('X-RateLimit-Limit');
            const rateLimitRemaining = res.get('X-RateLimit-Remaining');

            // Calculate the number of requests used
            if (rateLimitLimit && rateLimitRemaining) {
                rateLimitUsed = rateLimitLimit - rateLimitRemaining;
                rateLimitUsed = rateLimitUsed.toString();
            }
        } catch (error) {
            console.error("Error calculating maplimit limit and used values:", error);
        }

        // Get new, rotated API key to prevent misuse
        let ApiKey = "Key not provided";

        try {
            ApiKey = "PLACEHOLDER"; // Replace with actual key / key system
        } catch (error) {
            console.error("Error getting API KEY in maplimit endpoint:", error);
        }

        // Return the response with the rate limit headers
        return res.json({
            message: 'Map load request successful. Limit not reached.',
            rateLimit: {
                limit: rateLimitLimit || "∞",
                used: rateLimitUsed || "∞"
            },
            apiKey: ApiKey
        });

    } catch (error) {
        console.error("Unexpected error during maplimit check: ", error);
        return res.status(500).json({ error: 'An unexpected error occurred' });
    }
});

export default mapLimitRouter;

// Schedule the job to run every day at 1 AM to remove old statistic entries

/* !CHANGE this to enable automatic cleanup of maplimit statistics
cron.schedule('0 1 * * *', async () => {
    const db = getDB();

    try {
        const deleteQuery = 'DELETE FROM cost_statistics WHERE date < CURDATE() - INTERVAL 2 DAY';
        await new Promise((resolve, reject) => {
            db.execute(deleteQuery, (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });
        console.log("Old map load records cleaned up successfully.");
    } catch (error) {
        console.error("Error occurred during cleanup:", error);
    }
}); */