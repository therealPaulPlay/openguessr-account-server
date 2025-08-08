require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const requestIp = require('request-ip');
const cors = require('cors');
const xss = require('xss-clean');
const http = require('http');
const PlaySocketServer = require('playsocketjs/server');
const { attachPlaySocketEvents } = require('./JS/playSocketEvents.js');
const { connectDB } = require("./JS/dbConnection.js");

const roomRouter = require("./JS/roomManager.js");
const stripeRouter = require('./JS/stripePayments.js');
const leaderboardRouter = require('./JS/leaderboard.js');
const accountRouter = require("./JS/accounts.js");
const profileRoutes = require("./JS/profiles.js");
const creatorRouter = require("./JS/creatorStatistic.js");
const autoguessrRouter = require("./JS/autoguessrSaves.js");
const communityMapRouter = require("./JS/communityMaps.js");
const competitionsRouter = require("./JS/competitions.js");
const friendRouter = require("./JS/friends.js");
const divisionDataRouter = require('./JS/divisionData.js');
const shopRouter = require('./JS/shop.js');
// const mapLimitRouter = require('./JS/mapLimit.js');

const { port } = require("./JS/config.js");
const { corsOptions } = require("./JS/config.js");
const { initSSE } = require('./JS/serverSentEvents.js');

// Initialize the server ---------------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);
const playSocketServer = new PlaySocketServer({
    server,
    path: '/socket'
});
attachPlaySocketEvents(playSocketServer);

// CORS configuration ------------------------------------------------------------------------------------
app.use(cors(corsOptions));

// Global Middleware -------------------------------------------------------------------------------------
app.use((req, res, next) => {
    if (req.originalUrl === '/stripe/webhook') {
        next(); // Skip body-parser for Stripe webhook
    } else {
        bodyParser.json({ limit: "1mb" })(req, res, next); // Use body-parser for all other routes
    }
});

app.use(requestIp.mw()); // Apply the requestIp middleware to get the actual ip and not the ip of the proxy
app.use(xss()); // Prevent xss attacks

// MySQL Database Connection -----------------------------------------------------------------------------
connectDB();

// Init SSE ----------------------------------------------------------------------------------------------
initSSE(app);

// Routes ------------------------------------------------------------------------------------------------
app.use("/accounts/profile", profileRoutes);
app.use("/accounts/rooms", roomRouter);
app.use("/stripe", stripeRouter);
app.use("/accounts", accountRouter);
app.use("/leaderboard", leaderboardRouter);
app.use("/creators", creatorRouter);
app.use("/autoguessr", autoguessrRouter);
app.use("/maps", communityMapRouter);
app.use("/competitions", competitionsRouter);
app.use("/friends", friendRouter);
app.use("/divisions", divisionDataRouter);
app.use("/shop", shopRouter);
// app.use("/accounts", mapLimitRouter); !CHANGE this to enable maplimit routes

// Start the http server --------------------------------------------------------------------------------------
server.listen(port, () => {
    console.log(`Server running on port ${port}`);
});

// Handle shutdown gracefully ---------------------------------------------------------------------------------
function shutdown() {
    playSocketServer.stop();
    process.exit(0);
}

// Handle both SIGINT (Ctrl+C) and SIGTERM (Docker stop)
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);