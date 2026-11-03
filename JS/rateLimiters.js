import rateLimit from 'express-rate-limit';

// req.clientIp is being set by the client IP middleware in server.js
const standardLimiter = rateLimit({
    windowMs: 1000, // 1 second
    keyGenerator: (req) => req.clientIp, // Use correct ip and not the one of the proxy
    max: 10, // Limit each IP to 10 requests per windowMs
    message: { error: 'Too many standard requests.' }
});

const registerLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    keyGenerator: (req) => req.clientIp,
    max: 8, // limit each IP to 8 requests per windowMs
    message: { error: 'Too many accounts created, please try again later.' }
});

const emailRequestLimiter = rateLimit({
    windowMs: 12 * 60 * 60 * 1000, // 12 hours
    keyGenerator: (req) => req.clientIp,
    max: 5, // limit each IP to 5 requests per windowMs
    message: { error: 'Too many password reset or account deletion requests, please try again later.' }
});

const loginLimiter = rateLimit({
    windowMs: 30 * 1000, // 30 seconds
    keyGenerator: (req) => req.clientIp, // use correct ip and not the one of the proxy
    max: 10, // Limit each IP to 10 requests per windowMs
    message: { error: 'Too many login requests from this IP, please try again after 30 seconds.' }
});

const nameChangeLimiter = rateLimit({
    windowMs: 7 * 24 * 60 * 60 * 1000, // 7 days
    keyGenerator: (req) => req.clientIp,
    max: 1, // Limit each IP to 3 requests per windowMs
    message: { error: 'You can only change your username once per week.' }
});

const mapFailOrUpdateLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 1 day
    max: 100,
    keyGenerator: (req) => req.clientIp,
    message: {
        error: 'Too many attempted map submissions or updates for today.',
    },
});

const successfulMapSubmissionLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 1 day
    max: 3,
    keyGenerator: (req) => req.clientIp,
    message: {
        error: 'You have reached the map submission limit for today.',
    },
});

const successfulPublicCompCreationLimiter = rateLimit({
    windowMs: 16 * 60 * 60 * 1000, // 16 hours
    max: 8,
    message: {
        error: 'You have reached the public competition creation limit for today.'
    },
    keyGenerator: (req) => req.clientIp
});

const successfulPrivateCompCreationLimiter = rateLimit({
    windowMs: 16 * 60 * 60 * 1000, // 16 hours
    max: 50,
    message: {
        error: 'You have reached the private competition creation limit for today.'
    },
    keyGenerator: (req) => req.clientIp
});

const rankingLimiter = rateLimit({
    windowMs: 1000 * 60 * 10, // 10 minutes
    max: 8,
    message: {
        error: 'Too many ranking change requests, please wait a bit.'
    },
    keyGenerator: (req) => req.clientIp
});

const friendRequestLimiter = rateLimit({
    windowMs: 1 * 60 * 60 * 1000, // 1h
    keyGenerator: (req) => req.clientIp, // correct IP
    max: 20, // limit each IP to 20 requests per windowMs
    message: { error: 'You are sending too many friend requests.' }
});

const creatorStatisticLimiter = rateLimit({
    windowMs: 1000, // 1 second
    max: 20, // 20 requests per second globally (across all IPs)
    keyGenerator: () => 'global',
    message: { error: 'Too many creator statistic requests.' }
});

export { standardLimiter, registerLimiter, loginLimiter, emailRequestLimiter, mapFailOrUpdateLimiter, successfulMapSubmissionLimiter, successfulPublicCompCreationLimiter, successfulPrivateCompCreationLimiter, rankingLimiter, friendRequestLimiter, nameChangeLimiter, creatorStatisticLimiter };