const express = require('express');
const profileRouter = express.Router();
const  { standardLimiter } = require("./rateLimiters.js");
const { authenticateTokenWithId } = require("./authUtils.js");
const { getDB } = require("./dbConnection.js");

// Update Profile data
profileRouter.put('/update', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { id, profileData } = req.body;

    if (!id || !profileData) {
        return res.status(400).json({ error: 'User ID and profile data are required.' });
    }

    // Check if profileData is not greater than 3000 characters
    if (profileData.length > 3000) {
        return res.status(400).json({ error: 'Profile data must not exceed 3000 characters.' });
    }

    // Validate that profileData is JSON-formatted
    let parsedProfileData;

    try {
        parsedProfileData = JSON.parse(profileData);
    } catch (err) {
        return res.status(400).json({ error: 'Profile data must be JSON-formatted.' });
    }

    try {
        if ((parsedProfileData.badge && parsedProfileData.badge.includes("supporter")) || (parsedProfileData.pin && parsedProfileData.pin == "11")) {
            // Check if badge and pin align with supporter value
            const getSupporterLevel = 'SELECT supporter_level FROM users WHERE id = ?';
            const supporterLevel = await new Promise((resolve, reject) => {
                db.query(getSupporterLevel, [id], (err, results) => {
                    if (err) return reject(err);
                    resolve(results[0]);
                });
            });

            if (supporterLevel.supporter_level == 0) {
                return res.status(400).json({ error: 'You need to be a supporter to equip these items.' });
            }
        }

        if (parsedProfileData.badge && parsedProfileData.badge == "miscBadge1") {
            if (id > 5) {
                return res.status(400).json({ error: 'You need to be a developer to equip these items.' });
            }
        }
    } catch (error) {
        console.error("Error verifying profile data request: ", error);
        return res.status(400).json({ error: 'Profile data verification checks failed.' });
    }

    try {
        // Update query to change the profileData
        let updateQuery = `
            UPDATE users
            SET profile_data = ?
            WHERE id = ?
        `;

        await new Promise((resolve, reject) => {
            db.query(updateQuery, [profileData, id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        res.json({ message: 'Profile data updated successfully.' }); // with no assigned status, express assumes 200 OK
    } catch (error) {
        console.error('Error updating profile data:', error);
        res.status(500).json({ error: 'An error occurred while updating the profile data' });
    }
});

profileRouter.get('/:id', standardLimiter, async (req, res) => {
    const db = getDB();
    const { id } = req.params;

    if (!id) {
        return res.status(400).json({ error: 'User ID is required.' });
    }

    try {
        // Query to get the user data for the given user ID
        const userQuery = 'SELECT user_name, experience, elo, profile_data, created_at, supporter_level, supported_amount FROM users WHERE id = ?';
        const userProfile = await new Promise((resolve, reject) => {
            db.query(userQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (!userProfile) {
            return res.status(404).json({ error: 'No profile found for the given ID.' });
        }

        // Construct the response object
        const response = {
            username: userProfile.user_name,
            experience: userProfile.experience,
            joinedDate: userProfile.created_at,
            supporterLevel: userProfile.supporter_level,
            supportedAmount: userProfile.supported_amount,
            elo: userProfile.elo,
            profileData: userProfile.profile_data
        };

        res.json(response);
    } catch (error) {
        console.error('Error fetching profile data:', error);
        res.status(500).json({ error: 'An error occurred while fetching the profile data.' });
    }
});

module.exports = profileRouter;