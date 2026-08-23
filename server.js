import 'dotenv/config';
import express from 'express';
import requestIp from 'request-ip';
import cors from 'cors';
import http from 'node:http';
import { initPlaySocket, playSocketServer } from './JS/playSocketEvents.js';
import { connectDB } from "./JS/dbConnection.js";

import matchmakingRouter from "./JS/matchmaking.js";
import stripeRouter from './JS/stripePayments.js';
import leaderboardRouter from './JS/leaderboard.js';
import accountRouter from "./JS/accounts.js";
import profileRoutes from "./JS/profiles.js";
import creatorRouter from "./JS/creatorStatistic.js";
import communityMapRouter from "./JS/communityMaps.js";
import competitionsRouter from "./JS/competitions.js";
import friendRouter from "./JS/friends.js";
import divisionDataRouter from './JS/divisionData.js';
import shopRouter from './JS/shop.js';
import locationRouter from './JS/locations.js';
import tournamentRouter from './JS/tournaments.js';
import discordRouter, { InstallDiscordCommands } from './JS/discordBot.js';
import headlessChatRouter, { headlessChatServer } from './JS/headlessChatIntegration.js';

import { port } from "./JS/config.js";
import { corsOptions } from "./JS/config.js";
import { initSSE } from './JS/serverSentEvents.js';

// Initialize the server ---------------------------------------------------------------------------------
const app = express();
const server = http.createServer(app);

// Multiplayer WebSocket system
initPlaySocket(server);

// CORS configuration ------------------------------------------------------------------------------------
app.use(cors(corsOptions));

// Global Middleware -------------------------------------------------------------------------------------
app.use((req, res, next) => {
    if (['/stripe/webhook', '/discord/interactions'].includes(req.originalUrl)) express.raw({ type: 'application/json' })(req, res, next);
    else express.json({ limit: "1mb" })(req, res, next); // Automatically parse incoming JSON bodies
});

app.use(requestIp.mw()); // Apply the requestIp middleware to get the actual ip and not the ip of the proxy

// MySQL Database Connection -----------------------------------------------------------------------------
connectDB();

// Init SSE ----------------------------------------------------------------------------------------------
initSSE(app);

// Init Discord bot commands -----------------------------------------------------------------------------
InstallDiscordCommands();

// Routes ------------------------------------------------------------------------------------------------
app.use("/accounts/profile", profileRoutes);
app.use("/matchmaking", matchmakingRouter);
app.use("/stripe", stripeRouter);
app.use("/accounts", accountRouter);
app.use("/leaderboard", leaderboardRouter);
app.use("/creators", creatorRouter);
app.use("/maps", communityMapRouter);
app.use("/competitions", competitionsRouter);
app.use("/friends", friendRouter);
app.use("/divisions", divisionDataRouter);
app.use("/shop", shopRouter);
app.use("/locations", locationRouter);
app.use("/tournaments", tournamentRouter);
app.use("/headless-chat", headlessChatRouter);
app.use("/discord", discordRouter);

// Start the http server --------------------------------------------------------------------------------------
server.listen(port, () => {
    console.log(`Server running on port ${port}.`);
});

// Handle shutdown gracefully ---------------------------------------------------------------------------------
function shutdown() {
    playSocketServer.stop();
    headlessChatServer.stop();
    process.exit(0);
}

// Handle both SIGINT (Ctrl+C) and SIGTERM (Docker stop)
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);