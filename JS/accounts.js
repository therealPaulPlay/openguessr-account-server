import express from 'express';
const accountRouter = express.Router();
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { standardLimiter, registerLimiter, loginLimiter, nameChangeLimiter, emailRequestLimiter } from "./rateLimiters.js";
import { getEncodedPassword, isPasswordValid, authenticateTokenWithId, createNewJwtToken } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import { jwtResetSecret, googleOAuthClientId, googleOAuthClientSecret, appleConfig, y8GamesAppId } from "./config.js";
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
    if (req.query.id != null || req.body?.id != null) return res.status(400).json({ error: 'User ID should be passed in the path only.' });
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
        if (!user.password) return res.status(400).json({ error: 'Please use Google, Apple or reset your password.' });
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
            await connection.rollback().catch(() => {});
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
            await connection.rollback().catch(() => {});
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

    let connection;
    try {
        connection = await db.promise().getConnection();

        let userId;
        try {
            userId = await getOrCreatePortalAccount(connection, userIp, playgamaData.name, playgamaUserId, "playgama_id", "PG"); // The name is client-provided
        } catch (txError) {
            await connection.rollback().catch(() => {});
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

// OAuth and portal names may already exist in OpenGuessr, try with suffixes (+ include tag which marks the provider)
async function findCreateUnusedUsername(connection, providedName, tag) {
    const normalizedName = typeof providedName === 'string' ? providedName.replace(/\s+/g, ' ').trim().substring(0, 200) : '';
    const name = validUsernameRegex.test(normalizedName) ? normalizedName : undefined;

    const attempt1 = name;
    const attempt2 = (name || "User") + "_" + tag + generateRandomSuffix();
    const attempt3 = (name || "User") + "_" + tag + generateRandomSuffix(6);
    const candidates = [...(name ? [attempt1] : []), attempt2, attempt3];

    for (const candidate of candidates) {
        const [existingNameUsers] = await connection.execute('SELECT id FROM users WHERE user_name = ?', [candidate]);
        if (!existingNameUsers[0]) return candidate;
    }
    throw new Error("The username already exists and all fallbacks do too.");
}

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
        portalUserName = await findCreateUnusedUsername(connection, portalUserName, nameSuffix);
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
            // FOR SHARE reads the latest committed rows, a plain SELECT would only see this transaction's snapshot from before the race
            const [raceWinner] = await connection.execute(`SELECT id FROM users WHERE ${idColumn} = ? FOR SHARE`, [portalUserId]);
            if (raceWinner[0]) userId = raceWinner[0].id;
            else throw new Error("Could not allocate a unique username, please retry");
        }
    }

    await connection.commit();
    return userId; // Return user ID of found or created account
}

// Verifies an ID token's signature with the provider's public keys, plus the given issuer and audience
// Used for Google in-app OAuth and Apple on both web and app
async function verifyIdToken(idToken, keysUrl, options) {
    const keyId = jwt.decode(idToken, { complete: true })?.header.kid;
    const { keys } = await (await fetch(keysUrl)).json();
    const publicKey = keys.find(key => key.kid === keyId);
    if (!publicKey) throw new Error('No public key matches the ID token');

    return jwt.verify(idToken, crypto.createPublicKey({ key: publicKey, format: 'jwk' }), { algorithms: ['RS256'], ...options });
}

