import "dotenv/config";
import {
    InteractionResponseFlags,
    InteractionResponseType,
    InteractionType,
    MessageComponentTypes,
    verifyKeyMiddleware,
} from "discord-interactions";
import express from "express";

const discordRouter = express.Router();

// Helpers ----------------------------------------------------------------------------
async function DiscordRequest(endpoint, options) {
    const url = "https://discord.com/api/v10/" + endpoint;
    if (options.body) options.body = JSON.stringify(options.body);

    const res = await fetch(url, {
        headers: {
            Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
            "Content-Type": "application/json; charset=UTF-8",
            "User-Agent": "DiscordBot (https://github.com/discord/discord-example-app, 1.0.0)",
        },
        ...options
    });

    if (!res.ok) {
        let data;
        try { data = await res.json() } catch { }
        throw new Error(data ? JSON.stringify(data) : res.status);
    }

    return res;
}

async function InstallGlobalCommands(appId, commands) {
    try {
        // This is calling the bulk overwrite endpoint: https://discord.com/developers/docs/interactions/application-commands#bulk-overwrite-global-application-commands
        await DiscordRequest(`applications/${appId}/commands`, { method: "PUT", body: commands });
        console.log("Registered discord bot commands.")
    } catch (error) {
        console.error(error);
    }
}

// Reply with a Components V2 text message in the channel the command came from
const reply = (res, content) =>
    res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
            flags: InteractionResponseFlags.IS_COMPONENTS_V2,
            components: [{ type: MessageComponentTypes.TEXT_DISPLAY, content }],
        },
    });

// Set up available commands ----------------------------------------------------------
const TEST_COMMAND = {
    name: "test",
    description: "Basic command",
    type: 1,
    integration_types: [0, 1],
    contexts: [0, 1, 2],
};

const ALL_COMMANDS = [TEST_COMMAND];

export async function InstallDiscordCommands() {
    await InstallGlobalCommands(process.env.DISCORD_APP_ID, ALL_COMMANDS);
}

// Interactions --------------------------------------------------------------------------------

// Interactions endpoint URL where Discord will send HTTP requests
// Parse request body and verifies incoming requests using discord-interactions package
discordRouter.post("/interactions", verifyKeyMiddleware(process.env.DISCORD_PUBLIC_KEY), async function (req, res) {
    const { id, type, data } = req.body;

    // Handle verification requests
    if (type === InteractionType.PING) return res.send({ type: InteractionResponseType.PONG });

    // Handle slash command requests
    // See https://discord.com/developers/docs/interactions/application-commands#slash-commands
    if (type === InteractionType.APPLICATION_COMMAND) {
        const { name } = data;

        if (name === "test") return reply(res, "Beep Bop. Test successful.");

        if (name === "help") {
            // TODO list all commands
        }

        if (name === "location") {
            // TODO image of new SV location
            // Pre-generate 1000 1920x1080 jpgs from World map, store in S3 together with a json that maps screenshot png to country name

            // Typing country names in the chat, without a command, case-insensitive with common misspellings/alternative names should work
            // Bot should react X or the Checkmark icon, game finishes when correct answer was stated
            // When game finishes bot should share Street View link to the location, @ the person that got it right, state the name of the country

            // If scanning every message is too expensive, a simple /guess <country> command could make sense
            // If /location in the same chat is used and one was already active, that other one should be cancelled
        }

        if (name === "profile <username|userId>") {
            // TODO show representation of the profile + stats
        }

        if (name === "leaderboard") {
            // TODO List top 5 Elo and top 5 XP, nicely separated
        }

        if (name === "country-quiz") {
            // TODO ask questions -> require people to answer with the right country (similar to location, but with text-based questions)
            // "The country I'm thinking of has/does/is/.."
            // Should work similar to the location game where a new question aborts the guessing for the previous etc.
            // Can re-use a lot of logic
        }

        if (name === "compare <username|userId> <username|userId>") {
            // TODO compare the profile stats of two players
            // Also check if they have played duels in the duel history against each other, if so list their W/L against each other, otherwise say N/A
        }

        if (name === "explain") {
            // TODO feed an LLM the last 10 messages of the chat, it should look for the latest question that it should answer
            // As context it gets a markdown doc with information about the game
            // That markdown doc should live in the codebase here. Could be discord-bot-context.md. in a /MARKDOWN folder
            // If there's no clear question it should not answer, rather the model should respond sth like { answer: false } and we reply with a generic fallback like "I'm not seeing a question here :thinking: Would you mind rephrasing?"
            // Use GPT Luna via OpenRouter
        }

        console.error(`Unknown command: ${name}`);
        return res.status(400).json({ error: "Unknown command" });
    }

    console.error("Unknown interaction type:", type);
    return res.status(400).json({ error: "Unknown interaction type" });
});

export default discordRouter;
