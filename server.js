const express = require('express');
const bodyParser = require('body-parser');
const requestIp = require('request-ip');
const cors = require('cors');
const xss = require('xss-clean');
require('dotenv').config();

const { connectDB } = require("./JS/dbConnection.js");

const roomRouter = require("./JS/roomManager.js");
const stripeRouter = require('./JS/stripePayments.js');
const mapLimitRouter = require('./JS/mapLimit.js');
const leaderboardRouter = require('./JS/leaderboard.js');
const accountRouter = require("./JS/accounts.js");
const profileRoutes = require("./JS/profiles.js");
const creatorRouter = require("./JS/creatorStatistic.js");
const autoguessrRouter = require("./JS/autoguessrSaves.js");
const communityMapRouter = require("./JS/communityMaps.js");
const competitionsRouter = require("./JS/competitions.js");

const { port } = require("./JS/config.js");
const { corsOptions } = require("./JS/config.js");

const app = express();

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

// Routes ------------------------------------------------------------------------------------------------
app.use("/accounts/profile", profileRoutes);
app.use("/accounts/rooms", roomRouter);
app.use("/stripe", stripeRouter);
app.use("/accounts", accountRouter);
app.use("/accounts", leaderboardRouter);
app.use("/creators", creatorRouter);
app.use("/autoguessr", autoguessrRouter);
app.use("/maps", communityMapRouter);
app.use("/competitions", competitionsRouter);
// app.use("/accounts", mapLimitRouter); !CHANGE this to enable maplimit routes

// Start the server --------------------------------------------------------------------------------------
app.listen(port, () => { // Start the HTTP server, not the Express app
    console.log(`Server running on port ${port}`);
});