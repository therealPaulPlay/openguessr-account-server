import "dotenv/config";
import fs from "fs";
import express from "express";
import {
    InteractionResponseFlags,
    InteractionResponseType,
    InteractionType,
    MessageComponentTypes,
    verifyKeyMiddleware,
} from "discord-interactions";
import { GetObjectCommand } from "@aws-sdk/client-s3";
import { spacesClient, getPublicObjectURL } from "./spacesConnection.js";
import { getDB } from "./dbConnection.js";
import { s3Config, openRouterKey, openRouterModel } from "./config.js";

const discordRouter = express.Router();

const SCREENSHOT_LOCATIONS = "openguessr-official-maps/discord-bot/screenshot_world.json";
const COUNTRY_ALIASES = JSON.parse(fs.readFileSync("./JSON/countries.json", "utf8"));
const QUIZ_QUESTIONS = JSON.parse(fs.readFileSync("./JSON/countryQuiz.json", "utf8")).questions;
const GAME_CONTEXT = fs.readFileSync("./MARKDOWN/discord-bot-context.md", "utf8");

const EMOJI = {
    ummactually: "<:ummactually:1541051916153258115>",
    kingofthemap: "<:kingofthemap:1541051914039599186>",
    sadge: "<:sadge:1541051912009556058>",
    relativism: "<:relativism:1541051910277169265>",
    fire: "<:fire:1541051909081800735>",
    guessy: "<:guessy:1541051906992902145>",
    gentleman: "<:gentleman:1541051904648548474>",
    cool: "<:cool:1541051903402709134>",
    angry: "<:angry:1541051901855141918>",
    sob: "<:sob:1541051900072435753>",
    fiveK: "<:5K:1541051898403229696>"
};

