const express = require('express');
const shopRouter = express.Router();
const { standardLimiter } = require("./rateLimiters.js");
const { getDB } = require("./dbConnection.js");
const cron = require('node-cron');
const { updateProfileData } = require('./profileDataHelper.js');
const { authenticateTokenWithId } = require('./authUtils.js');

// Pins are referenced by their id with the first digit being the rarity – e.g. 100 is the first common pin, 202 is the third rare pin
const pins = {
    1: {
        name: "common",
        amount: 10,
        price: 250,
    },
    2: {
        name: "rare",
        amount: 8,
        price: 500,
    },
    3: {
        name: "epic",
        amount: 8,
        price: 750,
    },
    4: {
        name: "legendary",
        amount: 6,
        price: 1000,
    },
};

let dailyPinBundle;

function createPinBundle() {
    const rarity = 1 + Math.floor(Math.random() * 4);
    const rarityName = pins[rarity]?.name;
    const pinAmount = pins[rarity]?.amount;
    const pinPrice = pins[rarity]?.price;
    if (!rarityName) return console.error("Invalid rarity with index: " + rarity);

    let bundlePins = [];

    for (let i = 0; i < 4; i++) {
        if (pinAmount < 4) return console.error("Can't create bundle: Pin amount is too small!");
        let randomPinIndex;
        do {
            const randomIndex = Math.floor(Math.random() * pinAmount);
            randomPinIndex = randomIndex + 100 * rarity;
        } while (bundlePins.includes(randomPinIndex));
        bundlePins.push(randomPinIndex);
    }

    dailyPinBundle = {
        rarity: rarityName,
        pins: bundlePins,
        price: 3 * pinPrice
    }
}

// Create initial bundle
createPinBundle();

// Buy a pin
shopRouter.post('/purchase-pin', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: userId, pinId: rawPinId } = req.body;

    if (!userId || !rawPinId) return res.status(400).json({ error: 'User ID and pin ID are required.' });

    try {
        const db = getDB();

        const pinId = parseInt(rawPinId);
        if (isNaN(rawPinId)) return res.status(400).json({ error: 'Pin ID must be a number.' });

        // Get pin rarity from first digit
        const rarity = Math.floor(pinId / 100);
        const pinPrice = pins[rarity]?.price;

        if (!pinPrice) return res.status(400).json({ error: 'Invalid pin ID.' });

        // Get user's tokens and purchased pins
        const [userRows] = await db.promise().execute(
            'SELECT u.tokens, p.purchased_pins FROM users u LEFT JOIN profile_data p ON u.id = p.user_id WHERE u.id = ?',
            [userId]
        );

        if (userRows.length === 0) return res.status(404).json({ error: 'User not found.' });

        const user = userRows[0];
        const userTokens = user.tokens || 0;
        let purchasedPins = user.purchased_pins || [];

        // Check if user already owns the pin
        if (purchasedPins.includes(pinId)) return res.status(400).json({ error: 'Pin already purchased.' });

        // Check if user has enough tokens
        if (userTokens < pinPrice) return res.status(400).json({ error: 'Insufficient tokens.' });

        // Add pin to purchased pins array
        purchasedPins.push(pinId);

        // Update user tokens
        await db.promise().execute(
            'UPDATE users SET tokens = tokens - ? WHERE id = ?',
            [pinPrice, userId]
        );

        // Update purchased pins
        const result = await updateProfileData(userId, 'purchased_pins', false, JSON.stringify(purchasedPins));
        if (!result.success) return res.status(500).json({ error: 'Failed to update purchased pins.' });

        res.json({ message: 'Pin purchased successfully.' });

    } catch (error) {
        console.error('Error purchasing pin:', error);
        res.status(500).json({ error: 'An error occurred while purchasing the pin.' });
    }
});

// Get daily bundle, add ?user-id to get the adjusted-for-user version
shopRouter.get('/bundle', async (req, res) => {
    const userId = req.query['user-id'];
    if (!dailyPinBundle) return res.status(500).json({ error: 'No bundle available.' });

    try {
        let adjustedPrice = dailyPinBundle.price;

        if (userId) {
            const db = getDB();
            const [userRows] = await db.promise().execute(
                'SELECT purchased_pins FROM profile_data WHERE user_id = ?',
                [userId]
            );

            if (userRows.length && userRows[0].purchased_pins) {
                const purchasedPins = userRows[0].purchased_pins;
                const ownedPinsInBundle = dailyPinBundle.pins.filter(pin => purchasedPins.includes(pin));

                // Get rarity from bundle to calculate individual pin price
                const rarity = Math.floor(dailyPinBundle.pins[0] / 100);
                const individualPinPrice = pins[rarity]?.price || 0;
                const discountedPinPrice = individualPinPrice * 0.75;

                adjustedPrice = Math.floor(dailyPinBundle.price - (ownedPinsInBundle.length * discountedPinPrice));
            }
        }

        res.json({
            ...dailyPinBundle,
            price: Math.max(0, adjustedPrice) // Ensure price doesn't go below 0
        });

    } catch (error) {
        console.error('Error fetching bundle:', error);
        res.status(500).json({ error: 'An error occurred while fetching the bundle.' });
    }
});

