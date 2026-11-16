import { getDB } from "./dbConnection.js";
import { updateProfileData } from "./dbWriteHelpers.js";
import { sendEventToClient } from "./serverSentEvents.js";
import { playSocketServer } from "./playSocketEvents.js";

// Process the result once a division duel game ended
export function processDivisionDuelMatchResults(roomId) {
    playSocketServer.updateRoomStorage(roomId, "divisionDuelProcessed", "set", true);

    const sortedPlayers = playSocketServer.getRoomStorage(roomId).players.sort((a, b) => b.score - a.score || a.disconnected - b.disconnected); // Ties go to connected players
    const winner = sortedPlayers[0];
    const loser = sortedPlayers[1];
    const isDraw = winner?.score == loser?.score && winner?.disconnected == loser?.disconnected;
    if (winner && loser) saveDivisionDuelResult(playSocketServer.getRoomStorage(roomId).duelUuid, winner.userId, loser.userId, isDraw);
}

// Process the result once a division duel player left or didn't return within 30s
export function processDivisionDuelAbandon(roomId, abandoningUserId) {
    playSocketServer.updateRoomStorage(roomId, "divisionDuelProcessed", "set", true);

    // The opponent wins (even if they are also disconnected since whoever disconnects first loses)
    const winner = playSocketServer.getRoomStorage(roomId).players.find((p) => p.userId !== abandoningUserId);
    if (winner) saveDivisionDuelResult(playSocketServer.getRoomStorage(roomId).duelUuid, winner.userId, abandoningUserId, false, true); // Missing if a player left before their user data was fetched (nothing was persisted then)
}

// Elo util
const calculateEloChange = (winnerElo, loserElo) => {
    const K = 32;
    const expectedScore = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 600)); // Standard elo uses 400 – we use 600 to make the fall-off a bit longer

    // Ensure minimum gain of 3
    let change = Math.max(3, Math.min(30, Math.round(K * (1 - expectedScore))));
    if (loserElo == 0) change = 0; // Prevent alt-account farming
    return change;
};

// Get random token amount (5-10)
function randomTokenGain() {
    return 5 + Math.round(Math.random() * 5);
}

