const express = require('express');
const accountRouter = express.Router();
const jwt = require('jsonwebtoken');
const { standardLimiter, registerLimiter, loginLimiter } = require("./rateLimiters.js");
const { getEncodedPassword, isPasswordValid, authenticateTokenWithId, createNewJwtToken } = require("./authUtils.js");
const { getDB } = require("./dbConnection.js");
const axios = require('axios');
const RESET_KEY = require("./config.js").jwtResetSecret;
const mailTransporter = require("./mailer.js");
const validateCaptcha = require('./captchaMiddleware');
const { reportSecret, reportAppId, emailConfig } = require('./config.js');

// Regular expression to allow alphanumeric characters, emojis, spaces, and standard symbols
const validUsernameRegex = /^[\w!@#\$%\^&\*\(\)\-\+=\[\]\{\};:',<>\.\?\/\|~`\s\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2300}-\u{23FF}\u{20D0}-\u{20FF}\u{2B50}\u{2B55}]+$/u;

// Fetch User Details (bearer protected, this is for the user itself, not for others - use profile for others) ------------------------------------------------------------------------------
accountRouter.get('/user/:id', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();

    try {
        const userId = req.params.id || 0;

        // Query to fetch user details
        let userQuery = `
            SELECT user_name AS userName, experience, profile_data, supporter_level, supported_amount, new_requests, elo
            FROM users
            WHERE id = ?
        `;

        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [userId], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        const now = new Date();

        // Update user experience and last experience update time in the database
        const activityQuery = `
                UPDATE users 
                SET last_activity = ?
                WHERE id = ?
            `;
        await new Promise((resolve, reject) => {
            db.execute(activityQuery, [now, userId], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        if (user) {
            res.json({ user });
        } else {
            res.status(404).json({ error: 'User not found.' });
        }
    } catch (error) {
        console.error('Error fetching user details:', error);
        res.status(500).json({ error: 'An error occurred while fetching user details.' });
    }
});

async function fetchReportData(table = "blacklist", type, referenceId) {
    const response = await axios.put("https://api.openreport.dev/report/get-entry", {
        appId: reportAppId,
        table: table,
        type,
        secret: reportSecret,
        referenceId
    });

    if (response.data && response.data.entry) {
        return { listed: true, entry: response.data.entry };
    } else {
        return { listed: false };
    }
}

// Get user blacklist status
accountRouter.get('/check-blacklist/:id', standardLimiter, async (req, res) => {
    try {
        const referenceId = `user-${req.params?.id}`; // Prepend "user-" to the provided id
        const type = 'user';
        const jsonResponse = await fetchReportData("blacklist", type, referenceId);

        res.json(jsonResponse)
    } catch (error) {
        console.error('Error fetching blacklist entry:', error.message);
        res.status(500).json({ error: 'An error occurred while checking the blacklist.' });
    }
});

// Get user warnlist status
accountRouter.get('/check-warnlist/:id', standardLimiter, async (req, res) => {
    try {
        const referenceId = `user-${req.params?.id}`; // Prepend "user-" to the provided id
        const type = 'user';
        const jsonResponse = await fetchReportData("warnlist", type, referenceId);

        res.json(jsonResponse)
    } catch (error) {
        console.error('Error fetching blacklist entry:', error.message);
        res.status(500).json({ error: 'An error occurred while checking the blacklist.' });
    }
});

// Update Username -------------------------------------------------------------------------------------------------------------------------------------
accountRouter.put('/update/username', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { id } = req.body;
    let { userName } = req.body;

    if (!id || !userName) {
        return res.status(400).json({ error: 'User ID and username are required.' });
    }

    try {
        // Check if the username consists only of spaces
        userName = userName.trim();

        if (!validUsernameRegex.test(userName) || userName.length === 0) {
            return res.status(400).json({ error: 'Invalid username. Please avoid using unsupported characters or empty spaces.' });
        }

        // Check if username already exists
        const userNameExistsQuery = 'SELECT id FROM users WHERE user_name = ?';
        const existingUserNameUser = await new Promise((resolve, reject) => {
            db.execute(userNameExistsQuery, [userName], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (existingUserNameUser) {
            return res.status(400).json({ error: 'Username is already taken.' });
        }

        // Update query to change the username
        let updateQuery = `
            UPDATE users
            SET user_name = ?
            WHERE id = ?
        `;

        await new Promise((resolve, reject) => {
            db.execute(updateQuery, [userName, id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        // Query to fetch updated user details
        let userQuery = `
            SELECT user_name AS userName
            FROM users
            WHERE id = ?
        `;

        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (user) {
            res.json({ user });
        } else {
            res.status(404).json({ error: 'User not found.' });
        }
    } catch (error) {
        console.error('Error updating username:', error);
        res.status(500).json({ error: 'An error occurred while updating the username.' });
    }
});

// Registration and Login ---------------------------------------------------------------------------------------------------------

// Register Endpoint
accountRouter.post('/register', registerLimiter, validateCaptcha, async (req, res) => {
    const db = getDB();
    let { userName, email, password } = req.body;
    const userIp = req.clientIp;

    if (!userName || !email || !password) {
        return res.status(400).json({ error: 'Username, email, and password are required.' });
    }

    try {
        userName = userName.trim(); // remove whitespaces from username
        email = email.trim(); // remove whitespaces from email

        // Check if the username consists only of spaces
        if (!validUsernameRegex.test(userName) || userName.length === 0) {
            return res.status(400).json({ error: 'Invalid username. Please avoid using unsupported characters or empty spaces.' });
        }

        // Check if email already exists
        const emailExistsQuery = 'SELECT id FROM users WHERE email = ?';
        const existingEmailUser = await new Promise((resolve, reject) => {
            db.execute(emailExistsQuery, [email], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (existingEmailUser) {
            return res.status(409).json({ error: 'Email is already in use.' });
        }

        // Check if username already exists
        const userNameExistsQuery = 'SELECT id FROM users WHERE user_name = ?';
        const existingUserNameUser = await new Promise((resolve, reject) => {
            db.execute(userNameExistsQuery, [userName], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (existingUserNameUser) {
            return res.status(409).json({ error: 'Username is already taken.' });
        }

        // Generate hashed password
        const hashedPassword = await getEncodedPassword(password);

        // Get current timestamp
        const now = new Date();

        // Insert new user into the database
        const insertUserQuery = 'INSERT INTO users (user_name, email, password, ip_address, created_at) VALUES (?, ?, ?, ?, ?)';
        const newUser = await new Promise((resolve, reject) => {
            db.execute(insertUserQuery, [userName, email, hashedPassword, userIp, now], (err, results) => {
                if (err) return reject(err);
                resolve(results.insertId);
            });
        });

        res.status(201).json({ message: 'Registration successful.' });
    } catch (error) {
        console.error('Error during registration:', error);
        res.status(500).json({ error: 'An error occurred during registration.' });
    }
});

// Login Endpoint
accountRouter.post('/login', loginLimiter, async (req, res) => {
    const db = getDB();
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required.' });
    }

    try {
        // Find user by email
        const userQuery = 'SELECT id, user_name, password, experience FROM users WHERE email = ?';
        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [email], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials.' });
        }

        // Check password
        const isValidPassword = await isPasswordValid(password, user.password);
        if (!isValidPassword) {
            return res.status(400).json({ error: 'Invalid credentials.' });
        }

        // Generate JWT token
        const bearerToken = createNewJwtToken({ email, id: user.id });

        res.json({
            message: 'Login successful',
            token: bearerToken,
            id: user.id,
            userName: user.user_name,
            experience: user.experience
        });

    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ error: 'An error occurred during login.' });
    }
});

// Crazy Games Register and/or Login Endpoint (it checks for active accounts etc.)
accountRouter.post('/cg-authenticate', loginLimiter, async (req, res) => {
    const db = getDB();
    let { crazyGamesToken } = req.body;
    const userIp = req.clientIp;

    if (!crazyGamesToken) return res.status(400).json({ error: 'CrazyGames token is required.' });

    let publicKey;
    let username;
    let crazyGamesUserId;

    // Fetch the public key from CrazyGames
    try {
        const resp = await axios.get("https://sdk.crazygames.com/publicKey.json");
        publicKey = resp.data["publicKey"];
        if (!publicKey) return res.status(400).json({ error: "Public key is empty" });
    } catch (e) {
        console.error("Failed to fetch CrazyGames public key", e);
        return res.status(400).json({ error: "Failed to fetch CrazyGames public key" });
    }

    // Verify the token
    try {
        const payload = jwt.verify(crazyGamesToken, publicKey, { algorithms: ["RS256"] });

        // Extract username and userId from the payload
        username = payload.username;
        crazyGamesUserId = payload.userId;
    } catch (e) {
        console.error("Failed to verify token", e);
        return res.status(400).json({ error: "Invalid token" });
    }

    // Now, check if there is an account associated with that crazy games id
    try {
        const userExistsQuery = 'SELECT id FROM users WHERE crazy_games_id = ?';
        const existingUser = await new Promise((resolve, reject) => {
            db.execute(userExistsQuery, [crazyGamesUserId], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        let userId;

        // If user already exists, just use their ID
        if (existingUser) {
            userId = existingUser.id;
        } else {
            // If no account exists, create one (register via CrazyGames ID)

            // Check if username already exists
            const userNameExistsQuery = 'SELECT id FROM users WHERE user_name = ?';
            const existingUserNameUser = await new Promise((resolve, reject) => {
                db.execute(userNameExistsQuery, [username], (err, results) => {
                    if (err) return reject(err);
                    resolve(results[0]);
                });
            });

            if (existingUserNameUser) {
                // Generate a unique username by appending "_CG" and 4 random alphanumeric characters
                const generateRandomSuffix = () => {
                    return Math.random().toString(36).substring(2, 6).toUpperCase(); // Generate 4 random letters/numbers
                };

                let newUsername = `${username}_CG${generateRandomSuffix()}`;
                username = newUsername; // Update the username to the unique value

                // Check again
                const duplicateCheck = await new Promise((resolve, reject) => {
                    db.execute(userNameExistsQuery, [username], (err, results) => {
                        if (err) return reject(err);
                        resolve(results[0]);
                    });
                });

                if (duplicateCheck) {
                    return res.status(400).json({ error: "The user name already exists and the generated fallback does too." });
                }
            }

            // Get current timestamp
            const now = new Date();

            // Insert new user into the database
            const insertUserQuery = 'INSERT INTO users (user_name, ip_address, created_at, crazy_games_id) VALUES (?, ?, ?, ?)';
            await new Promise((resolve, reject) => {
                db.execute(insertUserQuery, [username, userIp, now, crazyGamesUserId], (err, results) => {
                    if (err) return reject(err);
                    resolve(results.insertId);
                });
            });

            // Find user by crazy games user id (confirm that signup worked, and get id)
            const userQuery = 'SELECT id FROM users WHERE crazy_games_id = ?';
            const user = await new Promise((resolve, reject) => {
                db.execute(userQuery, [crazyGamesUserId], (err, results) => {
                    if (err) return reject(err);
                    resolve(results[0]);
                });
            });

            if (!user) {
                return res.status(400).json({ error: 'User not found. Registration via CrazyGames id went wrong.' });
            }

            userId = user.id;
        }

        // Generate JWT token
        const bearerToken = createNewJwtToken({ id: userId });

        return res.json({
            message: 'Login successful',
            token: bearerToken,
            id: userId
        });

    } catch (error) {
        console.error('Error during crazygames authentication:', error);
        return res.status(500).json({ error: 'An unexpected error occurred during crazygames authentication.' });
    }
});

// Delete Account Endpoint ---------------------------------------------------------------------------------------------------------------------------
accountRouter.delete('/delete', loginLimiter, async (req, res) => {
    const db = getDB();
    const { id, password } = req.body;

    if (!id || !password) {
        return res.status(400).json({ error: 'Id and password are required.' });
    }

    try {
        // Find user by email to retrieve password hash
        const userQuery = 'SELECT password FROM users WHERE id = ?';
        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (!user) {
            return res.status(400).json({ error: 'Invalid credentials. User not found.' });
        }

        // Check password
        const isValidPassword = await isPasswordValid(password, user.password);
        if (!isValidPassword) {
            return res.status(400).json({ error: 'Invalid credentials.' });
        }

        // Delete user account
        const deleteUserQuery = 'DELETE FROM users WHERE id = ?';
        await new Promise((resolve, reject) => {
            db.execute(deleteUserQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        res.json({ message: 'Account deleted successfully.' });
    } catch (error) {
        console.error('Error during account deletion:', error);
        res.status(500).json({ error: 'An error occurred during account deletion.' });
    }
});

// Password resets via email -----------------------------------------------------------------------------

// request password reset email endpoint
accountRouter.post('/reset-password-request', registerLimiter, async (req, res) => {
    const db = getDB();
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ error: 'Email is required.' });
    }

    try {
        // Find user by email
        const userQuery = 'SELECT id, user_name FROM users WHERE email = ?';
        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [email], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (!user) {
            return res.status(404).json({ error: 'No account with that email found.' });
        }

        // Create a password reset token
        const resetToken = jwt.sign({ email: email, id: user.id }, RESET_KEY, { expiresIn: '1h' });

        // Send email with the reset token
        const resetUrl = `https://openguessr.com/signup?token=${resetToken}`;
        const mailOptions = {
            from: emailConfig.auth.user,
            to: email,
            subject: 'OpenGuessr Password Reset',
            text: `Hey ${user.user_name},

Please click on this link to reset your password: ${resetUrl}

If you have not requested a password reset, simply ignore this email.`
        };

        await mailTransporter.sendMail(mailOptions);

        res.json({ message: 'Password reset email sent.' });
    } catch (error) {
        console.error('Error during password reset request:', error);
        res.status(500).json({ error: 'An error occurred during password reset request.' });
    }
});

// reset endpoint
accountRouter.post('/reset-password', loginLimiter, async (req, res) => {
    const db = getDB();
    const { token, newPassword } = req.body;

    if (!token || !newPassword) {
        return res.status(400).json({ error: 'Token and new password are required.' });
    }

    try {
        // Verify the reset token + get user Id from the token so that the correct account's password can be changed
        const decoded = jwt.verify(token, RESET_KEY);

        // Hash the new password
        const hashedPassword = await getEncodedPassword(newPassword);

        // Update the user's password in the database
        const updatePasswordQuery = 'UPDATE users SET password = ? WHERE id = ?';
        await new Promise((resolve, reject) => {
            db.execute(updatePasswordQuery, [hashedPassword, decoded.id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        res.json({ message: 'Password reset successfully.' });
    } catch (error) {
        console.error('Error during password reset:', error);
        res.status(500).json({ error: 'An error occurred during password reset.' });
    }
});

// Experience Update Endpoint -------------------------------------------------------------------------------------------------------------------------
accountRouter.put('/update/experience', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { id, experience } = req.body;

    if (!id || experience === undefined) {
        return res.status(400).json({ error: 'User ID and experience are required.' });
    }

    if (experience < 0) {
        return res.status(400).json({ error: 'Experience cannot be negative.' });
    }

    try {
        // Fetch current experience and last update time from the database
        const userQuery = 'SELECT experience, last_experience_update FROM users WHERE id = ?';
        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (!user) {
            return res.status(404).json({ error: 'User not found.' });
        }

        const { experience: currentExperience, last_experience_update } = user;
        const experienceDifference = Math.abs(experience - currentExperience);

        if (experienceDifference > 10000) {
            return res.status(400).json({ error: 'Experience difference is too large.' });
        }

        // Determine rate limit based on experience difference
        let rateLimitTimeout;
        rateLimitTimeout = (experienceDifference / 10000) * 6 * 1000 + 100; // 6s rate limiting for 10,000 XP difference, 3s for 5,000 and so on

        // Check if user is allowed to make the request based on rate limiting
        const now = new Date();
        const lastUpdate = last_experience_update ? new Date(last_experience_update) : null;

        let timeElapsed = 0;

        if (lastUpdate) {
            timeElapsed = now - lastUpdate;
        } else {
            // Assume a large enough timeElapsed if last_experience_update is NULL
            timeElapsed = rateLimitTimeout + 1; // Ensure the rate limit is bypassed
        }

        if (timeElapsed < rateLimitTimeout) {
            return res.status(429).json({ error: `Rate limit exceeded. Try again in ${Math.ceil((rateLimitTimeout - timeElapsed) / 1000)} seconds.` });
        }

        // Update user experience and last experience update time in the database
        const updateQuery = `
            UPDATE users 
            SET experience = ?, last_experience_update = ?, last_activity = ?
            WHERE id = ?
        `;
        await new Promise((resolve, reject) => {
            db.execute(updateQuery, [experience, now, now, id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        // Fetch updated user details
        const updatedUserQuery = 'SELECT experience AS experience FROM users WHERE id = ?';
        const updatedUser = await new Promise((resolve, reject) => {
            db.execute(updatedUserQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        res.json({ user: updatedUser });
    } catch (error) {
        console.error('Error updating experience:', error);
        res.status(500).json({ error: 'An error occurred while updating the experience.' });
    }
});

module.exports = accountRouter;