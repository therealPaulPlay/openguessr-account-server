const { getDB } = require("./dbConnection");
const { updateProfileData } = require("./profileDataHelper");
const { sendEventToClient } = require("./serverSentEvents");

// Calculation function
const calculateEloChange = (winnerElo, loserElo) => {
    const K = 32;
    const expectedScore = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 600)); // Standard elo uses 400 – we use 600 to make the fall-off a bit longer

    // Ensure minimum gain of 3
    let change = Math.max(3, Math.min(30, Math.round(K * (1 - expectedScore))));
    if (loserElo == 0) change = 0; // Prevent alt-account farming
    return change;
};

// Save duel result with winner/loser IDs
async function saveDuelResult(uuid, winnerId, loserId, draw = false) {
    winnerId = Number(winnerId);
    loserId = Number(loserId);

    const db = getDB();
    let connection;

    try {
        connection = await db.promise().getConnection();
        await connection.beginTransaction();

        // Get players and their elo
        const [players] = await connection.query(
            'SELECT id, user_name, elo FROM users WHERE id IN (?, ?) FOR UPDATE',
            [winnerId, loserId]
        );
        if (players.length !== 2) throw new Error('One or both users not found!');

        const player1 = players.find(p => Number(p.id) === winnerId);
        const player2 = players.find(p => Number(p.id) === loserId);

        if (draw) {
            // Insert draw result into history
            await connection.query(
                `INSERT INTO duel_entries (uuid, user1_id, user2_id, user1_name, user2_name, user1_win, user2_win, processed)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                [
                    uuid,
                    winnerId, loserId,
                    player1.user_name, player2.user_name,
                    0, 0, // both false for draw
                    1 // processed true
                ]
            );

            // Reset win streaks for both players
            updateProfileData(winnerId, "current_duel_win_streak", false, 0);
            updateProfileData(loserId, "current_duel_win_streak", false, 0);

            await connection.commit();

        } else {
            const winningPlayer = player1;
            const losingPlayer = player2;
            const eloChange = calculateEloChange(winningPlayer.elo, losingPlayer.elo);

            // Insert win/loss result into history
            await connection.query(
                `INSERT INTO duel_entries (uuid, user1_id, user2_id, user1_name, user2_name, user1_win, user2_win, processed)
                 VALUES (?, ?, ?, ?, ?, ?, ?, 1)`,
                [
                    uuid,
                    winnerId, loserId,
                    winningPlayer.user_name, losingPlayer.user_name,
                    1, 0, // winner wins, loser loses
                    1 // processed true
                ]
            );

            // Update users' ELO
            await connection.query(
                'UPDATE users SET elo = CASE ' +
                'WHEN id = ? THEN elo + ? ' +
                'WHEN id = ? THEN GREATEST(0, elo - ?) ' +
                'END WHERE id IN (?, ?)',
                [winnerId, eloChange, loserId, eloChange, winnerId, loserId]
            );

            // Update stats
            updateProfileData(winnerId, "duels_won", true, 1);
            updateProfileData(loserId, "duels_lost", true, 1);

            // Update win streak
            updateProfileData(winnerId, "current_duel_win_streak", true, 1);
            updateProfileData(loserId, "current_duel_win_streak", false, 0);

            await connection.commit();

            // Send WebSocket notifications
            const eloChanges = { [winnerId]: eloChange, [loserId]: -eloChange };
            const resultMessage = { type: 'duel-result', eloChanges, winnerId };
            [winnerId, loserId].forEach(playerId => sendEventToClient(playerId, resultMessage));
        }

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error saving duel result:', error);
    } finally {
        if (connection) connection.release();
    }
}

module.exports = saveDuelResult;