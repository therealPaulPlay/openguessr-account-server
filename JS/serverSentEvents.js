import jwt from 'jsonwebtoken';
import { headlessChatServer } from './headlessChatIntegration.js';
import { jwtSecret, oldJwtSecret } from './config.js';

// SSE clients store
const clients = {};

// Drop a single SSE connection, on the last drop for a user also clean up the user's headless-chat subscriptions
function dropConnection(userId, res) {
    const set = clients[userId];
    if (!set) return;
    set.delete(res);
    if (set.size === 0) {
        delete clients[userId];
        headlessChatServer.cleanupParticipant(userId); // Clean up all headless-chat subscriptions & update last activity
    }
}

// Get clients
export function getSseClients() {
    return clients;
}

// SSE setup function
export function initSSE(app) {
    // Middleware to handle SSE connections
    app.get('/events', (req, res) => {
        const userId = req.query.userId;
        const token = req.query.bearer;
        if (!userId) return res.status(400).send('User ID is required');

        // TODO 30 days after November 26th, remove support for old secret
        try {
            let decoded;
            try {
                decoded = jwt.verify(token, jwtSecret);
            } catch { decoded = jwt.verify(token, oldJwtSecret); }
            if (String(decoded.userId) !== String(userId)) throw new Error("Token user ID mismatch");
        } catch {
            return res.status(403).send('Invalid authentication token');
        }

        // Set headers for SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // For Nginx proxy buffering

        // Send initial connection message
        res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

        // Store the connection with the user ID
        let set = clients[userId];
        if (!set) {
            set = new Set();
            clients[userId] = set;
        }
        set.add(res);

        // Handle client disconnect
        req.on('close', () => dropConnection(userId, res));
    });

    console.log("SSE server initialized at /events endpoint.");

    // Send a heartbeat every 30 seconds to keep connections alive and detect broken ones
    setInterval(() => {
        Object.entries(clients).forEach(([userId, set]) => {
            set.forEach((res) => {
                try {
                    res.write(": heartbeat\n\n");
                } catch (error) {
                    // If writing fails, the connection is broken and the entry is removed
                    dropConnection(userId, res);
                }
            })
        });
    }, 30000);
}


// Helper function to send events to a specific client
export function sendEventToClient(userId, eventData) {
    const clientSet = clients[userId];

    // Return true if at least one send succeeds
    let didOneSucceed = false;

    if (clientSet) {
        clientSet.forEach((res) => {
            try {
                res.write(`data: ${JSON.stringify(eventData)}\n\n`);
                didOneSucceed = true;
            } catch (error) {
                // Ignore, heartbeat reaps genuinely dead connections
            }
        });
    }
    return didOneSucceed;
}

// Helper function to broadcast events to all connected clients
export function broadcastEvent(eventData) {
    Object.values(clients).forEach(set => {
        set.forEach((res) => {
            try {
                res.write(`data: ${JSON.stringify(eventData)}\n\n`);
            } catch (error) {
                // Ignore errors
            }
        });
    });
}