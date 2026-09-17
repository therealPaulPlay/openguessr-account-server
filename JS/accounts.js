import express from 'express';
const accountRouter = express.Router();
import jwt from 'jsonwebtoken';
import { standardLimiter, registerLimiter, loginLimiter, nameChangeLimiter, passwordResetLimiter } from "./rateLimiters.js";
import { getEncodedPassword, isPasswordValid, authenticateTokenWithId, createNewJwtToken } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import { jwtResetSecret as RESET_KEY, googleOAuthClientId, googleOAuthClientSecret, y8GamesAppId } from "./config.js";
import mailTransporter from "./mailer.js";
import validateCaptcha from './captchaMiddleware.js';
import { emailConfig, corsOptions } from './config.js';
import { headlessChatServer } from './headlessChatIntegration.js';
import { fetchReportData } from './reportFetch.js';
import { check } from 'fast-profanity-filter';

// Generate random suffix containing numbers and characters
const generateRandomSuffix = (length = 4) => Math.random().toString(36).substring(2, 2 + length).toUpperCase();

// Regular expression to allow alphanumeric characters, emojis, spaces, and standard symbols
const validUsernameRegex = /^[\w!@#\$%\^&\*\(\)\-\+=\[\]\{\};:',<>\.\?\/\|~`\s\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2300}-\u{23FF}\u{20D0}-\u{20FF}\u{2B50}\u{2B55}]+$/u;

// Fetch User Details (bearer protected, this is for the user itself, not for others - use profile for others) ------------------------------------------------------------------------------
accountRouter.get('/user/:id', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    try {
        const userId = req.params.id || 0;
        let userQuery = `
            SELECT 
                u.user_name AS username, 
                u.experience, 
                u.supporter_level, 
                u.supported_amount, 
                EXISTS(SELECT 1 FROM friend_requests fr WHERE fr.recipient_id = u.id AND fr.seen = FALSE) AS new_request,
                u.elo,
                u.tokens,
                p.*
            FROM users u
            LEFT JOIN profile_data p ON u.id = p.user_id
            WHERE u.id = ?
        `;

        const [rows] = await db.promise().execute(userQuery, [userId]);
        const user = rows[0];

        if (user) res.json({ user });
        else res.status(404).json({ error: 'User not found.' });
    } catch (error) {
        console.error('Error fetching user details:', error);
        res.status(500).json({ error: 'An error occurred while fetching user details.' });
    }
});

