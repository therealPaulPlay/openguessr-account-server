const { getDB } = require("./dbConnection");
const { sendEventToClient } = require("./serverSentEvents");

// Calculation ------------------------------------------------------------------------------------------------------------------------------------------------
const calculateEloChange = (winnerElo, loserElo) => {
    const K = 32;
    const eloDiff = Math.abs(winnerElo - loserElo);
    const expectedScore = 1 / (1 + Math.pow(10, (loserElo - winnerElo) / 400));

    // Ensure minimum gain of 1 unless difference is extreme (>1500)
    if (eloDiff > 1500) return 0;
    const change = Math.max(5, Math.min(30, Math.round(K * (1 - expectedScore))));
    return change;
};

// Helper function to process duel results --------------------------------------------------------------------------------------------------------------------
async function processDuelResult(uuid, leavingUserId) {
    leavingUserId = Number(leavingUserId);
    const db = getDB();
    let connection;

    try {
        connection = await db.promise().getConnection();
        await connection.beginTransaction();

        // Only allow processing duels that aren't already processed and haven't been deleted
        const [duels] = await connection.query(
            'SELECT * FROM duel_entries WHERE uuid = ? AND processed = 0 FOR UPDATE',
            [uuid]
        );

        if (duels.length) {
            let winner;
            let loser;

            if (!leavingUserId) {
                if (duels[0].user1_win === duels[0].user2_win) {
                    // Notify both players of the suspicious submission
                    [duels[0].user1_id, duels[0].user2_id].forEach(playerId => {
                        sendEventToClient(playerId, {
                            type: 'duel-result-error',
                            message: `Both players submitted the same result. Player 1's id: ${duels[0].user1_id}, Player 2's id: ${duels[0].user2_id}.`
                        });
                    });
                    throw new Error(`Both players submitted the same result. Player 1: ${duels[0].user1_id}, Player 2: ${duels[0].user2_id}`);
                }
                winner = duels[0].user1_win ? duels[0].user1_id : duels[0].user2_id;
                loser = duels[0].user1_win ? duels[0].user2_id : duels[0].user1_id;
            } else {
                // If leaver is provided, they'll be counted as the loser
                winner = duels[0].user1_id != leavingUserId ? duels[0].user1_id : duels[0].user2_id;
                loser = duels[0].user1_id == leavingUserId ? duels[0].user1_id : duels[0].user2_id;
                const isUser1 = winner == duels[0].user1_id;

                // Assign the winner status to the remaining player
                await connection.query(`UPDATE duel_entries SET ${isUser1 ? 'user1_win' : 'user2_win'} = 1 WHERE uuid = ?`, [uuid]);
            }

            // Get players and their elo
            const [players] = await connection.query(
                'SELECT id, user_name, elo FROM users WHERE id IN (?, ?) FOR UPDATE',
                [winner, loser]
            );
            if (players.length !== 2) throw new Error('One or both users not found');

            const winningPlayer = players.find(p => Number(p.id) === Number(winner));
            const losingPlayer = players.find(p => Number(p.id) === Number(loser));
            const eloChange = calculateEloChange(winningPlayer.elo, losingPlayer.elo);

            // Update duel entry with names using the uuid, and set processed = 1 (true)
            await connection.query(
                `UPDATE duel_entries SET 
                user1_name = CASE WHEN user1_id = ? THEN ? ELSE ? END,
                user2_name = CASE WHEN user2_id = ? THEN ? ELSE ? END,
                processed = 1
                WHERE uuid = ?`,
                [
                    winningPlayer.id, winningPlayer.user_name, losingPlayer.user_name,  // For user1_name
                    winningPlayer.id, winningPlayer.user_name, losingPlayer.user_name,  // For user2_name
                    uuid
                ]
            );

            // Update users' ELO (after setting processed)
            await connection.query(
                'UPDATE users SET elo = CASE ' +
                'WHEN id = ? THEN elo + ? ' +
                'WHEN id = ? THEN GREATEST(0, elo - ?) ' +
                'END WHERE id IN (?, ?)',
                [winningPlayer.id, eloChange, losingPlayer.id, eloChange, winningPlayer.id, losingPlayer.id]
            );

            // Send WebSocket notifications
            const eloChanges = { [winningPlayer.id]: eloChange, [losingPlayer.id]: -eloChange };
            const resultMessage = { type: 'duel-result', eloChanges, winnerId: winningPlayer.id };
            [winningPlayer.id, losingPlayer.id].forEach(playerId => { sendEventToClient(playerId, resultMessage); });
        }

        await connection.commit();

    } catch (error) {
        if (connection) await connection.rollback();
        console.error('Error processing duel result:', error);
        try {
            await db.promise().query('DELETE FROM duel_entries WHERE uuid = ?', [uuid]);
        } catch (error) {
            console.error("Error deleting broken duel entry:", error);
        }
    } finally {
        if (connection) connection.release();
    }
}

module.exports = processDuelResult;