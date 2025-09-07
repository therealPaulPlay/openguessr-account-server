// SSE clients store
const clients = {};

// SSE setup function
function initSSE(app) {
    // Middleware to handle SSE connections
    app.get('/events', (req, res) => {
        const userId = req.query.userId;
        if (!userId) return res.status(400).send('User ID is required');

        // Set headers for SSE
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');
        res.setHeader('X-Accel-Buffering', 'no'); // For Nginx proxy buffering

        // Send initial connection message
        res.write(`data: ${JSON.stringify({ type: 'connected' })}\n\n`);

        // Store the connection with the user ID
        clients[userId] = res;

        // Handle client disconnect
        req.on('close', () => {
            if (clients[userId] === res) delete clients[userId];
        });
    });

    console.log("SSE server initialized at /events endpoint");

    // Send a heartbeat every 30 seconds to keep connections alive and detect broken ones
    setInterval(() => {
        Object.keys(clients).forEach(userId => {
            try {
                clients[userId].write(": heartbeat\n\n");
            } catch (error) {
                delete clients[userId]; // If writing fails, the connection is broken, so remove it
            }
        });
    }, 30000);
}


// Helper function to send events to a specific client
function sendEventToClient(userId, eventData) {
    const client = clients[userId];
    if (client) {
        client.write(`data: ${JSON.stringify(eventData)}\n\n`);
        return true;
    }
    return false;
}

// Export the SSE functions
export { initSSE, sendEventToClient };