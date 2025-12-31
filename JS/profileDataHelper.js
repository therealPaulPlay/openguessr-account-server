import { getDB } from "./dbConnection.js";

// Update or increment profile values (creates entry if none existant, otherwise updates)
async function updateProfileData(userId, column, increment = false, value) {
    try {
        if (!userId || !column || (!increment && value === undefined)) throw new Error("Error in updateProfileData – id, column and value are required.");

        userId = parseInt(userId, 10); // Parse userId to integer
        if (typeof userId != "number") throw new Error("Error in updateProfileData – userId is not a number.");
        if (typeof column != "string") throw new Error("Error in updateProfileData – column is not a string.");

        const db = getDB();

        // Apply validation checks for specific columns/values
        value = await applyValidationChecks(db, userId, column, value);

        let query, params;

        if (increment) {
            // For increment: insert with value or update by adding value
            query = `
                INSERT INTO profile_data (user_id, ${column}) 
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE ${column} = COALESCE(${column}, 0) + ?
            `;
            params = [userId, value, value];
        } else {
            // For regular update: insert or update with value
            query = `
                INSERT INTO profile_data (user_id, ${column}) 
                VALUES (?, ?)
                ON DUPLICATE KEY UPDATE ${column} = ?
            `;
            params = [userId, value, value];
        }

        await db.promise().execute(query, params);
        return { success: true };

    } catch (error) {
        console.error("Error occurred in updateProfileData:", error.message);
        return { success: false, error };
    }
}

// Validation function for specific business rules
async function applyValidationChecks(db, userId, column, value) {
    // Check supporter-related items
    if ((column === 'badge' && value && value.includes("supporter")) ||
        (column === 'pin' && value == "11")) {
        const getSupporterLevel = 'SELECT supporter_level FROM users WHERE id = ?';
        const result = await db.promise().execute(getSupporterLevel, [userId]);
        if (!result[0] || !result[0][0] || result[0][0].supporter_level == 0) throw new Error('You need to be a supporter to equip these items.');
    }

    // Check developer badge
    if (column === 'badge' && value === "miscBadge1") if (userId > 5) throw new Error('You need to be a developer to equip these items.');

    // Check about length
    if (column === 'about') {
        value = value?.trim() || "";
        if (value?.length > 3000) throw new Error('About section is too long!');
    }

    // Check if user owns the pin they're trying to set
    if (column === 'pin' && Number(value) >= 100) {
        const [rows] = await db.promise().execute(
            'SELECT purchased_pins FROM profile_data WHERE user_id = ?',
            [userId]
        );
        const purchasedPins = rows[0]?.purchased_pins;
        if (!purchasedPins || !purchasedPins.includes(Number(value))) throw new Error('You do not own this pin.');
    }

    return value;
}

export { updateProfileData };