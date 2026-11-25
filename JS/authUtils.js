import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';
import { oldJwtSecret, jwtSecret } from "./config.js";

// Password checks against hash ---------------------------------------------------------------------------------------------------------

// For registration - generate hash of password
async function getEncodedPassword(plainPassword) {
    const saltRounds = 10; // Number of salt rounds to use for hashing
    try {
        const hashedPassword = await bcrypt.hash(plainPassword, saltRounds);
        return hashedPassword;
    } catch (error) {
        console.error("Error hashing password:", error);
        throw error;
    }
}

// For login - compare hash to password
async function isPasswordValid(plainPassword, hashedPassword) {
    try {
        const isValid = await bcrypt.compare(plainPassword, hashedPassword);
        return isValid;
    } catch (error) {
        console.error("Error validating password:", error);
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
            jwtSecret,
            {
                expiresIn: "30d"
            }
        );
        console.info("JWT token generated successfully.");
        return accessToken;
    } catch (error) {
        console.error("Token generation error: ", error.message);
        return null;
    }
}

function authenticateTokenWithId(req, res, next) {
    const authorizationHeader = req.headers["authorization"];

    if (authorizationHeader && authorizationHeader.startsWith("Bearer ")) {
        const token = authorizationHeader.substring("Bearer ".length);

        // TODO 30 days after November 26th, remove support for old secret
        let failureCount = 0;
        const requestUserId = req.body.id ?? req.query.id ?? req.params.id;
        const secrets = [jwtSecret, oldJwtSecret];
        for (const secret of secrets) {
            try {
                verifyJwtAndId(token, secret, requestUserId);
                break; // On success, exit the loop
            } catch (error) {
                failureCount++;
                if (failureCount === secrets.length) return res.status(403).json({ status: 403, error: "Failed to verify authentication token: " + error.message })
            }
        };
        next();
    } else {
        return res.status(401).json({ status: 401, error: "No authentication token in request. Try signing out and in again." });
    }
}

// Verify an authentication token
function verifyJwtAndId(token, secret, expectedUserId) {
    const decoded = jwt.verify(token, secret);

    const tokenUserId = decoded.userId;
    if (tokenUserId == null) throw new Error("Token lacks user ID");

    // Validate the user ID
    if (tokenUserId != expectedUserId) {
        console.error("User ID from authentication token does not match the expected user ID. ID from Token: " + tokenUserId + ", expected: " + expectedUserId);
        throw new Error("Token user ID mismatch");
    }
    return decoded;
}

export { getEncodedPassword, isPasswordValid, authenticateTokenWithId, createNewJwtToken };