// Purchase bundle
shopRouter.post('/purchase-bundle', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: userId, bundleItems } = req.body;

    if (!userId) return res.status(400).json({ error: 'User ID is required.' });
    if (!dailyPinBundle) return res.status(500).json({ error: 'No bundle available.' });

    try {
        const db = getDB();

        if (JSON.stringify(dailyPinBundle.pins) != JSON.stringify(bundleItems)) return res.status(400).json({ error: 'This bundle is no longer available – please refresh your client.' });

        // Get user's tokens and purchased pins
        const [userRows] = await db.promise().execute(
            'SELECT u.tokens, p.purchased_pins FROM users u LEFT JOIN profile_data p ON u.id = p.user_id WHERE u.id = ?',
            [userId]
        );
        if (userRows.length === 0) return res.status(404).json({ error: 'User not found.' });

        const user = userRows[0];
        const userTokens = user.tokens || 0;
        let purchasedPins = user.purchased_pins || [];

        // Calculate adjusted price and pins to purchase
        const ownedPinsInBundle = dailyPinBundle.pins.filter(pin => purchasedPins.includes(pin));
        const pinsToAdd = dailyPinBundle.pins.filter(pin => !purchasedPins.includes(pin));
        if (pinsToAdd.length === 0) return res.status(400).json({ error: 'All pins in bundle already owned.' });

        const rarity = Math.floor(dailyPinBundle.pins[0] / 100);
        const individualPinPrice = pins[rarity]?.price || 0;
        const discountedPinPrice = individualPinPrice * 0.75;
        const adjustedPrice = Math.floor(dailyPinBundle.price - (ownedPinsInBundle.length * discountedPinPrice));

        // Check if user has enough tokens
        if (userTokens < adjustedPrice) return res.status(400).json({ error: 'Insufficient tokens.' });

        // Add new pins to purchased pins array
        const updatedPurchasedPins = [...purchasedPins, ...pinsToAdd];

        // Update user tokens
        await db.promise().execute(
            'UPDATE users SET tokens = tokens - ? WHERE id = ?',
            [adjustedPrice, userId]
        );

        // Update purchased pins
        const result = await updateProfileData(userId, 'purchased_pins', false, JSON.stringify(updatedPurchasedPins));
        if (!result.success) return res.status(500).json({ error: 'Failed to update purchased pins.' });

        res.json({
            message: 'Bundle purchased successfully.',
            pinsAdded: pinsToAdd
        });

    } catch (error) {
        console.error('Error purchasing bundle:', error);
        res.status(500).json({ error: 'An error occurred while purchasing the bundle.' });
    }
});

// Claim free tokens
shopRouter.post('/claim-free-tokens', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: userId } = req.body;

    if (!userId) return res.status(400).json({ error: 'User ID is required.' });

    try {
        const db = getDB();

        // Check if user has already claimed free tokens today
        const [profileRows] = await db.promise().execute(
            'SELECT free_tokens_claimed FROM profile_data WHERE user_id = ?',
            [userId]
        );

        const alreadyClaimed = profileRows.length > 0 && profileRows[0].free_tokens_claimed === 1;
        if (alreadyClaimed) return res.status(400).json({ error: 'Free tokens already claimed today.' });

        // Add tokens to user
        await db.promise().execute(
            'UPDATE users SET tokens = COALESCE(tokens, 0) + 20 WHERE id = ?',
            [userId]
        );

        // Set free_tokens_claimed to 1
        const result = await updateProfileData(userId, 'free_tokens_claimed', false, 1);
        if (!result.success) return res.status(500).json({ error: 'Failed to update claim status.' });

        res.json({ message: 'Free tokens claimed successfully.', count: 20 });

    } catch (error) {
        console.error('Error claiming free tokens:', error);
        res.status(500).json({ error: 'An error occurred while claiming free tokens.' });
    }
});

// Claim free YouTube pin
shopRouter.post('/claim-youtube-pin', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: userId } = req.body;
    if (!userId) return res.status(400).json({ error: 'User ID is required.' });

    const pinId = 500; // Id of the YouTube pin

    try {
        const db = getDB();

        // Get user's tokens and purchased pins
        const [userRows] = await db.promise().execute(
            'SELECT purchased_pins FROM profile_data WHERE id = ?',
            [userId]
        );
        if (userRows.length === 0) return res.status(404).json({ error: 'User not found.' });

        const user = userRows[0];
        let purchasedPins = user.purchased_pins || [];
        if (purchasedPins.includes(pinId)) return res.status(400).json({ error: 'Pin already claimed.' }); // Check if user already owns the pin

        // Add pin to purchased pins array
        purchasedPins.push(pinId);

        // Update purchased pins
        const result = await updateProfileData(userId, 'purchased_pins', false, JSON.stringify(purchasedPins));
        if (!result.success) return res.status(500).json({ error: 'Failed to update purchased pins.' });

        res.json({ message: 'Pin claimed successfully.', pinId });

    } catch (error) {
        console.error('Error claiming pin:', error);
        res.status(500).json({ error: 'An error occurred while claiming a pin.' });
    }
});

// Create new bundle every day at 00:00
cron.schedule('0 0 * * *', async () => {
    console.log("Creating new pin bundle...");
    createPinBundle();

    // Reset free tokens claimed status
    try {
        const db = getDB();
        await db.promise().execute(
            'UPDATE profile_data SET free_tokens_claimed = NULL WHERE free_tokens_claimed = 1'
        );
        console.log("Reset free tokens claimed status for all users.");
    } catch (error) {
        console.error("Error resetting free tokens claimed status:", error);
    }
});

module.exports = shopRouter;
