const rateLimit = require('express-rate-limit');

// req.clientIp is being set by the request-ip middleware that's being applied in server.js
const standardLimiter = rateLimit({
    windowMs: 1000, // 1 second
    keyGenerator: (req) => req.clientIp, // correct IP
    max: 20, // Limit each IP to 20 requests per windowMs
    message: { error: 'Too many standard requests.' }
});

const registerLimiter = rateLimit({
    windowMs: 24 * 60 * 60 * 1000, // 24 hours
    keyGenerator: (req) => req.clientIp, // use correct ip and not the one of the proxy. This uses request-ip, a package that checks various aspects of the request to get the correct ip address.
    max: 8, // limit each IP to 8 requests per windowMs
    message: { error: 'Too many accounts created from this IP, please try again after 24 hours.' }
});

const loginLimiter = rateLimit({
    windowMs: 30 * 1000, // 30 seconds
    keyGenerator: (req) => req.clientIp, // use correct ip and not the one of the proxy. This uses request-ip.
    max: 10, // Limit each IP to 10 requests per windowMs
    message: { error: 'Too many login requests from this IP, please try again after 30 seconds.' }
});

const mapLoadLimiter = rateLimit({
    windowMs: 16 * 60 * 60 * 1000, // 16h
    keyGenerator: (req) => req.clientIp, // Use the correct IP and not the one of the proxy
    max: 5, // Limit each IP to a certain number of requests per windowMs
    message: {
        error: 'To prevent unusually high API costs, please do not refresh the page - thereby reload the map - more than 5 times a day. This limit will be reset tomorrow.',
    },
    skipFailedRequests: true // Skip failed requests so we can handle them manually
});

const supporterMapLoadLimiter = rateLimit({
    windowMs: 16 * 60 * 60 * 1000, // 16h
    keyGenerator: (req) => req.clientIp, // Use the correct IP and not the one of the proxy
    max: 20, // Limit each IP to a certain number of requests per windowMs
    message: {
        error: 'To prevent unusually high API costs, please do not refresh the page - thereby reload the map - more than 100 times a day for supporters. This limit will be reset tomorrow.',
    },
    skipFailedRequests: true // Skip failed requests so we can handle them manually
});

module.exports = { standardLimiter, registerLimiter, loginLimiter, mapLoadLimiter, supporterMapLoadLimiter };