import { getDB } from "./dbConnection.js";
import { updateProfileData } from "./profileDataHelper.js";
import { sendEventToClient } from "./serverSentEvents.js";

// Calculation function
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
export default async function saveDivisionDuelResult(uuid, winnerId, loserId, draw = false) {
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

            // Send WebSocket notifications (no ELO changes)
            const resultMessage = { type: 'duel-result', eloChanges: null, winnerId: null, tokenGain: null };
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

            // Send WebSocket notifications (brackets -> keys are the IDs)
            const eloChanges = { [winnerId]: eloChange, [loserId]: -eloChange };
            const resultMessage = { type: 'duel-result', eloChanges, winnerId, tokenGain };
            [winnerId, loserId].forEach(playerId => sendEventToClient(playerId, resultMessage));
        }

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error saving duel result:', error);
    } finally {
        if (connection) connection.release();
    }
}