// Google OAuth Register and/or Login Endpoint
accountRouter.post('/google-authenticate', loginLimiter, async (req, res) => {
    const db = getDB();
    const { code, redirectUri, idToken } = req.body; // ID token from apps, code from the web
    const userIp = req.clientIp;

    if (!idToken && (!code || !redirectUri)) return res.status(400).json({ error: 'An ID token, or an authorization code and redirect URI are required.' });

    let googleUserId;
    let googleEmail;
    let googleEmailVerified;
    let googleName;

    try {
        if (idToken) {
            const claims = await verifyIdToken(idToken, 'https://www.googleapis.com/oauth2/v3/certs', {
                issuer: ['accounts.google.com', 'https://accounts.google.com'],
                audience: googleOAuthClientId // The apps request their tokens for the web client ID too
            });
            if (!claims.email) return res.status(400).json({ error: 'Invalid Google ID token.' });

            googleUserId = claims.sub; // Same ID as the user info of the web flow
            googleEmail = claims.email;
            googleEmailVerified = String(claims.email_verified) === "true";
            googleName = claims.name;
        } else {
            // Validate redirect URI against allowed CORS origins
            let isAllowedUri = false;
            try {
                const redirectOrigin = new URL(redirectUri).origin;
                isAllowedUri = corsOptions.origin.some(origin =>
                    origin instanceof RegExp ? origin.test(redirectOrigin) : redirectUri.startsWith(origin)
                );
            } catch { }
            if (!isAllowedUri) return res.status(400).json({ error: 'Invalid redirect URI.' });

            // Exchange authorization code for tokens
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
            googleName = userInfo.name;
        }
    } catch (error) {
        console.error('Google authentication failed:', error);
        return res.status(400).json({ error: 'Google authentication failed.' });
    }

    // Find or create account
    let connection;
    try {
        connection = await db.promise().getConnection();
        await connection.beginTransaction();

        // Check if user exists by google_id
        const [existingGoogleUsers] = await connection.execute('SELECT id FROM users WHERE google_id = ?', [googleUserId]);
        const existingGoogleUser = existingGoogleUsers[0];

        if (existingGoogleUser) {
            await connection.commit();

            const bearerToken = createNewJwtToken({ id: existingGoogleUser.id });
            return res.json({ token: bearerToken, id: existingGoogleUser.id });
        }

        // If the email already has an account, link Google to it so both login methods work
        const [existingEmailUsers] = await connection.execute('SELECT id, google_id FROM users WHERE email = ?', [googleEmail]);
        const existingEmailUser = existingEmailUsers[0];

        if (existingEmailUser) {
            // Refuse if email is unverified, or if the account is linked to a different Google account
            if (!googleEmailVerified || existingEmailUser.google_id) {
                await connection.commit();
                return res.status(409).json({ error: 'Please use email login for this account.' });
            }

            await connection.execute('UPDATE users SET google_id = ? WHERE id = ?', [googleUserId, existingEmailUser.id]);
            await connection.commit();

            const bearerToken = createNewJwtToken({ id: existingEmailUser.id });
            return res.json({ token: bearerToken, id: existingEmailUser.id });
        }

        const username = await findCreateUnusedUsername(connection, googleName, 'GO');
        const now = new Date();
        const [insertResult] = await connection.execute(
            'INSERT INTO users (user_name, email, ip_address, created_at, google_id) VALUES (?, ?, ?, ?, ?)',
            [username, googleEmail, userIp, now, googleUserId]
        );

        await connection.commit();

        const bearerToken = createNewJwtToken({ id: insertResult.insertId });
        return res.json({ token: bearerToken, id: insertResult.insertId });

    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        console.error('Error during Google authentication:', error);
        return res.status(500).json({ error: 'An unexpected error occurred during Google authentication.' });
    } finally {
        if (connection) connection.release();
    }
});

// Signs the client secret for Apple's token endpoints, for the client ID the user signed in with
const createAppleClientSecret = (clientId) => jwt.sign(
    { iss: appleConfig.teamId, sub: clientId, aud: 'https://appleid.apple.com' },
    appleConfig.privateKey,
    { algorithm: 'ES256', keyid: appleConfig.keyId, expiresIn: '5m' }
);

