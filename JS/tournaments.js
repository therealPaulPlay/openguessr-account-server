import express from 'express';
import { standardLimiter } from "./rateLimiters.js";
import { authenticateTokenWithId } from "./authUtils.js";
import { getDB } from "./dbConnection.js";
import { broadcastEvent, sendEventToClient } from "./serverSentEvents.js";
import { playSocketServer, rematch, startRoom } from './playSocketEvents.js';

const tournamentRouter = express.Router();

tournamentRouter.get("/all-tournaments", standardLimiter, async (req, res) => {
    const userId = req.query['user-id'];

    try {
        const db = getDB();

        // Check if new weekly tournament exists
        const [weeklyTournament] = await db.promise().execute(
            `SELECT 1 FROM tournaments WHERE name = 'Weekly Tournament' AND status IN ('upcoming', 'starting', 'ongoing') LIMIT 1`
        );

        // If no weekly tournament exists yet, create
        if (weeklyTournament.length == 0) {
            const nowUTC = new Date();
            const daysUntilWed = (3 - nowUTC.getUTCDay() + 7) % 7 || 7;
            const randomDay = Math.floor(Math.random() * 5);
            const randomHour = Math.floor(Math.random() * 9) + 12;
            const startDate = new Date(Date.UTC(
                nowUTC.getUTCFullYear(),
                nowUTC.getUTCMonth(),
                nowUTC.getUTCDate() + daysUntilWed + randomDay,
                randomHour,
                0,
                0,
                0
            ));
            const prizes = ["500 tokens", "750 tokens", "Supporter tier 1"];
            await createTournament("Weekly Tournament", startDate, prizes[Math.floor(Math.random() * 3)], "standard");
        }

        // Get tournaments
        const [tournaments] = await db.promise().execute(`
            SELECT t.id, t.name, t.start_date as date, t.prize, t.status, t.winner_id, t.winner_name, t.map,
                   COUNT(ts.user_id) as saves
            FROM tournaments t
            LEFT JOIN tournament_saves ts ON t.id = ts.tournament_id
            GROUP BY t.id ORDER BY t.start_date DESC
        `);

        const result = [];

        for (const tournament of tournaments) {
            const tournamentData = {
                id: tournament.id,
                name: tournament.name,
                date: tournament.date,
                saves: tournament.saves,
                prize: tournament.prize,
                status: tournament.status,
                matches: [],
                winner: tournament.winner_id ? { name: tournament.winner_name, id: tournament.winner_id } : {},
                map: tournament.map
            };

            if (userId) {
                const [savedCheck] = await db.promise().execute(
                    'SELECT 1 FROM tournament_saves WHERE tournament_id = ? AND user_id = ?',
                    [tournament.id, userId]
                );
                tournamentData.saved = savedCheck.length > 0; // Add "saved" field to tournament data for signed-in users
            }

            const [matchResults] = await db.promise().execute(
                `SELECT match_index, user_id, score, ascended, user_name 
                 FROM tournament_match_results WHERE tournament_id = ? 
                 ORDER BY match_index, ascended DESC, score DESC`,
                [tournament.id]
            );

            const matchesMap = {};
            matchResults.forEach(result => {
                if (!matchesMap[result.match_index])
                    matchesMap[result.match_index] = { ascendedPlayers: [], eliminatedPlayers: [] };

                const player = { username: result.user_name, id: result.user_id, score: result.score };

                if (result.ascended) matchesMap[result.match_index].ascendedPlayers.push(player);
                else matchesMap[result.match_index].eliminatedPlayers.push(player);
            });

            tournamentData.matches = Object.keys(matchesMap)
                .sort((a, b) => parseInt(a) - parseInt(b))
                .map(key => matchesMap[key]);

            result.push(tournamentData);
        }

        res.json(result);
    } catch (error) {
        console.error('Error fetching tournaments:', error);
        res.status(500).json({ error: 'Internal server error getting all tournaments.' });
    }
});

