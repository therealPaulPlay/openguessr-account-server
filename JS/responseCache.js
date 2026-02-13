const cacheStores = new Map();

// Express middleware that caches successful JSON responses in memory for a given TTL
export function cacheResponse(name, ttlMs = 15000) {
    if (!cacheStores.has(name)) cacheStores.set(name, new Map());

    return (req, res, next) => {
        const store = cacheStores.get(name);
        const cacheKey = req.method + req.originalUrl;
        const entry = store.get(cacheKey);

        if (entry && Date.now() < entry.expiresAt) {
            return res.status(entry.statusCode).json(entry.body);
        }

        const originalJson = res.json.bind(res);
        res.json = (body) => {
            if (res.statusCode >= 200 && res.statusCode < 300) {
                store.set(cacheKey, { body, statusCode: res.statusCode, expiresAt: Date.now() + ttlMs });
            }
            return originalJson(body);
        };

        next();
    };
}

// Clears all cached entries for a given cache namespace
export function clearResponseCache(name) {
    cacheStores.get(name)?.clear();
}
