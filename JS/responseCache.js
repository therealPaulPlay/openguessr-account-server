const cacheStores = new Map();
const SWEEP_INTERVAL_MS = 15 * 1000;

// Periodic sweep across all stores, removes entries whose TTL has passed
setInterval(() => {
    const now = Date.now();
    for (const store of cacheStores.values()) {
        for (const [key, entry] of store) {
            if (now >= entry.expiresAt) store.delete(key);
        }
    }
}, SWEEP_INTERVAL_MS).unref();

// Express middleware that caches successful JSON responses in memory for a given TTL
export function cacheResponse(name, ttlMs = 15000) {
    if (!cacheStores.has(name)) cacheStores.set(name, new Map());

    return (req, res, next) => {
        const store = cacheStores.get(name);
        const cacheKey = req.method + req.originalUrl;
        const entry = store.get(cacheKey);

        if (entry) {
            if (Date.now() < entry.expiresAt) return res.status(entry.statusCode).json(entry.body); // Return from cache
            else store.delete(cacheKey); // Expired, clear cache for this key
        }

        const originalJson = res.json.bind(res);
        res.json = (body) => {
            res.json = originalJson; // Restore immediately so subsequent calls are unpatched
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