tournamentRouter.put("/enter/:id", standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: userId } = req.body;
    const { id: tournamentId } = req.params;

    try {
        const db = getDB();

        const [userCheck] = await db.promise().execute(
            'SELECT elo, created_at FROM users WHERE id = ?',
            [userId]
        );
        if (userCheck.length === 0) return res.status(404).json({ error: 'User not found!' });

        const user = userCheck[0];
        const accountAge = (new Date() - new Date(user.created_at)) / (1000 * 60 * 60 * 24);

        if (user.elo < 1100) return res.status(400).json({ error: 'Minimum elo requirement not met (1100)!' });
        if (accountAge < 7) return res.status(400).json({ error: 'Account must be at least 7 days old!' });

        const [tournamentCheck] = await db.promise().execute(
            'SELECT room_id, status FROM tournaments WHERE id = ?',
            [tournamentId]
        );
        if (tournamentCheck.length === 0) return res.status(404).json({ error: 'Tournament not found!' });

        const tournament = tournamentCheck[0];

        if (tournament.status !== 'starting') return res.status(400).json({ error: 'Tournament is not in starting state!' });
        if (!tournament.room_id) return res.status(400).json({ error: 'Room ID is not available yet!' });

        res.json({ roomId: tournament.room_id });
    } catch (error) {
        console.error('Error entering tournament:', error);
        res.status(500).json({ error: 'Internal server error entering tournament.' });
    }
});

tournamentRouter.post("/calendar-save/:id", standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: userId } = req.body;
    const { id: tournamentId } = req.params;

    try {
        const db = getDB();

        const [existingCheck] = await db.promise().execute(
            'SELECT 1 FROM tournament_saves WHERE tournament_id = ? AND user_id = ?',
            [tournamentId, userId]
        );
        if (existingCheck.length > 0) return res.status(400).json({ error: 'Tournament already saved!' });

        await db.promise().execute(
            'INSERT INTO tournament_saves (tournament_id, user_id) VALUES (?, ?)',
            [tournamentId, userId]
        );

        res.json({ message: "Tournament calendar save added successfully." });
    } catch (error) {
        console.error('Error saving tournament:', error);
        res.status(500).json({ error: 'Internal server error tracking tournament calendar save.' });
    }
});

async function createTournament(name, startDate, prize, mapCategory = "standard") {
    const db = getDB();

    try {
        const formattedDate = startDate instanceof Date ?
            startDate.toISOString().slice(0, 19).replace('T', ' ') :
            startDate;

        const [result] = await db.promise().execute(
            'INSERT INTO tournaments (name, start_date, prize, status, map) VALUES (?, ?, ?, ?, ?)',
            [name, formattedDate, prize, "upcoming", mapCategory]
        );

        broadcastEvent({ type: "tournament-updated" });
        return result.insertId;
    } catch (error) {
        console.error('Error creating tournament:', error);
        throw error;
    }
}

async function updateTournament(id, status = null, winnerId = null, winnerName = null, roomId = null, mapCategory = null) {
    const db = getDB();

    try {
        const updateFields = { status, winner_id: winnerId, winner_name: winnerName, room_id: roomId, map: mapCategory };
        const updates = [];
        const values = [];

        Object.entries(updateFields).forEach(([field, value]) => {
            if (value != null) {
                updates.push(`${field} = ?`);
                values.push(value);
            }
        });

        if (updates.length === 0) throw new Error('No updates provided');

        values.push(id);

        await db.promise().execute(
            `UPDATE tournaments SET ${updates.join(', ')} WHERE id = ?`,
            values
        );

        broadcastEvent({ type: "tournament-updated" });
        return id;
    } catch (error) {
        console.error('Error updating tournament:', error);
        throw error;
    }
}

const processedTournaments = new Set();