// Apple OAuth Register and/or Login Endpoint
accountRouter.post('/apple-authenticate', loginLimiter, async (req, res) => {
    const db = getDB();
    const { authorizationCode, redirectUri, name } = req.body; // Apple only shares the name with the client, and only on the first sign-in
    const userIp = req.clientIp;

    if (!authorizationCode) return res.status(400).json({ error: 'Authorization code is required.' });

    const appleClientId = redirectUri ? appleConfig.servicesId : appleConfig.bundleId; // iOS signs in natively without a redirect URI
    let appleUserId;
    let appleEmail;
    let appleEmailVerified;
    let appleRefreshToken;

    try {
        // Use the ID token from exchanging the single-use code, a client-sent one could be replayed
        // The refresh token is needed to revoke the authorization when the account gets deleted (Apple requirement)
        const tokenResponse = await fetch('https://appleid.apple.com/auth/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: appleClientId,
                client_secret: createAppleClientSecret(appleClientId),
                code: authorizationCode,
                grant_type: 'authorization_code',
                ...(redirectUri && { redirect_uri: redirectUri })
            })
        });

        const tokenData = await tokenResponse.json();
        if (!tokenResponse.ok || !tokenData.id_token || !tokenData.refresh_token) return res.status(400).json({ error: 'Failed to exchange authorization code.' });

        const claims = await verifyIdToken(tokenData.id_token, 'https://appleid.apple.com/auth/keys', {
            issuer: 'https://appleid.apple.com',
            audience: appleClientId
        });
        if (!claims.email) return res.status(400).json({ error: 'Apple did not share an email address.' });

        appleUserId = claims.sub;
        appleEmail = claims.email;
        appleEmailVerified = String(claims.email_verified) === "true"; // Can be a string or boolean, false for Apple at Work & School accounts
        appleRefreshToken = tokenData.refresh_token;
    } catch (error) {
        console.error('Apple authentication failed:', error);
        return res.status(400).json({ error: 'Apple authentication failed.' });
    }

    // Find or create account
    let connection;
    try {
        connection = await db.promise().getConnection();
        await connection.beginTransaction();

        // Every sign-in issues a new refresh token, store the latest one for revoking on deletion
        const storeAppleRefreshToken = (userId) => connection.execute(
            'INSERT INTO apple_oauth (user_id, refresh_token, client_id) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE refresh_token = ?, client_id = ?',
            [userId, appleRefreshToken, appleClientId, appleRefreshToken, appleClientId]
        );

        // Check if user exists by apple_id
        const [existingAppleUsers] = await connection.execute('SELECT id FROM users WHERE apple_id = ?', [appleUserId]);
        const existingAppleUser = existingAppleUsers[0];

        if (existingAppleUser) {
            await storeAppleRefreshToken(existingAppleUser.id);
            await connection.commit();

            const bearerToken = createNewJwtToken({ id: existingAppleUser.id });
            return res.json({ token: bearerToken, id: existingAppleUser.id });
        }

        // If the email already has an account, link Apple to it so both login methods work
        const [existingEmailUsers] = await connection.execute('SELECT id, apple_id FROM users WHERE email = ?', [appleEmail]);
        const existingEmailUser = existingEmailUsers[0];

        if (existingEmailUser) {
            // Refuse if email is unverified, or if the account is linked to a different Apple account
            if (!appleEmailVerified || existingEmailUser.apple_id) {
                await connection.commit();
                return res.status(409).json({ error: 'Please use email login for this account.' });
            }

            await connection.execute('UPDATE users SET apple_id = ? WHERE id = ?', [appleUserId, existingEmailUser.id]);
            await storeAppleRefreshToken(existingEmailUser.id);
            await connection.commit();

            const bearerToken = createNewJwtToken({ id: existingEmailUser.id });
            return res.json({ token: bearerToken, id: existingEmailUser.id });
        }

        const username = await findCreateUnusedUsername(connection, name, 'AP');
        const now = new Date();
        const [insertResult] = await connection.execute(
            'INSERT INTO users (user_name, email, ip_address, created_at, apple_id) VALUES (?, ?, ?, ?, ?)',
            [username, appleEmail, userIp, now, appleUserId]
        );
        await storeAppleRefreshToken(insertResult.insertId);

        await connection.commit();

        const bearerToken = createNewJwtToken({ id: insertResult.insertId });
        return res.json({ token: bearerToken, id: insertResult.insertId });

    } catch (error) {
        if (connection) await connection.rollback().catch(() => {});
        console.error('Error during Apple authentication:', error);
        return res.status(500).json({ error: 'An unexpected error occurred during Apple authentication.' });
    } finally {
        if (connection) connection.release();
    }
});

// Delete account ------------------------------------------------------------------------------------------------------------------------

// Account deletion request (sends email with link)
accountRouter.post('/request-deletion', emailRequestLimiter, authenticateTokenWithId, async (req, res) => {
    const db = getDB();
    const { id } = req.body;

    try {
        const userQuery = 'SELECT email, user_name FROM users WHERE id = ?';
        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });
        if (!user) return res.status(404).json({ error: 'User not found.' });
        if (!user.email) return res.status(400).json({ error: 'This account has no email address.' });

        // Token used to verify authenticity for when the user clicks the link
        const deletionToken = jwt.sign({ id: id, purpose: 'delete' }, jwtResetSecret, { expiresIn: '30m' });

        // Send email with the deletion token
        const deletionUrl = `https://openguessr.com/signup?deletion-token=${deletionToken}`;
        const mailOptions = {
            from: emailConfig.auth.user,
            to: user.email,
            subject: 'OpenGuessr Account Deletion',
            text: `Hey ${user.user_name},

Please click on this link to confirm the account deletion: ${deletionUrl}

This link expires in 30 minutes.`
        };

        await mailTransporter.sendMail(mailOptions);

        res.json({ message: 'Account deletion email sent.' });
    } catch (error) {
        console.error('Error during account deletion request:', error);
        res.status(500).json({ error: 'An error occurred during account deletion request.' });
    }
});

