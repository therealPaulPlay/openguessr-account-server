const { getDB } = require("./dbConnection.js");

// Update or increment profile values
async function updateProfileData(userId, column, increment = false, newValue) {
    try {
        if (!userId || !column || (!increment && newValue === undefined)) throw new Error("Error in updateProfileData – id, column and value are required.");

        userId = parseInt(userId, 10); // Parse userId to integer
        if (typeof userId != "number") throw new Error("Error in updateProfileData – userId is not a number.");
        if (typeof column != "string") throw new Error("Error in updateProfileData – column is not a string.");

        const db = getDB();

        // Apply validation checks for specific columns/values
        await applyValidationChecks(db, userId, column, newValue);

        let query, params;

        if (increment) {
            // For increment: insert with newValue or update by adding newValue
            query = `
                INSERT INTO profile_data (user_id, ${column}) 
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE ${column} = COALESCE(${column}, 0) + ?
            `;
            params = [userId, newValue, newValue];
        } else {
            // For regular update: insert or update with newValue
            query = `
                INSERT INTO profile_data (user_id, ${column}) 
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE ${column} = ?
            `;
            params = [userId, newValue, newValue];
        }

        await db.promise().execute(query, params);
        return { success: true };

    } catch (error) {
        console.error("Error occurred in updateProfileData:", error.message);
        return { success: false, error };
    }
}

// Validation function for specific business rules
async function applyValidationChecks(db, userId, column, newValue) {
    // Check supporter-related items
    if ((column === 'badge' && newValue && newValue.includes("supporter")) ||
        (column === 'pin' && newValue == "11")) {

        const getSupporterLevel = 'SELECT supporter_level FROM users WHERE id = ?';
        const result = await db.promise().execute(getSupporterLevel, [userId]);
        if (!result[0] || !result[0][0] || result[0][0].supporter_level == 0) throw new Error('You need to be a supporter to equip these items.');
    }

    // Check developer badge
    if (column === 'badge' && newValue === "miscBadge1") if (userId > 5) throw new Error('You need to be a developer to equip these items.');

    // Check About length
    if (column === 'about' && newValue?.length > 3000) throw new Error('About section is too long!');
}

module.exports = { updateProfileData };