async function startTournament(tournamentId, map) {
    try {
        const { id: roomId } = await playSocketServer.createRoom({
            roundAmount: 5,
            roundLength: 60,
            category: map,
            tournamentRoom: true,
            tournamentId
        });

        await updateTournament(tournamentId, 'starting', null, null, roomId);
        broadcastEvent({ type: "tournament-starting" }); // Notify players that a tournament is soon starting
        console.log(`Tournament ${tournamentId} started with room ID: ${roomId}`);

        let timeCountdown = 5 * 60;

        const chatInfoInterval = setInterval(() => {
            timeCountdown -= 30;
            const minutes = Math.floor(timeCountdown / 60);
            const seconds = timeCountdown % 60;
            let timeString;
            if (minutes > 0 && seconds > 0) timeString = `${minutes} minutes and ${seconds} seconds`;
            else if (minutes > 0) timeString = `${minutes} minute${minutes > 1 ? 's' : ''}`;
            else timeString = `${seconds} seconds`;
            playSocketServer.updateRoomStorage(roomId, "chats", "array-add", `System: Starting tournament in ${timeString}.`);
        }, 30 * 1000);

        setTimeout(async () => {
            try {
                clearInterval(chatInfoInterval);
                await updateTournament(tournamentId, 'ongoing');
                playSocketServer?.updateRoomStorage(roomId, "locked", "set", true);
                startRoom(roomId); // Start
            } catch (error) {
                console.error(`Error updating tournament ${tournamentId} to ongoing:`, error);
            }
        }, 5 * 60 * 1000);

    } catch (error) {
        console.error(`Error starting tournament ${tournamentId}:`, error);
    }
}

let initialTournamentCheck = true;

async function checkAndStartTournaments() {
    try {
        const db = getDB();
        const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

        const [tournaments] = await db.promise().execute(
            `SELECT id, map FROM tournaments
             WHERE status = 'upcoming'
             AND start_date <= DATE_ADD(?, INTERVAL 1 MINUTE)`, // Start up to 1 minute early
            [now]
        );

        for (const tournament of tournaments) {
            if (!processedTournaments.has(tournament.id)) {
                processedTournaments.add(tournament.id);
                await startTournament(tournament.id, tournament.map);
            }
        }

        // Delete tournaments that are more than a week old
        const oneWeekAgoUTC = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
        await db.promise().execute(
            `DELETE FROM tournaments WHERE start_date < ?`,
            [oneWeekAgoUTC]
        );

        // On initial check after server restart, clean up interrupted tournaments
        if (initialTournamentCheck) {
            const [interruptedTournaments] = await db.promise().execute(
                `SELECT id FROM tournaments WHERE status IN ('starting', 'ongoing')`
            );

            if (interruptedTournaments.length > 0) {
                await db.promise().execute(
                    `UPDATE tournaments SET status = 'finished' WHERE status IN ('starting', 'ongoing')`
                );
                console.log(`Cleaned up ${interruptedTournaments.length} interrupted tournament(s) after server restart.`);
            }

            initialTournamentCheck = false;
        }

        console.log("Checked and started eligible tournaments.");
    } catch (error) {
        console.error('Error checking tournaments:', error);
    }
}

// Check if tournaments should be started every 30 seconds
setInterval(checkAndStartTournaments, 30000);