// Deletion endpoint (takes token from deletion email -> deletes account)
accountRouter.delete('/delete', loginLimiter, async (req, res) => {
    const db = getDB();
    const { token } = req.body;

    if (!token) return res.status(400).json({ error: 'Token is required.' });

    let id;
    try {
        const decoded = jwt.verify(token, jwtResetSecret);
        if (decoded.purpose !== 'delete') throw new Error('Not an account deletion token');
        id = decoded.id;
    } catch (error) {
        console.error('Invalid account deletion token:', error.message);
        return res.status(400).json({ error: 'This link is invalid or has expired.' });
    }

    try {
        // Find user by ID to retrieve the Apple authorization
        const userQuery = 'SELECT u.id, a.refresh_token AS apple_refresh_token, a.client_id AS apple_client_id FROM users u LEFT JOIN apple_oauth a ON a.user_id = u.id WHERE u.id = ?';
        const user = await new Promise((resolve, reject) => {
            db.execute(userQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results[0]);
            });
        });
        if (!user) return res.status(400).json({ error: 'User not found.' });

        // Delete user account
        const deleteUserQuery = 'DELETE FROM users WHERE id = ?';
        await new Promise((resolve, reject) => {
            db.execute(deleteUserQuery, [id], (err, results) => {
                if (err) return reject(err);
                resolve(results);
            });
        });

        // Apple requires revoking its authorization on deletion, a failure is logged since the account is already gone
        if (user.apple_refresh_token) {
            try {
                const revokeResponse = await fetch('https://appleid.apple.com/auth/revoke', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                    body: new URLSearchParams({
                        client_id: user.apple_client_id,
                        client_secret: createAppleClientSecret(user.apple_client_id),
                        token: user.apple_refresh_token,
                        token_type_hint: 'refresh_token'
                    })
                });
                if (!revokeResponse.ok) console.error('Apple revoke failed for deleted user:', revokeResponse.status);
            } catch (error) {
                console.error('Error revoking Apple authorization for deleted user:', error);
            }
        }

        // Cascade chat-side cleanup, must happen after the user row is gone (per lib spec)
        // Errors here are logged but don't fail the response since the account itself is already deleted
        try { await headlessChatServer.deleteParticipant(String(id)); }
        catch (error) { console.error('Error during chat cleanup for deleted user:', error); }

        res.json({ message: 'Account deleted successfully.', userId: id }); // User ID is included so the client can log out if they are logged into this specific account
    } catch (error) {
        console.error('Error during account deletion:', error);
        res.status(500).json({ error: 'An error occurred during account deletion.' });
    }
});

// Password resets via email -----------------------------------------------------------------------------

// Request password reset email endpoint
accountRouter.post('/reset-password-request', emailRequestLimiter, async (req, res) => {
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
        const resetToken = jwt.sign({ id: user.id, purpose: 'reset-password' }, jwtResetSecret, { expiresIn: '1h' });

        // Send email with the reset token
        const resetUrl = `https://openguessr.com/signup?reset-token=${resetToken}`;
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

// Reset endpoint
accountRouter.post('/reset-password', loginLimiter, async (req, res) => {
    const db = getDB();
    const { token, newPassword } = req.body;

    if (!token || !newPassword) return res.status(400).json({ error: 'Token and new password are required.' });

    // Verify the reset token + get user Id from the token so that the correct account's password can be changed
    let id;
    try {
        const decoded = jwt.verify(token, jwtResetSecret);
        if (decoded.purpose !== 'reset-password') throw new Error('Not a password reset token');
        id = decoded.id;
    } catch (error) {
        console.error('Invalid password reset token:', error.message);
        return res.status(400).json({ error: 'This link is invalid or has expired.' });
    }

    try {
        // Hash the new password
        const hashedPassword = await getEncodedPassword(newPassword);

        // Update the user's password in the database
        const updatePasswordQuery = 'UPDATE users SET password = ? WHERE id = ?';
        await new Promise((resolve, reject) => {
            db.execute(updatePasswordQuery, [hashedPassword, id], (err, results) => {
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