// Get user warnlist status
accountRouter.put('/check-warnlist', standardLimiter, authenticateTokenWithId, async (req, res) => {
    try {
        const referenceId = `user-${req.body?.id}`; // Prepend "user-" to the provided id
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
    let { username } = req.body;

    if (!id || !username) return res.status(400).json({ error: 'User ID and username are required.' });

    try {
        // Collapse whitespace and trim
        username = username.replace(/\s+/g, ' ').trim();

        if (!validUsernameRegex.test(username) || username.length === 0) return res.status(400).json({ error: 'Invalid username. Please avoid using unsupported characters or empty spaces.' });
        if (username.length > 255) return res.status(400).json({ error: 'Username is too long.' });
        if (!check(username)) return res.status(400).json({ error: 'Username must not contain profanity.' });

        // Reject a no-op rename before the limiter runs, so it doesn't count towards the weekly limit
        const currentNameQuery = 'SELECT user_name FROM users WHERE id = ?';
        const currentUser = await new Promise((resolve, reject) => {
            db.execute(currentNameQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (!currentUser) return res.status(404).json({ error: 'User not found.' });
        if (currentUser.user_name === username) return res.status(400).json({ error: 'This is already your username.' });

        // Check if username already exists, excluding the user's own row so casing-only changes are allowed
        const userNameExistsQuery = 'SELECT id FROM users WHERE user_name = ? AND id != ?';
        const existingUserNameUser = await new Promise((resolve, reject) => {
            db.execute(userNameExistsQuery, [username, id], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (existingUserNameUser) return res.status(400).json({ error: 'Username is already taken.' });

        // Apply rate limiting only after successful validation
        nameChangeLimiter(req, res, async (err) => {
            if (err) return res.status(429).json({ error: 'You can only change your username once per week.' });

            try {
                // Update query to change the username
                let updateQuery = `
                UPDATE users
                SET user_name = ?
                WHERE id = ?
            `;

                await new Promise((resolve, reject) => {
                    db.execute(updateQuery, [username, id], (err, results) => {
                        if (err) return reject(err);
                        resolve(results);
                    });
                });

                // Query to fetch updated user details
                let userQuery = `
                SELECT user_name AS username
                FROM users
                WHERE id = ?
            `;

                const user = await new Promise((resolve, reject) => {
                    db.execute(userQuery, [id], (err, results) => {
                        if (err) return reject(err);
                        resolve(results[0]);
                    });
                });

                if (user) res.json({ user });
                else res.status(404).json({ error: 'User not found.' });
            } catch {
                res.status(500).json({ error: 'An error occurred while updating the username.' });
            }
        });

    } catch (error) {
        console.error('Error updating username:', error);
        res.status(500).json({ error: 'An error occurred while updating the username.' });
    }
});

// Registration and Login ---------------------------------------------------------------------------------------------------------

// Register Endpoint
accountRouter.post('/register', registerLimiter, validateCaptcha, async (req, res) => {
    const db = getDB();
    let { username, email, password } = req.body;
    const userIp = req.clientIp;

    if (!username || !email || !password) return res.status(400).json({ error: 'Username, email, and password are required.' });

    try {
        username = username.replace(/\s+/g, ' ').trim(); // Collapse whitespace and trim
        email = email.trim().toLowerCase(); // Remove whitespaces from email and make it lowercase

        if (!validUsernameRegex.test(username) || username.length === 0) return res.status(400).json({ error: 'Username contains unsupported characters.' });
        if (username.length > 255) return res.status(400).json({ error: 'Username is too long.' });
        if (!check(username)) return res.status(400).json({ error: 'Username should not contain profanity.' });

        // Check if email already exists
        const emailExistsQuery = 'SELECT id FROM users WHERE email = ?';
        const existingEmailUser = await new Promise((resolve, reject) => {
            db.execute(emailExistsQuery, [email], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });

        if (existingEmailUser) return res.status(409).json({ error: 'Email is already in use.' });

        // Check if username already exists
        const userNameExistsQuery = 'SELECT id FROM users WHERE user_name = ?';
        const existingUserNameUser = await new Promise((resolve, reject) => {
            db.execute(userNameExistsQuery, [username], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });
        if (existingUserNameUser) return res.status(409).json({ error: 'Username is already taken.' });

        // Generate hashed password
        const hashedPassword = await getEncodedPassword(password);

        // Get current timestamp
        const now = new Date();

        // Insert new user into the database
        const insertUserQuery = 'INSERT INTO users (user_name, email, password, ip_address, created_at) VALUES (?, ?, ?, ?, ?)';
        const newUser = await new Promise((resolve, reject) => {
            db.execute(insertUserQuery, [username, email, hashedPassword, userIp, now], (err, results) => {
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

    if (!email || !password) return res.status(400).json({ error: 'Email and password are required.' });

    try {
        // Find user by email
        const userQuery = 'SELECT id, password FROM users WHERE email = ?';
        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [email], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });
        if (!user) return res.status(400).json({ error: 'Invalid credentials.' });

        // Check password
        if (!user.password) return res.status(400).json({ error: 'Please use Google or reset your password.' });
        const isValidPassword = await isPasswordValid(password, user.password);
        if (!isValidPassword) return res.status(400).json({ error: 'Invalid credentials.' });

        // Generate JWT token
        const bearerToken = createNewJwtToken({ email, id: user.id });

        res.json({
            token: bearerToken,
            id: user.id
        });

    } catch (error) {
        console.error('Error during login:', error);
        res.status(500).json({ error: 'An error occurred during login.' });
    }
});

// CrazyGames register and/or login endpoint
accountRouter.post('/cg-authenticate', loginLimiter, async (req, res) => {
    const db = getDB();
    const userIp = req.clientIp;
    let crazyGamesToken = req.body.crazyGamesToken;

    if (!crazyGamesToken) return res.status(400).json({ error: 'CrazyGames token is required.' });

    let publicKey;
    let username;
    let crazyGamesUserId;

    // Fetch the public key from CrazyGames
    try {
        const response = await fetch("https://sdk.crazygames.com/publicKey.json");
        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        const data = await response.json();
        publicKey = data["publicKey"];
        if (!publicKey) return res.status(400).json({ error: "Public key is empty" });
    } catch (error) {
        console.error("Failed to fetch CrazyGames public key", error);
        return res.status(400).json({ error: "Failed to fetch CrazyGames public key" });
    }

    // Verify the token
    try {
        const payload = jwt.verify(crazyGamesToken, publicKey, { algorithms: ["RS256"] });

        // Extract username and userId from the payload
        username = payload.username;
        crazyGamesUserId = payload.userId;
    } catch (error) {
        console.error("Failed to verify token", error);
        return res.status(400).json({ error: "Invalid token" });
    }

    let connection;
    try {
        connection = await db.promise().getConnection();

        let userId;
        try {
            userId = await getOrCreatePortalAccount(connection, userIp, username, crazyGamesUserId, "crazy_games_id", "CG");
        } catch (txError) {
            await connection.rollback();
            throw txError;
        }

        const bearerToken = createNewJwtToken({ id: userId });

        return res.json({
            token: bearerToken,
            id: userId
        });
    } catch (error) {
        console.error('Error during CrazyGames authentication:', error);
        return res.status(500).json({ error: 'An unexpected error occurred during CrazyGames authentication.' });
    } finally {
        if (connection) connection.release();
    }
});

// Y8 Games register and/or login endpoint
accountRouter.post('/y8-authenticate', loginLimiter, async (req, res) => {
    const db = getDB();
    const userIp = req.clientIp;
    let y8GamesToken = req.body.y8GamesToken;

    if (!y8GamesToken) return res.status(400).json({ error: 'Y8 access token is required.' });

    // Env var missing guard
    if (!y8GamesAppId) {
        console.error("Y8_GAMES_APP_ID is not configured, cannot verify Y8 tokens");
        return res.status(500).json({ error: 'Y8 Games app ID is not configured.' });
    }

    let username;
    let y8GamesUserId;

    // Verify the access token matches the profile via the Y8 API
    try {
        const response = await fetch("https://account.y8.com/api/profile", { headers: { "Authorization": "Bearer " + y8GamesToken } });

        // 401 means expired and Y8 recommends to refresh and retry on the client in this case
        if (response.status === 401) return res.status(401).json({ error: "Y8 access token is invalid or expired." });

        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        const data = await response.json();

        y8GamesUserId = data.pid;
        username = data.nickname; // Nickname is correct, even though the docs for the verification endpoint show 'name'
        const expectedAppId = data.client_id;

        if (expectedAppId !== y8GamesAppId) throw new Error("App ID does not match, this token is for a different App");
    } catch (error) {
        console.error("Failed to verify Y8 access token", error);
        return res.status(400).json({ error: "Failed to verify Y8 token" });
    }

    let connection;
    try {
        connection = await db.promise().getConnection();

        let userId;
        try {
            userId = await getOrCreatePortalAccount(connection, userIp, username, y8GamesUserId, "y8_games_id", "Y8");
        } catch (txError) {
            await connection.rollback();
            throw txError;
        }

        const bearerToken = createNewJwtToken({ id: userId });

        return res.json({
            token: bearerToken,
            id: userId
        });
    } catch (error) {
        console.error('Error during Y8 Games authentication:', error);
        return res.status(500).json({ error: 'An unexpected error occurred during Y8 Games authentication.' });
    } finally {
        if (connection) connection.release();
    }
});

// Playgama register and/or login endpoint
accountRouter.post('/pg-authenticate', loginLimiter, async (req, res) => {
    const db = getDB();
    const userIp = req.clientIp;
    let playgamaData = req.body.playgamaData;

    if (!playgamaData || typeof playgamaData !== 'object') return res.status(400).json({ error: 'Playgama authorization data is required.' });

    let username;
    let playgamaUserId;

    // Verify the authorization data via the Playgama API is valid
    try {
        const response = await fetch("https://playgama.com/api/bridge/v1/verify", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ platform: "playgama", type: "authorization", data: playgamaData })
        });

        if (!response.ok) throw new Error(`Request failed with status ${response.status}`);
        const data = await response.json();
        if (!data.success || !data.playerId) throw new Error(data.errorMessage || "Verification failed");

        playgamaUserId = String(data.playerId);
    } catch (error) {
        console.error("Failed to verify Playgama authorization data", error);
        return res.status(400).json({ error: "Failed to verify Playgama authorization" });
    }

    // The verify endpoint only returns the ID, the name is client-provided
    if (typeof playgamaData.name === 'string') {
        const name = playgamaData.name.replace(/\s+/g, ' ').trim();
        if (name.length > 0 && validUsernameRegex.test(name) && check(name)) username = name;
    }

    let connection;
    try {
        connection = await db.promise().getConnection();

        let userId;
        try {
            userId = await getOrCreatePortalAccount(connection, userIp, username, playgamaUserId, "playgama_id", "PG");
        } catch (txError) {
            await connection.rollback();
            throw txError;
        }

        const bearerToken = createNewJwtToken({ id: userId });

        return res.json({
            token: bearerToken,
            id: userId
        });
    } catch (error) {
        console.error('Error during Playgama authentication:', error);
        return res.status(500).json({ error: 'An unexpected error occurred during Playgama authentication.' });
    } finally {
        if (connection) connection.release();
    }
});

// Helper for checking if there is an account associated with the portal user ID already
// UNIQUE indexes on the idColumn and user_name let us catch ER_DUP_ENTRY on INSERT instead of using FOR UPDATE for avoiding races
async function getOrCreatePortalAccount(connection, ip, portalUserName, portalUserId, idColumn, nameSuffix) {
    await connection.beginTransaction();

    let userId; // OpenGuessr user ID

    // Check if user exists
    const [existingUsers] = await connection.execute(`SELECT id FROM users WHERE ${idColumn} = ?`, [portalUserId]);
    const existingUser = existingUsers[0];

    if (existingUser) userId = existingUser.id;
    else {
        // No account exists, create one
        // Portals may not enforce a minimum or maximum length, so set here
        portalUserName = portalUserName?.substring(0, 200) || `User_${nameSuffix}${generateRandomSuffix()}`;

        // Check if username exists already
        const [existingUserNames] = await connection.execute('SELECT id FROM users WHERE user_name = ?', [portalUserName]);
        if (existingUserNames[0]) portalUserName = `${portalUserName}_${nameSuffix}${generateRandomSuffix()}`;
        const now = new Date();

        // Insert new user, concurrent inserts between our SELECTs and here surface as ER_DUP_ENTRY
        try {
            const [insertResult] = await connection.execute(
                `INSERT INTO users (user_name, ip_address, created_at, ${idColumn}) VALUES (?, ?, ?, ?)`,
                [portalUserName, ip, now, portalUserId]
            );
            userId = insertResult.insertId;
        } catch (insertError) {
            if (insertError.code !== 'ER_DUP_ENTRY') throw insertError;

            // Either UNIQUE index could've fired, re-read by portal ID to disambiguate
            // If a row exists, it's the portal ID race -> reuse it
            // If not, the collision was on user_name and the fallback suffix wasn't enough
            const [raceWinner] = await connection.execute(`SELECT id FROM users WHERE ${idColumn} = ?`, [portalUserId]);
            if (raceWinner[0]) userId = raceWinner[0].id;
            else throw new Error("Could not allocate a unique username, please retry");
        }
    }

    await connection.commit();
    return userId; // Return user ID of found or created account
}

// Google OAuth Register and/or Login Endpoint
accountRouter.post('/google-authenticate', loginLimiter, async (req, res) => {
    const db = getDB();
    const { code, redirectUri } = req.body;
    const userIp = req.clientIp;

    if (!code || !redirectUri) return res.status(400).json({ error: 'Authorization code and redirect URI are required.' });

    // Validate redirect URI against allowed CORS origins
    let isAllowedUri = false;
    try {
        const redirectOrigin = new URL(redirectUri).origin;
        isAllowedUri = corsOptions.origin.some(origin =>
            origin instanceof RegExp ? origin.test(redirectOrigin) : redirectUri.startsWith(origin)
        );
    } catch { }
    if (!isAllowedUri) return res.status(400).json({ error: 'Invalid redirect URI.' });

    let googleUserId;
    let googleEmail;
    let googleEmailVerified;
    let googleName;

    // Exchange authorization code for tokens
    try {
        const tokenResponse = await fetch('https://oauth2.googleapis.com/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                code,
                client_id: googleOAuthClientId,
                client_secret: googleOAuthClientSecret,
                redirect_uri: redirectUri,
                grant_type: 'authorization_code'
            })
        });

        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok || !tokenData.access_token) return res.status(400).json({ error: 'Failed to exchange authorization code.' });

        // Fetch user info from Google
        const userInfoResponse = await fetch('https://www.googleapis.com/oauth2/v2/userinfo', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` }
        });

        const userInfo = await userInfoResponse.json();
        if (!userInfoResponse.ok || !userInfo.id || !userInfo.email) return res.status(400).json({ error: 'Failed to fetch Google user info.' });

        googleUserId = userInfo.id;
        googleEmail = userInfo.email;
        googleEmailVerified = userInfo.verified_email === true;
        googleName = userInfo.name?.substring(0, 200); // Truncate if longer than 200 chars
    } catch (e) {
        console.error('Google OAuth token exchange failed:', e);
        return res.status(400).json({ error: 'Google authentication failed.' });
    }

    // Find or create account
    let connection;
    try {
        connection = await db.promise().getConnection();
        await connection.beginTransaction();

        // Check if user exists by google_id
        const [existingGoogleUsers] = await connection.execute('SELECT id FROM users WHERE google_id = ? FOR UPDATE', [googleUserId]);
        const existingGoogleUser = existingGoogleUsers[0];

        if (existingGoogleUser) {
            await connection.commit();

            const bearerToken = createNewJwtToken({ id: existingGoogleUser.id });
            return res.json({ token: bearerToken, id: existingGoogleUser.id });
        }

        // If the email already has an account, link Google to it so both login methods work
        const [existingEmailUsers] = await connection.execute('SELECT id, google_id FROM users WHERE email = ? FOR UPDATE', [googleEmail]);
        const existingEmailUser = existingEmailUsers[0];

        if (existingEmailUser) {
            // Refuse if email is unverified, or if the account is linked to a different Google account
            if (!googleEmailVerified || (existingEmailUser.google_id && existingEmailUser.google_id !== googleUserId)) {
                await connection.commit();
                return res.status(409).json({ error: 'Please use email login for this account.' });
            }

            await connection.execute('UPDATE users SET google_id = ? WHERE id = ?', [googleUserId, existingEmailUser.id]);
            await connection.commit();

            const bearerToken = createNewJwtToken({ id: existingEmailUser.id });
            return res.json({ token: bearerToken, id: existingEmailUser.id });
        }

        let username = googleName || `User_GO${generateRandomSuffix()}`;

        // Google names are not unique, so try progressively longer suffixes
        const [existingNameUsers] = await connection.execute('SELECT id FROM users WHERE user_name = ? FOR UPDATE', [username]);
        if (existingNameUsers[0]) {
            username = `${googleName || 'User'}_GO${generateRandomSuffix()}`;

            const [secondCheck] = await connection.execute('SELECT id FROM users WHERE user_name = ? FOR UPDATE', [username]);
            if (secondCheck[0]) {
                username = `${googleName || 'User'}_GO${generateRandomSuffix(6)}`;

                const [thirdCheck] = await connection.execute('SELECT id FROM users WHERE user_name = ? FOR UPDATE', [username]);
                if (thirdCheck[0]) throw new Error("The username already exists and all fallbacks do too.");
            }
        }

        const now = new Date();
        const [insertResult] = await connection.execute(
            'INSERT INTO users (user_name, email, ip_address, created_at, google_id) VALUES (?, ?, ?, ?, ?)',
            [username, googleEmail, userIp, now, googleUserId]
        );

        await connection.commit();

        const bearerToken = createNewJwtToken({ id: insertResult.insertId });
        return res.json({ token: bearerToken, id: insertResult.insertId });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error during Google authentication:', error);
        return res.status(500).json({ error: 'An unexpected error occurred during Google authentication.' });
    } finally {
        if (connection) connection.release();
    }
});

// Delete Account Endpoint ---------------------------------------------------------------------------------------------------------------------------
// Guarded with authenticateTokenWithId to protect against password-guessing (means a valid session, which requires email address or oAuth, is needed)
accountRouter.delete('/delete', loginLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { id, password } = req.body;

    if (!id || !password) return res.status(400).json({ error: 'Id and password are required.' });

    try {
        // Find user by ID to retrieve password hash
        const userQuery = 'SELECT password FROM users WHERE id = ?';
        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });
        if (!user) return res.status(400).json({ error: 'User not found.' });

        // Check password
        if (!user.password) return res.status(400).json({ error: 'No password set for this account.' });
        const isValidPassword = await isPasswordValid(password, user.password);
        if (!isValidPassword) return res.status(400).json({ error: 'Invalid credentials.' });

        // Delete user account
        const deleteUserQuery = 'DELETE FROM users WHERE id = ?';
        await new Promise((resolve, reject) => {
            db.execute(deleteUserQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        // Cascade chat-side cleanup, must happen after the user row is gone (per lib spec)
        // Errors here are logged but don't fail the response since the account itself is already deleted
        try { await headlessChatServer.deleteParticipant(String(id)); }
        catch (error) { console.error('Error during chat cleanup for deleted user:', error); }

        res.json({ message: 'Account deleted successfully.' });
    } catch (error) {
        console.error('Error during account deletion:', error);
        res.status(500).json({ error: 'An error occurred during account deletion.' });
    }
});

// Password resets via email -----------------------------------------------------------------------------

// request password reset email endpoint
accountRouter.post('/reset-password-request', passwordResetLimiter, async (req, res) => {
    const db = getDB();
    const { email } = req.body;

    if (!email) return res.status(400).json({ error: 'Email is required.' });

    try {
        // Find user by email
        const userQuery = 'SELECT id, user_name FROM users WHERE email = ?';
        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [email], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });
        if (!user) return res.status(404).json({ error: 'No account with that email found.' });

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

    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required.' });

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
const lastExperienceUpdate = new Map(); // User ID -> timestamp of last XP update

// Clean up stale experience timestamps every minute
setInterval(() => {
    const oneMinuteAgo = Date.now() - 60 * 1000;
    lastExperienceUpdate.forEach((time, key) => {
        if (time < oneMinuteAgo) lastExperienceUpdate.delete(key);
    });
}, 60 * 1000);

accountRouter.put('/update/add-experience', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { id, experience: addExperience } = req.body;

    if (!id || addExperience === undefined || typeof addExperience !== "number") return res.status(400).json({ error: 'User ID and experience are required.' });
    if (addExperience <= 0) return res.status(400).json({ error: 'Experience cannot be negative or zero.' });
    if (addExperience > 10000) return res.status(400).json({ error: 'Added experience amount is too high.' });

    try {
        // Fetch current experience from the database
        const userQuery = 'SELECT experience FROM users WHERE id = ?';
        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });
        if (!user) return res.status(404).json({ error: 'User not found.' });

        const { experience: currentExperience } = user;

        // Determine rate limit based on experience difference
        let rateLimitTimeout = (addExperience / 10000) * 6 * 1000 + 100; // 6s rate limiting for 10,000 XP difference

        // Check if user is allowed to make the request based on rate limiting
        const lastUpdate = lastExperienceUpdate.get(Number(id));

        if (lastUpdate) {
            const timeElapsed = Date.now() - lastUpdate; // Calculate difference in milliseconds
            if (timeElapsed < rateLimitTimeout) return res.status(429).json({ error: `Rate limit exceeded. Try again in ${Math.ceil((rateLimitTimeout - timeElapsed) / 1000)} seconds.` });
        }

        lastExperienceUpdate.set(Number(id), Date.now());
        const newExperience = currentExperience + addExperience;

        // Update user experience in the database
        const updateQuery = 'UPDATE users SET experience = ? WHERE id = ?';
        await new Promise((resolve, reject) => {
            db.execute(updateQuery, [newExperience, id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        res.json({ user: { experience: newExperience } });
    } catch (error) {
        console.error('Error updating experience:', error);
        res.status(500).json({ error: 'An error occurred while updating the experience.' });
    }
});

export default accountRouter;