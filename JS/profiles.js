import express from 'express';
import { standardLimiter } from "./rateLimiters.js";
import { authenticateTokenWithId } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import { updateProfileData } from "./dbWriteHelpers.js";

const profileRouter = express.Router();

// Update individual profile data fields
profileRouter.put('/update-replace', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id, type, value } = req.body;
    if (!id || !type || value === undefined) return res.status(400).json({ error: 'User ID, column, and value are required.' });

    // Define allowed columns for this endpoint
    const allowedColumns = ['flag', 'badge', 'pin', 'about', 'highest_country_streak'];

    if (!allowedColumns.includes(type)) {
        return res.status(400).json({
            error: `Invalid column: ${type}. Allowed columns: ${allowedColumns.join(', ')}`
        });
    }

    try {
        // Update the field using the updateProfileData function
        const result = await updateProfileData(id, type, false, value);
        if (!result.success) return res.status(500).json({ error: 'Failed to update profile data: ' + result?.error });

        res.json({ message: 'Profile data updated successfully.' });

    } catch (error) {
        console.error('Error updating profile data:', error);
        res.status(500).json({ error: 'An error occurred while updating the profile data.' });
    }
});

profileRouter.get('/:id', standardLimiter, async (req, res) => {
    const db = getDB();
    const { id } = req.params;
    const requestorId = req.query.id; // Optional query parameter

    if (!id) return res.status(400).json({ error: 'User ID is required.' });

    try {
        // Query with LEFT JOIN to get user data and profile_data
        const userQuery = `
            SELECT
                u.user_name,
                u.experience,
                u.elo,
                u.created_at,
                u.supporter_level,
                u.supported_amount,
                p.flag,
                p.pin,
                p.badge,
                p.about,
                p.duels_lost,
                p.duels_won,
                p.competitions_entered,
                p.current_duel_win_streak,
                p.highest_country_streak,
                p.highest_elo,
                p.purchased_pins,
                COALESCE((
                    SELECT s.streak FROM daily_competition_streak s
                    WHERE s.user_id = u.id AND s.day_at >= DATE_SUB(UTC_DATE(), INTERVAL 1 DAY)
                    ORDER BY s.day_at DESC LIMIT 1
                ), 0) AS daily_competition_streak
            FROM users u
            LEFT JOIN profile_data p ON u.id = p.user_id
            WHERE u.id = ?
        `;

        const [rows] = await db.promise().execute(userQuery, [id]);
        const userProfile = rows[0];

        if (!userProfile) return res.status(404).json({ error: 'No profile found for the given ID.' });

        // Check friendship status if requestorId is provided
        let areFriends = false;
        if (requestorId) {
            const friendQuery = `
                SELECT 1 FROM friends 
                WHERE user_id = ? AND friend_id = ?
            `;
            const [friendRows] = await db.promise().execute(friendQuery, [requestorId, id]);
            areFriends = friendRows.length > 0;
        }

        // Construct the response object
        const response = {
            username: userProfile.user_name,
            experience: userProfile.experience,
            joinedDate: userProfile.created_at,
            supporterLevel: userProfile.supporter_level,
            supportedAmount: userProfile.supported_amount,
            elo: userProfile.elo,
            flag: userProfile.flag,
            pin: userProfile.pin,
            badge: userProfile.badge,
            about: userProfile.about,
            duelsLost: userProfile.duels_lost,
            duelsWon: userProfile.duels_won,
            competitionsEntered: userProfile.competitions_entered,
            currentDuelWinStreak: userProfile.current_duel_win_streak,
            highestCountryStreak: userProfile.highest_country_streak,
            highestElo: userProfile.highest_elo,
            purchasedPins: userProfile.purchased_pins,
            dailyCompetitionStreak: userProfile.daily_competition_streak
        };

        // Add isFriend only if requestorId was provided
        if (requestorId) response.areFriends = areFriends;

        res.json(response);
    } catch (error) {
        console.error('Error fetching profile data:', error);
        res.status(500).json({ error: 'An error occurred while fetching the profile data.' });
    }
});

export default profileRouter;