// Process results after each tournament match
export async function processTournamentMatchResults(roomId, tournamentId) {
    try {
        if (tournamentId == null) throw new Error("Tournament ID is not set!");
        const playerArray = playSocketServer.getRoomStorage(roomId)?.players;
        const playerArrayWithoutSpectators = playerArray?.filter((p) => p.spectator == false);

        // If room is empty (e.g. all non-spectator participants left) close as a failsave
        if (!playerArrayWithoutSpectators?.length) {
            playSocketServer.updateRoomStorage(roomId, "chats", "array-add", `System: No active tournament participants – room closing in 1 minute.`);
            endTournament(tournamentId, roomId);
            return;
        }

        // Sort by score
        const sortedPlayers = playerArrayWithoutSpectators.sort((a, b) => b.score - a.score);
        const upperHalfCount = Math.ceil(sortedPlayers.length / 2);
        const cutoffScore = sortedPlayers[upperHalfCount - 1].score;

        // Split players based on scores, handling ties properly
        const upperHalf = sortedPlayers.filter(player => player.score >= cutoffScore);
        const lowerHalf = sortedPlayers.filter(player => player.score < cutoffScore);

        // Set players to spectator that were in the lower half
        const newPlayerArray = playerArray.map((i) => {
            if (lowerHalf.includes(i)) {
                sendEventToClient(i.userId, { type: 'tournament-eliminated' });
                return { ...i, spectator: true }
            }
            return i;
        });
        playSocketServer?.updateRoomStorage(roomId, "players", "set", newPlayerArray); // Update players array

        // Construct match results
        addTournamentMatchResults(tournamentId, playSocketServer.getRoomStorage(roomId).matchIndex, {
            ascendedPlayers: upperHalf,
            eliminatedPlayers: lowerHalf
        });

        // If the tournament is over (only 1 person left)
        if (upperHalf.length === 1) {
            const winner = upperHalf[0];

            const playersWithoutWinner = playerArray.filter((p) => p.userId !== winner.userId);
            playersWithoutWinner.forEach((i) => {
                sendEventToClient(i.userId, { type: 'tournament-winner-announced', winnerName: winner.username });
            });

            // Schedule room close
            playSocketServer.updateRoomStorage(roomId, "chats", "array-add", `System: Tournament over – room closing in 1 minute.`);
            endTournament(tournamentId, roomId, winner.userId, winner.username);

            // Give winner the prize
            const db = getDB();
            const [results] = await db.promise().execute(`SELECT prize FROM tournaments WHERE id = ?`, [tournamentId]);
            const prize = results[0]?.prize?.toLowerCase(); // Lowercase for safer comparisons
            let supporterTier = null;
            let tokenGain = null;

            // If the prize is a supporter tier, apply it
            if (prize?.includes("supporter")) {
                const tierNumberString = prize.replace("supporter tier", "");
                supporterTier = parseInt(tierNumberString);
                await db.promise().execute(
                    `UPDATE users SET supporter_level = ? WHERE id = ? AND (supporter_level IS NULL OR supporter_level < ?)`,
                    [supporterTier, winner.userId, supporterTier]
                );
            }

            // If the prize is a tokens, apply them
            if (prize?.includes("tokens")) {
                const tokensNumberString = prize.replace("tokens", "");
                tokenGain = parseInt(tokensNumberString);
                await db.promise().execute(
                    `UPDATE users SET tokens = COALESCE(tokens, 0) + ? WHERE id = ?`,
                    [tokenGain, winner.userId]
                );
            }

            // Send prize & announcement to winner
            sendEventToClient(winner.userId, { type: 'tournament-won', tokenGain, supporterTier });
        } else {
            // Start a new match
            playSocketServer.updateRoomStorage(roomId, "chats", "array-add", `System: Next match starting in 10s.`);
            setTimeout(() => {
                rematch(roomId);
            }, 10000);
        }

    } catch (error) {
        console.error("Error processing tournament match results:", error);
    }
}

async function endTournament(tournamentId, roomId, winnerId = null, winnerName = null) {
    await updateTournament(tournamentId, 'finished', winnerId, winnerName, null);
    setTimeout(() => {
        try {
            playSocketServer.destroyRoom(roomId);
        } catch (error) {
            console.error("Failed to destroy tournament room:", error);
        }
    }, 60 * 1000);
}

// matchData format: { ascendedPlayers: [{ username, userId, score }], eliminatedPlayers: [{ username, userId, score }] }
async function addTournamentMatchResults(tournamentId, matchIndex, matchData) {
    const db = getDB();
    let connection;

    try {
        connection = await db.promise().getConnection();
        await connection.beginTransaction();

        await connection.execute(
            'DELETE FROM tournament_match_results WHERE tournament_id = ? AND match_index = ?',
            [tournamentId, matchIndex]
        );

        const insertPromises = [];

        matchData.ascendedPlayers?.forEach(player => {
            insertPromises.push(
                connection.execute(
                    'INSERT INTO tournament_match_results (tournament_id, user_id, match_index, score, ascended, user_name) VALUES (?, ?, ?, ?, 1, ?)',
                    [tournamentId, player.userId, matchIndex, player.score, player.username]
                )
            );
        });

        matchData.eliminatedPlayers?.forEach(player => {
            insertPromises.push(
                connection.execute(
                    'INSERT INTO tournament_match_results (tournament_id, user_id, match_index, score, ascended, user_name) VALUES (?, ?, ?, ?, 0, ?)',
                    [tournamentId, player.userId, matchIndex, player.score, player.username]
                )
            );
        });

        await Promise.all(insertPromises);
        await connection.commit();

        broadcastEvent({ type: "tournament-updated" });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error adding tournament match result:', error);
        throw error;
    } finally {
        if (connection) connection.release();
    }
}

export default tournamentRouter;