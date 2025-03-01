const express = require('express');
const autoguessrRouter = express.Router();
const { standardLimiter } = require('./rateLimiters.js');
const { authenticateTokenWithId } = require('./authUtils.js');
const { getDB } = require('./dbConnection.js');
// This router is used for AutoGuessr game saves. Autoguessr is a separate game, but part of the OpenGuessr system.

// Save a new JSON for a given user
autoguessrRouter.post('/save', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id, save } = req.body;
    if (!id || !save) return res.status(400).json({ error: 'User ID and save data are required.' });

    const db = getDB();

    // Convert the save object to a JSON string and validate its size
    let saveString;
    try {
        saveString = JSON.stringify(save);
    } catch (err) {
        return res.status(400).json({ error: 'Save data must be JSON-formatted.' });
    }

    if (saveString?.length > 3000) {
        return res.status(400).json({ error: 'Save data must not exceed 3000 characters.' });
    }

    try {
        // First, try updating an existing save for the user
        const updateQuery = 'UPDATE autoguessr_saves SET main_save = ? WHERE user_id = ?';
        const updateResult = await new Promise((resolve, reject) => {
            db.execute(updateQuery, [saveString, id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        // If no row was updated, insert a new record
        if (updateResult.affectedRows === 0) {
            const insertQuery = 'INSERT INTO autoguessr_saves (user_id, main_save) VALUES (?, ?)';
            await new Promise((resolve, reject) => {
                db.execute(insertQuery, [id, saveString], (err, results) => {
                    if (err) return reject(err);
                    resolve(results);
                });
            });
        }

        res.json({ message: 'Save data updated successfully.' });
    } catch (error) {
        console.error('Error saving autoguessr data:', error);
        res.status(500).json({ error: 'An error occurred while saving the data.' });
    }
});

// Retrieve the saved JSON for a given user ID (not save ID!)
autoguessrRouter.get('/get-save/:id', standardLimiter, async (req, res) => {
    const db = getDB();
    const { id } = req.params;

    if (!id) return res.status(400).json({ error: 'User ID is required.' });

    try {
        const query = 'SELECT main_save FROM autoguessr_saves WHERE user_id = ?';
        const results = await new Promise((resolve, reject) => {
            db.execute(query, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        // If no record is found, return an empty object
        if (results.length === 0 || !results[0].main_save) {
            return res.json({});
        }

        // Return the parsed JSON object (mysql2 package auto-parses this)
        let savedData = results[0].main_save;
        res.json(savedData);
    } catch (error) {
        console.error('Error fetching autoguessr save:', error);
        res.status(500).json({ error: 'An error occurred while fetching the save data.' });
    }
});

module.exports = autoguessrRouter;