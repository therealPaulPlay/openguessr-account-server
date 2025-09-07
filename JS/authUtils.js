import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { jwtSecret as SECRET_KEY } from "./config.js";

// Password checks against hash ---------------------------------------------------------------------------------------------------------

// For Register - generate hash of password
async function getEncodedPassword(plainPassword) {
    const saltRounds = 10; // Number of salt rounds to use for hashing
    try {
        const hashedPassword = await bcrypt.hash(plainPassword, saltRounds);
        return hashedPassword;
    } catch (error) {
        console.error('Error hashing password:', error);
        throw error;
    }
}

// For Login - compare hash to password
async function isPasswordValid(plainPassword, hashedPassword) {
    try {
        const isValid = await bcrypt.compare(plainPassword, hashedPassword);
        return isValid;
    } catch (error) {
        console.error('Error validating password:', error);
        throw error;
    }
}

// JWT Authentication with Bearer Token ------------------------------------------------------------------------------------------------
function createNewJwtToken(user) {
    try {
        const accessToken = jwt.sign(
            {
                sub: user.email || null, // Subject (email) - accessible via .sub (null for 3rd party SSO)
                userId: user.id // Custom claim for user ID
            },
            SECRET_KEY,
            {
                expiresIn: "30d"
            }
        );
        console.info('JWT token generated successfully.');
        return accessToken;
    } catch (error) {
        console.error('Token generation error: ', error.message);
        return null;
    }
}

function authenticateTokenWithId(req, res, next) {
    const authorizationHeader = req.headers['authorization'];

    if (authorizationHeader && authorizationHeader.startsWith('Bearer ')) {
        const token = authorizationHeader.substring('Bearer '.length);

        jwt.verify(token, SECRET_KEY, (err, decoded) => {
            if (err) {
                return res.status(403).json({ status: 403, error: "An error occurred decoding the Authentication token." });
            }

            if (!decoded || !decoded.userId) {
                return res.status(403).json({ status: 403, error: "Access token lacks user id." });
            }

            const tokenUserId = decoded.userId;
            const requestUserId = req.body.id ? req.body.id : req.params.id; // get id from params or from body, depending on what exists
            const email = decoded.sub;

            // Compare token userId with the requested userId
            if (tokenUserId != requestUserId) {
                console.error("User ID from access token does not match user id. Id from Token: " + tokenUserId + ", Id from request: " + requestUserId);
                return res.status(403).json({ status: 403, error: "User ID from access token does not match requested user id." });
            }

            next();
        });
    } else {
        return res.status(401).json({ status: 401, error: "No authentication token in request. Try signing out and in again." });
    }
}

export { getEncodedPassword, isPasswordValid, authenticateTokenWithId, createNewJwtToken };