// Discord API helpers ----------------------------------------------------------------------------
async function DiscordRequest(endpoint, options) {
    const url = "https://discord.com/api/v10/" + endpoint;
    if (options.body) options.body = JSON.stringify(options.body);

    const res = await fetch(url, {
        headers: {
            Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
            "Content-Type": "application/json; charset=UTF-8",
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

const text = (content) => ({ type: MessageComponentTypes.TEXT_DISPLAY, content });

// Reply with a Components V2 message in the channel the command came from
function reply(res, content, ephemeral = false, pingUserId = null) {
    return res.send({
        type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
        data: {
            flags: InteractionResponseFlags.IS_COMPONENTS_V2 | (ephemeral ? InteractionResponseFlags.EPHEMERAL : 0),
            components: Array.isArray(content) ? content : [text(content)],
            allowed_mentions: { parse: [], users: pingUserId ? [pingUserId] : [] },
        },
    });
}

const escapeMarkdown = (value) => String(value ?? "").replace(/([\\`*_~|>#\-\[\]()])/g, "\\$1");

// Country matching -------------------------------------------------------------------
function normalizeCountryName(name) {
    return String(name ?? "")
        .toLowerCase()
        .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // Splits "é" into "e" + accent, then drops the accent
        .replace(/[^a-z0-9]+/g, " ")
        .trim()
        .replace(/^the /, "");
}

const countryNames = new Intl.DisplayNames(["en"], { type: "region" }); // Maps stored ISO codes to names
const countryNameToCountry = new Map(); // Country name -> country (there can be multiple acceptable names for each country)

for (const [country, alternativeSpellings] of Object.entries(COUNTRY_ALIASES)) {
    for (const name of [country, ...alternativeSpellings]) countryNameToCountry.set(normalizeCountryName(name), country);
}

// How many single character edits turn a into b (Levenshtein formula)
function countEdits(a, b, limit) {
    if (Math.abs(a.length - b.length) > limit) return limit + 1;

    let previousRow = Array.from({ length: b.length + 1 }, (_, index) => index);

    for (let i = 1; i <= a.length; i++) {
        const row = [i];

        for (let j = 1; j <= b.length; j++) {
            const substitution = previousRow[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
            row[j] = Math.min(row[j - 1] + 1, previousRow[j] + 1, substitution);
        }

        if (Math.min(...row) > limit) return limit + 1;
        previousRow = row;
    }

    return previousRow[b.length];
}

// Resolve the country name from player input with slight tolerance for typos
function resolveCountry(input) {
    const name = normalizeCountryName(input);
    if (!name) return null;

    // If country exists like this, yield that
    if (countryNameToCountry.has(name)) return countryNameToCountry.get(name);
    else {
        let best = null;
        let fewestEdits = Infinity;
        let tied = false;

        const typoTolerance = (length) => {
            if (length <= 5) return 1;
            if (length <= 9) return 2;
            return 3;
        }

        for (const [candidate, country] of countryNameToCountry) {
            const tolerance = typoTolerance(Math.max(name.length, candidate.length));
            const edits = countEdits(name, candidate, tolerance);

            if (edits > tolerance) continue;

            if (edits < fewestEdits) {
                best = country;
                fewestEdits = edits;
                tied = false;
            } else if (edits === fewestEdits && country !== best) tied = true;
        }

        return tied ? null : best; // If there's a tied result don't blindly pick one, rather reject
    }
}

// Players ----------------------------------------------------------------------------

// Takes a user ID as user-... or username
async function fetchUserAndProfile(input) {
    const id = input.match(/^(?:user-)?(\d+)$/)?.[1] || 0;

    const [[player]] = await getDB().promise().execute(`
        SELECT u.id, u.user_name, u.experience, u.elo, u.created_at, p.about, p.duels_won, p.duels_lost
        FROM users u
        LEFT JOIN profile_data p ON u.id = p.user_id
        WHERE u.user_name = ? OR u.id = ?
        ORDER BY u.user_name = ? DESC
        LIMIT 1
    `, [input, id, input]);

    return player || null;
}

function formatProfile(user) {
    const joined = `<t:${Math.floor(new Date(user.created_at).getTime() / 1000)}:D>`;

    return [
        `**${escapeMarkdown(user.user_name)}** (user-${user.id})`,
        user.about ? `About:\n${escapeMarkdown(user.about)}\n` : "",
        "Stats:",
        `${Number(user.elo).toLocaleString("en")} Elo`,
        `${Number(user.experience).toLocaleString("en")} XP`,
        `${Number(user.duels_won).toLocaleString("en")}W / ${Number(user.duels_lost).toLocaleString("en")}L Duels`,
        `Joined ${joined}`
    ].filter(Boolean).join("\n");
}

// Screenshot-guessing rounds --------------------------------------------------------------------
const ROUND_TIMEOUT_MS = 15 * 60 * 1000;

const rounds = new Map(); // One round per channel

// Delete time-outed rounds
setInterval(() => {
    for (const [id, round] of rounds) {
        if (Date.now() >= round.expiresAt) rounds.delete(id);
    }
}, 60 * 1000).unref();

// Starting a round replaces any previous rounds in that channel
function startRound(id, round) {
    const previous = rounds.get(id);
    rounds.set(id, { ...round, attempts: 0, expiresAt: Date.now() + ROUND_TIMEOUT_MS });

    if (!previous || Date.now() >= previous.expiresAt) return ""; // No active previous round
    return `Cancelled the previous round, the country was **${previous.answer}**.\n\n`;
}

let locationsCache = null;

async function getScreenshotLocations() {
    if (locationsCache && Date.now() < locationsCache.expiresAt) return locationsCache.locations;

    const response = await spacesClient.send(new GetObjectCommand({ Bucket: s3Config.bucketName, Key: SCREENSHOT_LOCATIONS }));
    const locations = JSON.parse(await response.Body.transformToString())?.locations;
    if (!locations?.length) throw new Error("Failed to retrieve screenshot locations");

    locationsCache = { locations, expiresAt: Date.now() + 60 * 60 * 1000 }; // 1h
    return locations;
}

// Command setup ----------------------------------------------------------
const commandBase = { type: 1, integration_types: [0, 1], contexts: [0, 1, 2] };
const stringOption = (name, description, required = true) => ({ type: 3, name, description, required });

const ALL_COMMANDS = [
    { ...commandBase, name: "test", description: "Test command" },
    { ...commandBase, name: "help", description: "List all commands" },
    { ...commandBase, name: "location-quiz", description: "Show a screenshot of a panorama to guess" },
    { ...commandBase, name: "country-quiz", description: "Show a country trivia question" },
    {
        ...commandBase, name: "guess", description: "Submit a country as your answer",
        options: [stringOption("country", "The country that you think it is")]
    },
    {
        ...commandBase, name: "profile", description: "Show a player's profile",
        options: [stringOption("player", "Username or user ID")]
    },
    { ...commandBase, name: "leaderboard", description: "Show the top 5 players on both leaderboards" },
    {
        ...commandBase, name: "compare", description: "Compare two players and their duel history",
        options: [stringOption("player", "Username or user ID"), stringOption("opponent", "Username or user ID")]
    },
    {
        ...commandBase, name: "explain", description: "Ask a question about OpenGuessr",
        options: [stringOption("question", "Provide a question, or omit to answer the most recent one", false)]
    }
];

// Shown by /help and also provided to the LLM
const COMMAND_LIST = ALL_COMMANDS
    .filter(command => command.name !== "test")
    .map(command => {
        const args = (command.options || []).map(option => option.required ? ` <${option.name}>` : ` [${option.name}]`).join("");
        return `\`/${command.name}${args}\` - ${command.description}`;
    })
    .join("\n");

export async function InstallDiscordCommands() {
    await InstallGlobalCommands(process.env.DISCORD_APP_ID, ALL_COMMANDS);
}

// Command handlers -------------------------------------------------------------------
const handlers = {
    test: (_req, res) => reply(res, `G.. Gues... Guessy? Yes, that's me. Test successful ${EMOJI.cool}`),

    help: (_req, res) => reply(res, COMMAND_LIST),

    "location-quiz": async (req, res) => {
        const locations = await getScreenshotLocations();
        const [lat, lng, options] = locations[Math.floor(Math.random() * locations.length)];

        const cancelledString = startRound(req.body.channel_id, {
            type: "location-quiz", answer: resolveCountry(countryNames.of(options.country)), lat, lng
        });

        return reply(res, [
            text(`${cancelledString}**In which country is this location? ${EMOJI.ummactually}**\n\nAnswer with \`/guess <country>\`.`),
            { type: MessageComponentTypes.MEDIA_GALLERY, items: [{ media: { url: await getPublicObjectURL(options.imageKey) } }] }
        ]);
    },

    "country-quiz": (req, res) => {
        const question = QUIZ_QUESTIONS[Math.floor(Math.random() * QUIZ_QUESTIONS.length)];
        const cancelledString = startRound(req.body.channel_id, { type: "country-quiz", answer: question.answer });

        return reply(res, `${cancelledString}**Which country does this describe? ${EMOJI.ummactually}**\n${question.question}\n\nAnswer with \`/guess <country>\`.`);
    },

    guess: (req, res) => {
        const round = rounds.get(req.body.channel_id);
        if (!round || Date.now() >= round.expiresAt) return reply(res, `There's no active game ${EMOJI.sob}`, true);

        const typed = req.body.data.options.find(option => option.name === "country").value;
        const guess = resolveCountry(typed);
        if (!guess) return reply(res, `Unknown country: "${escapeMarkdown(typed)}".`, true);

        // Guild interactions include the user under member, DMs don't
        const playerId = req.body.member?.user?.id || req.body.user?.id;
        const player = `<@${playerId}>`;
        round.attempts++;

        if (guess !== resolveCountry(round.answer)) return reply(res, `:x: ${player} guessed **${guess}**.`);

        rounds.delete(req.body.channel_id);

        const streetView = round.type === "location-quiz"
            ? ` ([view location](https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${round.lat},${round.lng}))`
            : "";

        return reply(res, `:white_check_mark: **${round.answer}** - ${player} got it after ${round.attempts} guess${round.attempts === 1 ? "" : "es"} ${EMOJI.fiveK}${streetView}`, false, playerId);
    },

    profile: async (req, res) => {
        const identifier = req.body.data.options.find(option => option.name === "player").value;
        const player = await fetchUserAndProfile(identifier);
        if (!player) return reply(res, `Player "${escapeMarkdown(identifier)}" not found ${EMOJI.sadge}`, true);

        return reply(res, formatProfile(player));
    },

    leaderboard: async (_req, res) => {
        const db = getDB().promise();
        const [[byElo], [byExperience]] = await Promise.all([
            db.execute("SELECT user_name, elo FROM users ORDER BY elo DESC LIMIT 5"),
            db.execute("SELECT user_name, experience FROM users ORDER BY experience DESC LIMIT 5")
        ]);

        const buildList = (rows, column, symbol) => rows
            .map((row, index) => `${index + 1}. **${escapeMarkdown(row.user_name)}** - ${Number(row[column]).toLocaleString("en")} ${symbol}`)
            .join("\n");

        return reply(res, `**Elo**\n${buildList(byElo, "elo", "Elo")}\n\n**XP**\n${buildList(byExperience, "experience", "XP")}`);
    },

    compare: async (req, res) => {
        const identifiers = ["player", "opponent"].map(name => req.body.data.options.find(option => option.name === name).value);
        const players = await Promise.all(identifiers.map(fetchUserAndProfile));

        const missingPlayers = identifiers.filter((_identifier, index) => !players[index]);
        if (missingPlayers.length) return reply(res, `No player found for ${missingPlayers.map(name => `"${escapeMarkdown(name)}"`).join(" and ")}.`, true);
        if (players[0].id === players[1].id) return reply(res, `Can't compare two identical players ${EMOJI.ummactually}`, true);

        const [duels] = await getDB().promise().execute(`
            SELECT user1_id, user2_id, user1_win, user2_win, created_at FROM duel_entries
            WHERE (user1_id = ? AND user2_id = ?) OR (user1_id = ? AND user2_id = ?)
            ORDER BY id DESC LIMIT 10
        `, [players[0].id, players[1].id, players[1].id, players[0].id]);

        const nameOfPlayerId = (id) => escapeMarkdown(players.find(player => Number(player.id) === Number(id)).user_name);

        const history = duels.map(duel => {
            const date = `<t:${Math.floor(new Date(duel.created_at).getTime() / 1000)}:f>`;
            const winner = duel.user1_win ? nameOfPlayerId(duel.user1_id) : duel.user2_win ? nameOfPlayerId(duel.user2_id) : null;
            return `${date} - ${winner ? `${winner} won` : "Draw"}`;
        }).join("\n") || `No recent duels ${EMOJI.sob}`;

        const versus = players.map(player => escapeMarkdown(player.user_name)).join(" vs. ");

        return reply(res, `${players.map(formatProfile).join("\n\n")}\n\n**${versus}**\n${history}`);
    },

    // Since Discord times a command out after 3s we ack first
    explain: async (req, res) => {
        if (!hasExplainUsesLeft(req.body.member?.user?.id || req.body.user?.id)) return reply(res, `Too many questions, give me a minute please ${EMOJI.gentleman}`, true);

        res.send({ type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE, data: {} });

        const edit = (message) => DiscordRequest(`webhooks/${process.env.DISCORD_APP_ID}/${req.body.token}/messages/@original`, {
            method: "PATCH",
            body: {
                flags: InteractionResponseFlags.IS_COMPONENTS_V2,
                components: [text(message.slice(0, 3900))],
                allowed_mentions: { parse: [], users: [] }
            }
        });

        let message;
        try {
            const question = req.body.data.options?.find(option => option.name === "question")?.value;
            message = await askLLM(question, req.body.channel_id, req.body.guild_id)
                || `I'm not seeing a question here ${EMOJI.gentleman}`;
        } catch (error) {
            console.error("Error handling /explain:", error);
            message = "Internal error.";
        }

        try {
            await edit(message);
        } catch (error) {
            console.error("Failed to send the /explain answer:", error);
            await edit("Internal error.").catch(() => { });
        }
    }
};

// Answering questions via an LLM ----------------------------------------------------------------
const EXPLAIN_WINDOW_MS = 60 * 1000;
const EXPLAIN_MAX_USES = 3;

const explainUses = new Map(); // Discord user ID -> timestamps

// Delete explain rate limit entries
setInterval(() => {
    for (const [id, uses] of explainUses) {
        if (uses.every(time => Date.now() - time >= EXPLAIN_WINDOW_MS)) explainUses.delete(id);
    }
}, 60 * 1000).unref();

function hasExplainUsesLeft(userId) {
    const recent = (explainUses.get(userId) || []).filter(time => Date.now() - time < EXPLAIN_WINDOW_MS);
    if (recent.length >= EXPLAIN_MAX_USES) return false;
    explainUses.set(userId, [...recent, Date.now()]);
    return true;
}

const MAX_IMAGES = 3;
const MAX_TOOL_STEPS = 3;
const MAX_ANSWER_TOKENS = 1000;

const LIST_COMMANDS_TOOL = {
    type: "function",
    function: {
        name: "list_commands",
        description: "List the slash commands available for users of Guessy (for questions about how to use the bot).",
        parameters: { type: "object", properties: {} }
    }
};

const READ_CHANNEL_TOOL = {
    type: "function",
    function: {
        name: "read_channel",
        description: "Read the last 50 messages of a listed channel.",
        parameters: { type: "object", properties: { name: { type: "string" } }, required: ["name"] }
    }
};

// Needs the Message Content intent
async function readChannel(id, limit = 10) {
    try {
        const response = await DiscordRequest(`channels/${id}/messages?limit=${limit}`, { method: "GET" });
        return (await response.json()).filter(message => !message.author?.bot).reverse();
    } catch (error) {
        console.error("Failed to read channel:", error);
        return [];
    }
}

const asTranscript = (messages) => messages
    .filter(message => message.content)
    .map(message => `${message.author?.username || "player"}: ${message.content}`)
    .join("\n");

async function readableChannels(guildId) {
    if (!guildId) return [];

    try {
        const channels = await (await DiscordRequest(`guilds/${guildId}/channels`, { method: "GET" })).json();
        return channels.filter(channel => channel.type === 0 || channel.type === 5); // Regular chat and announcements
    } catch (error) {
        console.error("Failed to list channels:", error);
        return [];
    }
}

async function readChannelByName(channels, name) {
    const match = channels.find(channel => channel.name?.toLowerCase() === String(name).toLowerCase());
    if (!match) return "Channel does not exist.";
    return asTranscript(await readChannel(match.id, 50)) || "Empty or unreachable.";
}

async function sendOpenRouterRequest(messages, tools) {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: { Authorization: `Bearer ${openRouterKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
            model: openRouterModel,
            max_tokens: MAX_ANSWER_TOKENS,
            response_format: { type: "json_object" },
            tools: tools?.length ? tools : undefined,
            messages
        })
    });

    if (!response.ok) throw new Error(`OpenRouter returned ${response.status}: ${await response.text()}`);
    return (await response.json()).choices?.[0]?.message;
}

// Returns the answer, or null when there is no question
async function askLLM(question, channelId, guildId) {
    const recent = channelId ? await readChannel(channelId) : [];
    if (!question && recent.length === 0) return null;

    const channels = await readableChannels(guildId);
    const channelNames = channels.map(channel => channel.name).join(", ");
    const tools = channels.length ? [LIST_COMMANDS_TOOL, READ_CHANNEL_TOOL] : [LIST_COMMANDS_TOOL];

    const systemPrompt = `${GAME_CONTEXT}\n\n## Instructions\n\n` +
        (channelNames ? `When unsure, you can read from these channels (may include a helpful FAQ): ${channelNames}\n\n` : "") +
        `ONLY use these emojis (No other emojis are allowed), copied exactly including the numbers: ${Object.values(EMOJI).join(" ")}\n\n` +
        `Reply as JSON with {"answer": "<your answer to the latest question>"}, or {"answer": false} if there is no clear question.`;

    const images = recent
        .flatMap(message => (message.attachments || []).map(attachment => ({ ...attachment, from: message.author?.username || "player" })))
        .filter(attachment => attachment.content_type?.startsWith("image/"))
        .slice(-MAX_IMAGES);

    // Include the most recent 10 messages from the channel
    const transcript = asTranscript(recent);
    const prompt = [transcript && `Recent messages:\n${transcript}`, question && `Question: ${question}`]
        .filter(Boolean)
        .join("\n\n");

    // Build the messages that the model receives
    const messages = [
        { role: "system", content: systemPrompt },
        {
            role: "user", content: [
                { type: "text", text: prompt },
                ...images.flatMap(image => [{ type: "text", text: `Image from ${image.from}:` }, { type: "image_url", image_url: { url: image.url } }])
            ]
        }
    ];

    for (let step = 0; step <= MAX_TOOL_STEPS; step++) {
        const reply = await sendOpenRouterRequest(messages, step < MAX_TOOL_STEPS ? tools : undefined);

        if (!reply?.tool_calls?.length) {
            const answer = JSON.parse(reply?.content || "{}")?.answer;
            return typeof answer === "string" && answer.trim() ? answer.trim() : null;
        }
        messages.push(reply);

        for (const call of reply.tool_calls) {
            const content = call.function.name === "list_commands"
                ? COMMAND_LIST
                : await readChannelByName(channels, JSON.parse(call.function.arguments || "{}").name);

            messages.push({ role: "tool", tool_call_id: call.id, content });
        }
    }

    throw new Error("Model stuck in tool call loop");
}

// Interactions endpoint --------------------------------------------------------------------------------

// Parse request body and verifies incoming requests using discord-interactions package (therefore needs to use express raw)
discordRouter.post("/interactions", verifyKeyMiddleware(process.env.DISCORD_PUBLIC_KEY), async function (req, res) {
    const { type, data } = req.body;

    // Handle verification requests
    if (type === InteractionType.PING) return res.send({ type: InteractionResponseType.PONG });

    // Handle slash command requests
    // See https://discord.com/developers/docs/interactions/application-commands#slash-commands
    if (type === InteractionType.APPLICATION_COMMAND) {
        const handler = handlers[data.name];

        if (!handler) {
            console.error(`Unknown command: ${data.name}`);
            return res.status(400).json({ error: "Unknown command" });
        }

        try {
            return await handler(req, res);
        } catch (error) {
            console.error(`Error handling /${data.name}:`, error);
            if (!res.headersSent) return reply(res, "Internal error.", true);
            return;
        }
    }

    console.error("Unknown interaction type:", type);
    return res.status(400).json({ error: "Unknown interaction type" });
});

export default discordRouter;