// Save division duel result with winner/loser IDs
async function saveDivisionDuelResult(uuid, winnerId, loserId, draw = false, abandoned = false) {
    winnerId = Number(winnerId);
    loserId = Number(loserId);

    const db = getDB();
    let connection;

    try {
        connection = await db.promise().getConnection();
        await connection.beginTransaction();

        // Check if duel already exists
        const [existing] = await connection.query('SELECT uuid FROM duel_entries WHERE uuid = ?', [uuid]);
        if (existing.length > 0) throw new Error(`Duel ${uuid} already saved!`);

        // Get players and their elo
        const [players] = await connection.query(
            `SELECT u.id, u.user_name, u.elo, GREATEST(COALESCE(p.highest_elo, 0), 1000) AS highest_elo
             FROM users u
             LEFT JOIN profile_data p ON p.user_id = u.id
             WHERE u.id IN (?, ?) FOR UPDATE`,
            [winnerId, loserId]
        );
        if (players.length !== 2) throw new Error('One or both users not found, or users identical!');

        const winningPlayer = players.find(p => Number(p.id) === winnerId);
        const losingPlayer = players.find(p => Number(p.id) === loserId);

        if (draw) {
            // Insert draw result into history
            await connection.query(
                `INSERT INTO duel_entries (uuid, user1_id, user2_id, user1_name, user2_name, user1_win, user2_win)
                 VALUES (?, ?, ?, ?, ?, ?, ?)`,
                [
                    uuid,
                    winnerId, loserId,
                    winningPlayer.user_name, losingPlayer.user_name,
                    0, 0 // both false for draw
                ]
            );

            // Reset win streaks for both players
            updateProfileData(winnerId, "current_duel_win_streak", false, 0);
            updateProfileData(loserId, "current_duel_win_streak", false, 0);

            await connection.commit();

            // Send SSE notifications (no ELO changes)
            const resultMessage = { type: 'duel-result', duelUuid: uuid, eloChanges: null, winnerId: null, tokenGain: null };
            [winnerId, loserId].forEach(playerId => sendEventToClient(playerId, resultMessage));


        } else {
            const eloChange = calculateEloChange(winningPlayer.elo, losingPlayer.elo);
            const tokenGain = randomTokenGain();

            // Insert win/loss result into history
            await connection.query(
                `INSERT INTO duel_entries (uuid, user1_id, user2_id, user1_name, user2_name, user1_win, user2_win, elo_change)
                 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                [
                    uuid,
                    winnerId, loserId,
                    winningPlayer.user_name, losingPlayer.user_name,
                    1, 0, eloChange // winner wins, loser loses
                ]
            );

            // Update users' ELO and tokens
            await connection.query(
                `UPDATE users SET 
                 elo = CASE 
                     WHEN id = ? THEN elo + ? 
                     WHEN id = ? THEN GREATEST(0, elo - ?) 
                 END, 
                 tokens = CASE 
                     WHEN id = ? THEN tokens + ? 
                     ELSE tokens 
                 END 
                 WHERE id IN (?, ?)`,
                [winnerId, eloChange, loserId, eloChange, winnerId, tokenGain, winnerId, loserId]
            );

            // Update duel W/L stat
            updateProfileData(winnerId, "duels_won", true, 1);
            updateProfileData(loserId, "duels_lost", true, 1);

            // Update win streak
            updateProfileData(winnerId, "current_duel_win_streak", true, 1);
            updateProfileData(loserId, "current_duel_win_streak", false, 0);

            // Update highest elo for winning player if applicable
            if (winningPlayer.elo + eloChange > winningPlayer.highest_elo) {
                updateProfileData(winnerId, "highest_elo", false, winningPlayer.elo + eloChange);
            }

            await connection.commit();

            // Send SSE notifications (brackets -> keys are the IDs)
            const eloChanges = { [winnerId]: eloChange, [loserId]: -eloChange };
            const resultMessage = { type: 'duel-result', duelUuid: uuid, abandoned, eloChanges, winnerId, tokenGain };
            [winnerId, loserId].forEach(playerId => sendEventToClient(playerId, resultMessage));
        }

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error saving duel result:', error);
    } finally {
        if (connection) connection.release();
    }
}

export async function processEloRefunds(bannedPlayerId) {
    const db = getDB();
    let connection;

    try {
        // Wrap in transaction to avoid two of these calls running simultaneously refunding twice etc. (for atomicy)
        connection = await db.promise().getConnection();
        await connection.beginTransaction();

        // First, get all matches from the duel division entries that this player won
        // Duel division history is only kept for 4-8 weeks, so not all elo will be refunded, only recent games
        const [results] = await connection.execute("SELECT * FROM duel_entries WHERE refunded = FALSE AND ((user1_id = ? AND user1_win = TRUE) OR (user2_id = ? AND user2_win = TRUE)) FOR UPDATE", [bannedPlayerId, bannedPlayerId]);

        // Player did not play any division games recently
        if (results.length === 0) {
            await connection.commit();
            return;
        }

        const usersWithEloRefunds = new Map();
        let totalRefundedElo = 0;

        results.forEach((entry) => {
            const eloChange = entry.elo_change;
            const loserId = entry.user1_id === bannedPlayerId ? entry.user2_id : entry.user1_id;

            if (eloChange > 0) {
                totalRefundedElo += eloChange;
                usersWithEloRefunds.set(loserId, (usersWithEloRefunds.get(loserId) || 0) + eloChange);
            }
        });

        // Mark all won entries as refunded in one query
        await connection.execute("UPDATE duel_entries SET refunded = TRUE WHERE refunded = FALSE AND ((user1_id = ? AND user1_win = TRUE) OR (user2_id = ? AND user2_win = TRUE))", [bannedPlayerId, bannedPlayerId]);

        if (usersWithEloRefunds.size > 0) {
            const userIds = [...usersWithEloRefunds.keys()];
            const params = [];
            const caseClauses = userIds.map(id => { params.push(id, usersWithEloRefunds.get(id)); return "WHEN id = ? THEN elo + ?"; }).join(" ");
            const inPlaceholders = userIds.map(() => "?").join(",");
            params.push(...userIds);
            await connection.query(`UPDATE users SET elo = CASE ${caseClauses} ELSE elo END WHERE id IN (${inPlaceholders})`, params);
        }

        // Lower the banned player's elo but keep floor at 1000
        const [[bannedPlayer]] = await connection.execute("SELECT elo FROM users WHERE id = ? FOR UPDATE", [bannedPlayerId]);

        const uncappedNewElo = (bannedPlayer?.elo ?? 0) - totalRefundedElo;
        let deductedElo;

        // Examples:
        // 1200 elo, we refund 300 -> new uncapped elo is 900, elo below 1000 is 100, we only deduct 200
        // 200 elo, we refund 500 -> new uncapped elo is -300, elo below 1000 is 1300, we deduct 0 (since 500 minus 1300 is -800)
        // 400 elo, we refund 2000 -> new uncapped elo is -1600, elo below 1000 is 2600, we deduct 0
        if (uncappedNewElo < 1000) {
            const eloBelow1000 = 1000 - uncappedNewElo;
            deductedElo = Math.max(0, totalRefundedElo - eloBelow1000);
        } else deductedElo = totalRefundedElo;

        if (deductedElo > 0) await connection.execute("UPDATE users SET elo = elo - ? WHERE id = ?", [deductedElo, bannedPlayerId]);

        await connection.commit();

        // Send SSE notifications
        usersWithEloRefunds.forEach((value, userId) => {
            sendEventToClient(userId, { type: "elo-refunded", amount: value });
        });

        // Inform banned user too
        if (deductedElo > 0) sendEventToClient(bannedPlayerId, { type: "elo-deducted", amount: deductedElo });

    } catch (error) {
        if (connection) await connection.rollback();
        console.error("Error processing elo refunds:", error);
    } finally {
        if (connection) connection.release();
    }
}
