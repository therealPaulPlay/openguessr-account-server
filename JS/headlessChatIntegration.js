import express from 'express';
import jwt from 'jsonwebtoken';
import { censor } from 'fast-profanity-filter';
import { Server } from 'headless-chat/server';
import { jwtSecret, oldJwtSecret } from './config.js';
import { getDB } from './dbConnection.js';
import { sendEventToClient } from './serverSentEvents.js';
import { standardLimiter } from './rateLimiters.js';
import { fetchReportData } from './reportFetch.js';
import { authenticateTokenWithId } from './authUtils.js';

const headlessChatRouter = express.Router();

export default headlessChatRouter;

// SSE channel as the server -> client transport, keyed by userId
function dispatch(participantId, data) {
    sendEventToClient(participantId, { type: 'headless-chat', data });
}

export const headlessChatServer = new Server(dispatch, {
    conversationLimitPerParticipant: 50,
    inviteLimitPerParticipant: 20,
}, {
    messageAfterDays: 60, // Cleanup options
    inviteAfterDays: 7,
});

// Single endpoint for client -> server, the body is the protocol envelope from headless-chat's Client
headlessChatRouter.post('/receive', standardLimiter, async (req, res) => {
    try { await headlessChatServer.receive(req.body); }
    catch (error) { console.error('headless-chat receive error:', error); }
    res.sendStatus(202);
});

// Atomic open-or-create for a 1-1 conversation, dedups across concurrent clicks
headlessChatRouter.post('/conversation-with-user', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const userId = String(req.body.id);
    const targetParticipantId = String(req.body.targetParticipantId ?? '');
    if (!targetParticipantId || targetParticipantId === userId) return res.status(400).json({ error: "Target participant is required!" });

    try {
        let pendingInvites = [];

        // Get connection (if getting the connection fails, there's nothing to release)
        const conn = await getDB().promise().getConnection();

        try {
            await conn.beginTransaction();

            // Serialize concurrent calls for the same pair by locking the two user rows in a deterministic order
            // Numeric sort to match the SQL ORDER BY id on the BIGINT column, default Array.sort lexical order would deadlock against the SQL's numeric sort
            const [a, b] = [userId, targetParticipantId].sort((x, y) => Number(x) - Number(y));
            await conn.query(`SELECT id FROM users WHERE id IN (?, ?) ORDER BY id FOR UPDATE`, [a, b]);

            // Existing 1-1 conversation containing both participants
            const [existingConv] = await conn.query(
                `SELECT c.conversation_id FROM hc_conversations c
             WHERE c.max_size = 2
               AND EXISTS (SELECT 1 FROM hc_conversation_participants WHERE conversation_id = c.conversation_id AND participant_id = ?)
               AND EXISTS (SELECT 1 FROM hc_conversation_participants WHERE conversation_id = c.conversation_id AND participant_id = ?)
             LIMIT 1`,
                [userId, targetParticipantId],
            );

            // There's an existing conversation with both users in it, return it
            if (existingConv.length > 0) {
                await conn.commit();
                return res.json({ conversationId: existingConv[0].conversation_id });
            }

            // Pending invite either direction for a 1-1 conversation (maximum size 2) that still has room for the invitee
            // Ordered in a way that prefers an incoming invite (since that can be auto-accepted, and there might be both an outgoing and icoming one)
            [pendingInvites] = await conn.query(
                `SELECT i.conversation_id, i.from_participant_id
             FROM hc_invites i
             JOIN hc_conversations c ON c.conversation_id = i.conversation_id
             WHERE c.max_size = 2
               AND ((i.from_participant_id = ? AND i.to_participant_id = ?) OR (i.from_participant_id = ? AND i.to_participant_id = ?))
               AND (SELECT COUNT(*) FROM hc_conversation_participants WHERE conversation_id = c.conversation_id) = 1
            ORDER BY (i.from_participant_id = ?) DESC
             LIMIT 1`,
                [userId, targetParticipantId, targetParticipantId, userId, targetParticipantId],
            );

            await conn.commit();

        } catch (error) {
            await conn.rollback();
            throw error;
        } finally {
            conn.release();
        }

        // There is one invite that can be accepted
        if (pendingInvites.length > 0) {
            const invite = pendingInvites[0];

            // Incoming invite, accept on behalf of the user
            if (invite.from_participant_id !== userId) {
                await headlessChatServer.acceptInvite(invite.conversation_id, userId);
                return res.json({ conversationId: invite.conversation_id });
            }

            // Outgoing invite, auto-accept if friends
            if (await areFriends(userId, targetParticipantId)) await headlessChatServer.acceptInvite(invite.conversation_id, targetParticipantId);
            return res.json({ conversationId: invite.conversation_id });
        }

        // Create fresh and invite
        // Auto-accept on the inviter's behalf via admin acceptInvite when both are friends
        const conversationId = await headlessChatServer.createConversation(userId, 2);
        await headlessChatServer.createInvite(conversationId, userId, targetParticipantId);
        if (await areFriends(userId, targetParticipantId)) await headlessChatServer.acceptInvite(conversationId, targetParticipantId);

        return res.json({ conversationId });
    } catch (error) {
        console.error('Error creating conversation with user:', error);
        return res.status(500).json({ error: 'Internal error!' });
    }
});

// Auth + profanity ----------------------------------------------------------
headlessChatServer.onParticipantAuth(async (participantId, authData) => {
    if (typeof authData !== 'string') return false;
    try {
        // TODO 30 days after November 26th, remove support for old secret
        let decoded;
        try {
            decoded = jwt.verify(authData, jwtSecret);
        } catch { decoded = jwt.verify(authData, oldJwtSecret); }
        if (decoded?.userId == null) throw new Error("Token lacks user ID");
        return String(decoded?.userId) === String(participantId);
    } catch { return false; }
});

// Censor profanity
headlessChatServer.onProfanityCheckCensor(async (text) => censor(text));

// Friend check helper, mirrors the bidirectional rows in the friends table
async function areFriends(a, b) {
    const [rows] = await getDB().promise().execute(
        `SELECT 1 FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?) LIMIT 1`,
        [a, b, b, a],
    );
    return rows.length > 0;
}

// Friends can always invite each other, non-friends are gated on the inviter's ban status
headlessChatServer.onInviteAuth(async (fromParticipantId, toParticipantId) => {
    if (await areFriends(fromParticipantId, toParticipantId)) return true;
    const banStatus = await fetchReportData("blacklist", "user", "user-" + fromParticipantId);
    return !banStatus?.listed;
});

// Conversations -------------------------------------------------------------
// hc_conversations holds the conversation row, hc_conversation_participants is the junction table
const CONVERSATION_SELECT = `
    SELECT c.conversation_id, c.created_at, c.last_activity_at, c.max_size,
           (SELECT JSON_ARRAYAGG(participant_id) FROM hc_conversation_participants WHERE conversation_id = c.conversation_id) AS participants,
           m.message_id, m.message, m.participant_id AS m_participant_id, m.deleted,
           m.reference_message_id, m.is_forwarded, m.system_event_type, m.system_event_participant_id,
           m.created_at AS m_created_at, m.modified_at AS m_modified_at
    FROM hc_conversations c
    LEFT JOIN LATERAL (
        SELECT * FROM hc_messages WHERE conversation_id = c.conversation_id
        ORDER BY created_at DESC, message_id DESC LIMIT 1
    ) m ON TRUE`;

headlessChatServer.onCreateConversation(async (record, creatorParticipantId, conversationLimitPerParticipant) => {
    const conn = await getDB().promise().getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute(
            `INSERT INTO hc_conversations (conversation_id, created_at, last_activity_at, max_size) VALUES (?, ?, ?, ?)`,
            [record.conversationId, record.createdAt, record.lastActivityAt, record.maxSize],
        );
        // Conditional INSERT enforces user-existence and the per-participant cap atomically, rollback discards the just-inserted conversation on failure
        const [result] = await conn.execute(
            `INSERT INTO hc_conversation_participants (conversation_id, participant_id)
             SELECT ?, ? WHERE EXISTS (SELECT 1 FROM users WHERE id = ?)
               AND (SELECT COUNT(*) FROM hc_conversation_participants WHERE participant_id = ?) < ?`,
            [record.conversationId, String(creatorParticipantId), String(creatorParticipantId), String(creatorParticipantId), conversationLimitPerParticipant],
        );
        if (result.affectedRows === 0) throw new Error("Per-participant conversation limit exceeded");
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
});

headlessChatServer.onReadConversation(async (conversationId) => {
    const [rows] = await getDB().promise().execute(CONVERSATION_SELECT + ` WHERE c.conversation_id = ?`, [conversationId]);
    if (rows.length === 0) return null;
    return rowToConversation(rows[0], await reactionsForLastMessage(rows));
});

headlessChatServer.onReadConversations(async (participantId) => {
    const [rows] = await getDB().promise().execute(
        CONVERSATION_SELECT +
        ` WHERE EXISTS (SELECT 1 FROM hc_conversation_participants WHERE conversation_id = c.conversation_id AND participant_id = ?)
         ORDER BY c.last_activity_at DESC`,
        [String(participantId)],
    );
    const reactions = await reactionsForLastMessage(rows);
    return rows.map(row => rowToConversation(row, reactions));
});

// Atomic add: insert only if the conversation has room, the participant isn't already in it, and the participant is below the per-participant conversation cap
headlessChatServer.onCreateConversationParticipant(async (conversationId, participantId, conversationParticipantLimit, conversationLimitPerParticipant) => {
    const [result] = await getDB().promise().execute(
        `INSERT INTO hc_conversation_participants (conversation_id, participant_id)
         SELECT ?, ?
         WHERE (SELECT COUNT(*) FROM hc_conversation_participants WHERE conversation_id = ?) < ?
           AND (SELECT COUNT(*) FROM hc_conversation_participants WHERE participant_id = ?) < ?
           AND NOT EXISTS (SELECT 1 FROM hc_conversation_participants WHERE conversation_id = ? AND participant_id = ?)`,
        [
            conversationId, String(participantId),
            conversationId, conversationParticipantLimit,
            String(participantId), conversationLimitPerParticipant,
            conversationId, String(participantId),
        ],
    );
    if (result.affectedRows === 0) throw new Error('Conversation full, participant at conversation limit, or already a participant');
});

headlessChatServer.onDeleteConversationParticipantAndParticipantActivity(async (conversationId, participantId) => {
    const conn = await getDB().promise().getConnection();
    try {
        await conn.beginTransaction();
        await conn.execute(
            `DELETE FROM hc_conversation_participants WHERE conversation_id = ? AND participant_id = ?`,
            [conversationId, String(participantId)],
        );
        await conn.execute(
            `DELETE FROM hc_participant_activities WHERE conversation_id = ? AND participant_id = ?`,
            [conversationId, String(participantId)],
        );
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
});

headlessChatServer.onDeleteAllConversationParticipantsAndParticipantActivitiesForParticipant(async (participantId) => {
    const pid = String(participantId);
    const conn = await getDB().promise().getConnection();
    try {
        await conn.beginTransaction();

        // Lock the participant's own seats first so the conversation set is fixed for this transaction
        const [seatRows] = await conn.execute(
            `SELECT conversation_id FROM hc_conversation_participants WHERE participant_id = ? FOR UPDATE`,
            [pid],
        );
        const involvedIds = seatRows.map(r => String(r.conversation_id));
        if (involvedIds.length === 0) {
            await conn.commit();
            return { deletedConversations: [], remainingConversations: [] };
        }

        // Lock every other participant row in those conversations so a concurrent leave can't shift the counts under us
        const involvedPlaceholders = involvedIds.map(() => '?').join(',');
        const [allRows] = await conn.query(
            `SELECT conversation_id FROM hc_conversation_participants WHERE conversation_id IN (${involvedPlaceholders}) FOR UPDATE`,
            involvedIds,
        );
        const counts = new Map();
        for (const row of allRows) counts.set(String(row.conversation_id), (counts.get(String(row.conversation_id)) ?? 0) + 1);
        const toDelete = involvedIds.filter(cid => (counts.get(cid) ?? 0) <= 1);
        const toKeep = involvedIds.filter(cid => (counts.get(cid) ?? 0) > 1);

        const deletedConversations = [];
        if (toDelete.length > 0) {
            const placeholders = toDelete.map(() => '?').join(',');
            const [inviteRows] = await conn.execute(
                `SELECT conversation_id, from_participant_id, to_participant_id FROM hc_invites WHERE conversation_id IN (${placeholders}) FOR UPDATE`,
                toDelete,
            );
            for (const cid of toDelete) {
                deletedConversations.push({
                    conversationId: cid,
                    formerParticipantIds: [pid],
                    deletedInvites: inviteRows.filter(r => String(r.conversation_id) === cid).map(r => ({ fromParticipantId: String(r.from_participant_id), toParticipantId: String(r.to_participant_id) })),
                });
            }
            await conn.query(`DELETE r FROM hc_reactions r JOIN hc_messages m ON r.message_id = m.message_id WHERE m.conversation_id IN (${placeholders})`, toDelete);
            await conn.query(`DELETE FROM hc_messages WHERE conversation_id IN (${placeholders})`, toDelete);
            await conn.query(`DELETE FROM hc_invites WHERE conversation_id IN (${placeholders})`, toDelete);
            await conn.query(`DELETE FROM hc_participant_activities WHERE conversation_id IN (${placeholders})`, toDelete);
            await conn.query(`DELETE FROM hc_conversation_participants WHERE conversation_id IN (${placeholders})`, toDelete);
            await conn.query(`DELETE FROM hc_conversations WHERE conversation_id IN (${placeholders})`, toDelete);
        }

        const remainingConversations = [];
        if (toKeep.length > 0) {
            const placeholders = toKeep.map(() => '?').join(',');
            await conn.query(`DELETE FROM hc_conversation_participants WHERE participant_id = ? AND conversation_id IN (${placeholders})`, [pid, ...toKeep]);
            await conn.query(`DELETE FROM hc_participant_activities WHERE participant_id = ? AND conversation_id IN (${placeholders})`, [pid, ...toKeep]);
            const [convRows] = await conn.query(CONVERSATION_SELECT + ` WHERE c.conversation_id IN (${placeholders})`, toKeep);
            const reactions = await reactionsForLastMessage(convRows);
            for (const row of convRows) {
                const conv = rowToConversation(row, reactions);
                remainingConversations.push({
                    conversationId: conv.conversationId,
                    conversationRecord: { conversationId: conv.conversationId, createdAt: conv.createdAt, lastActivityAt: conv.lastActivityAt, maxSize: conv.maxSize },
                    remainingParticipantIds: conv.participantIds,
                    lastMessage: conv.lastMessage,
                });
            }
        }

        await conn.commit();
        return { deletedConversations, remainingConversations };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
});

headlessChatServer.onDeleteConversationWithMessagesReactionsInvitesAndActivities(async (conversationId) => {
    const conn = await getDB().promise().getConnection();
    try {
        await conn.beginTransaction();

        const [inviteRows] = await conn.execute(
            `SELECT from_participant_id, to_participant_id FROM hc_invites WHERE conversation_id = ? FOR UPDATE`,
            [conversationId],
        );
        const deletedInvites = inviteRows.map(r => ({ fromParticipantId: String(r.from_participant_id), toParticipantId: String(r.to_participant_id) }));

        await conn.execute(
            `DELETE r FROM hc_reactions r JOIN hc_messages m ON r.message_id = m.message_id WHERE m.conversation_id = ?`,
            [conversationId],
        );
        await conn.execute(`DELETE FROM hc_messages WHERE conversation_id = ?`, [conversationId]);
        await conn.execute(`DELETE FROM hc_invites WHERE conversation_id = ?`, [conversationId]);
        await conn.execute(`DELETE FROM hc_participant_activities WHERE conversation_id = ?`, [conversationId]);
        await conn.execute(`DELETE FROM hc_conversation_participants WHERE conversation_id = ?`, [conversationId]);
        await conn.execute(`DELETE FROM hc_conversations WHERE conversation_id = ?`, [conversationId]);

        await conn.commit();
        return { deletedInvites };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
});

headlessChatServer.onDeleteConversationsWithMessagesReactionsInvitesAndActivitiesBefore(async (thresholdDate) => {
    const conn = await getDB().promise().getConnection();
    try {
        await conn.beginTransaction();

        const [conversationRows] = await conn.execute(
            `SELECT conversation_id FROM hc_conversations WHERE last_activity_at < ? FOR UPDATE`,
            [thresholdDate],
        );
        const conversationIds = conversationRows.map(r => String(r.conversation_id));

        if (conversationIds.length === 0) {
            await conn.commit();
            return { deletedConversations: [] };
        }

        const placeholders = conversationIds.map(() => '?').join(',');
        const [participantRows] = await conn.execute(
            `SELECT conversation_id, participant_id FROM hc_conversation_participants WHERE conversation_id IN (${placeholders}) FOR UPDATE`,
            conversationIds,
        );
        const [inviteRows] = await conn.execute(
            `SELECT conversation_id, from_participant_id, to_participant_id FROM hc_invites WHERE conversation_id IN (${placeholders}) FOR UPDATE`,
            conversationIds,
        );

        const deletedConversations = conversationIds.map(conversationId => ({
            conversationId,
            formerParticipantIds: participantRows
                .filter(r => String(r.conversation_id) === conversationId)
                .map(r => String(r.participant_id)),
            deletedInvites: inviteRows
                .filter(r => String(r.conversation_id) === conversationId)
                .map(r => ({ fromParticipantId: String(r.from_participant_id), toParticipantId: String(r.to_participant_id) })),
        }));

        await conn.execute(
            `DELETE r FROM hc_reactions r JOIN hc_messages m ON r.message_id = m.message_id WHERE m.conversation_id IN (${placeholders})`,
            conversationIds,
        );
        await conn.execute(`DELETE FROM hc_messages WHERE conversation_id IN (${placeholders})`, conversationIds);
        await conn.execute(`DELETE FROM hc_invites WHERE conversation_id IN (${placeholders})`, conversationIds);
        await conn.execute(`DELETE FROM hc_participant_activities WHERE conversation_id IN (${placeholders})`, conversationIds);
        await conn.execute(`DELETE FROM hc_conversation_participants WHERE conversation_id IN (${placeholders})`, conversationIds);
        await conn.execute(`DELETE FROM hc_conversations WHERE conversation_id IN (${placeholders})`, conversationIds);

        await conn.commit();
        return { deletedConversations };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
});

// Messages ------------------------------------------------------------------
headlessChatServer.onCreateMessage(async (message) => {
    const conn = await getDB().promise().getConnection();
    try {
        await conn.beginTransaction();

        // Insert only if the sender is a participant or is the reserved "server" sentinel for system messages
        const [result] = await conn.execute(
            `INSERT INTO hc_messages
             (message_id, conversation_id, message, reference_message_id, is_forwarded, participant_id, deleted,
              system_event_type, system_event_participant_id, created_at, modified_at)
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL
             WHERE ? = 'server' OR EXISTS (SELECT 1 FROM hc_conversation_participants WHERE conversation_id = ? AND participant_id = ?)`,
            [
                message.messageId, message.conversationId, message.message,
                message.messageOptions.referenceMessageId, message.messageOptions.isForwarded ? 1 : 0,
                message.participantId, message.deleted ? 1 : 0,
                message.systemEvent?.type ?? null, message.systemEvent?.participantId ?? null,
                message.createdAt,
                String(message.participantId),
                message.conversationId, String(message.participantId),
            ],
        );
        if (result.affectedRows === 0) throw new Error('Not a participant of this conversation');

        // last_activity_at tracks message creation, GREATEST guards against backdated system messages regressing it
        await conn.execute(`UPDATE hc_conversations SET last_activity_at = GREATEST(last_activity_at, ?) WHERE conversation_id = ?`, [message.createdAt, message.conversationId]);
        await conn.commit();
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
});

// Bulk-insert "messagesRemoved" system messages, skip per-conversation if the current oldest message is already one
headlessChatServer.onCreateMessagesSystemRemoved(async (messages) => {
    if (messages.length === 0) return { oldestMessagesByConversationId: new Map(), updatedParticipantActivities: [] };
    const conversationIds = messages.map(m => m.conversationId);
    const placeholders = conversationIds.map(() => '?').join(',');

    const conn = await getDB().promise().getConnection();
    try {
        await conn.beginTransaction();

        // Find each conversation's existing oldest "messagesRemoved" system message, those conversations get skipped (dedup) and their existing system message is what we return as the resulting oldest
        // Outer alias m is needed so the subquery's correlation references the outer row, not its own
        const [skipRows] = await conn.query(
            `SELECT m.* FROM hc_messages m
             WHERE m.conversation_id IN (${placeholders}) AND m.system_event_type = 'messagesRemoved'
               AND m.created_at = (SELECT MIN(created_at) FROM hc_messages WHERE conversation_id = m.conversation_id)
             FOR UPDATE`,
            conversationIds,
        );
        const skipByConversationId = new Map(skipRows.map(r => [String(r.conversation_id), rowToMessage(r)]));
        const toInsert = messages.filter(m => !skipByConversationId.has(m.conversationId));

        if (toInsert.length > 0) {
            const valuesPlaceholders = toInsert.map(() => '(?, ?, ?, NULL, 0, ?, 0, ?, NULL, ?, NULL)').join(', ');
            const flat = toInsert.flatMap(m => [m.messageId, m.conversationId, m.message, m.participantId, m.systemEvent.type, m.createdAt]);
            await conn.query(
                `INSERT INTO hc_messages (message_id, conversation_id, message, reference_message_id, is_forwarded, participant_id, deleted, system_event_type, system_event_participant_id, created_at, modified_at) VALUES ${valuesPlaceholders}`,
                flat,
            );
        }

        // For every input conversationId, the resulting oldest system message: the pre-existing one (if dedup-skipped) or the one we just inserted
        const oldestMessagesByConversationId = new Map();
        for (const message of messages) {
            const existing = skipByConversationId.get(message.conversationId);
            oldestMessagesByConversationId.set(message.conversationId, existing ?? message);
        }

        // Clamp older participant activities onto the resulting oldest so the backdated marker never counts as unread, return the updated rows
        const updatedParticipantActivities = [];
        for (const [conversationId, oldest] of oldestMessagesByConversationId) {
            const [staleRows] = await conn.execute(
                `SELECT participant_id FROM hc_participant_activities WHERE conversation_id = ? AND last_read_message_created_at < ? FOR UPDATE`,
                [conversationId, oldest.createdAt],
            );
            if (staleRows.length === 0) continue;
            await conn.execute(
                `UPDATE hc_participant_activities SET last_read_message_id = ?, last_read_message_created_at = ? WHERE conversation_id = ? AND last_read_message_created_at < ?`,
                [oldest.messageId, oldest.createdAt, conversationId, oldest.createdAt],
            );
            for (const row of staleRows) {
                updatedParticipantActivities.push({ conversationId, participantId: String(row.participant_id), lastReadMessageId: oldest.messageId, lastReadMessageCreatedAt: oldest.createdAt });
            }
        }

        await conn.commit();
        return { oldestMessagesByConversationId, updatedParticipantActivities };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
});

headlessChatServer.onUpdateMessage(async (message) => {
    // Message options (referenceMessageId, isForwarded) are set at creation and immutable, hence no need to implement
    await getDB().promise().execute(
        `UPDATE hc_messages
         SET message = ?, deleted = ?, modified_at = ?
         WHERE message_id = ?`,
        [message.message, message.deleted ? 1 : 0, message.modifiedAt, message.messageId],
    );
});

headlessChatServer.onReadMessage(async (messageId) => {
    const [rows] = await getDB().promise().execute(`SELECT * FROM hc_messages WHERE message_id = ?`, [messageId]);
    if (rows.length === 0) return null;
    const message = rowToMessage(rows[0]);
    const grouped = await reactionsByMessage([messageId]);
    message.reactions = grouped.get(messageId) ?? [];
    return message;
});

headlessChatServer.onReadMessagesByIds(async (messageIds) => {
    if (messageIds.length === 0) return [];
    const placeholders = messageIds.map(() => '?').join(',');
    const [rows] = await getDB().promise().query(`SELECT * FROM hc_messages WHERE message_id IN (${placeholders})`, messageIds);
    if (rows.length === 0) return [];
    const messages = rows.map(rowToMessage);
    const grouped = await reactionsByMessage(messages.map(m => m.messageId));
    for (const m of messages) m.reactions = grouped.get(m.messageId) ?? [];
    return messages;
});

headlessChatServer.onReadConversationLastMessageMetadata(async (conversationId) => {
    // Tiebreak on message_id so siblings sharing a created_at tick stay deterministic
    const [rows] = await getDB().promise().execute(
        `SELECT message_id, created_at FROM hc_messages WHERE conversation_id = ? ORDER BY created_at DESC, message_id DESC LIMIT 1`,
        [conversationId],
    );
    if (rows.length === 0) return null;
    return { messageId: String(rows[0].message_id), createdAt: rows[0].created_at };
});

headlessChatServer.onReadMessages(async (conversationId, cursorMessageId, after, amount) => {
    // Using query and not execute because mysql2's prepared-statement protocol rejects LIMIT as ? parameter
    let messages;
    if (cursorMessageId === null) {
        // Newest page returned in ascending order, tiebreak on message_id for determinism
        const [rows] = await getDB().promise().query(
            `SELECT * FROM (
                 SELECT * FROM hc_messages WHERE conversation_id = ? ORDER BY created_at DESC, message_id DESC LIMIT ?
             ) page ORDER BY created_at ASC, message_id ASC`,
            [conversationId, amount],
        );
        messages = rows.map(rowToMessage);
    } else {
        const [cursorRows] = await getDB().promise().execute(`SELECT created_at FROM hc_messages WHERE message_id = ?`, [cursorMessageId]);
        if (cursorRows.length === 0) return { messages: [], remainingInDirection: 0 };
        const cursorCreatedAt = cursorRows[0].created_at;

        // Tiebreak on message_id so siblings sharing a created_at tick stay in a deterministic order and don't get skipped
        if (after) {
            const [rows] = await getDB().promise().query(
                `SELECT * FROM hc_messages
                 WHERE conversation_id = ? AND (created_at, message_id) > (?, ?)
                 ORDER BY created_at ASC, message_id ASC LIMIT ?`,
                [conversationId, cursorCreatedAt, cursorMessageId, amount],
            );
            messages = rows.map(rowToMessage);
        } else {
            const [rows] = await getDB().promise().query(
                `SELECT * FROM (
                     SELECT * FROM hc_messages
                     WHERE conversation_id = ? AND (created_at, message_id) < (?, ?)
                     ORDER BY created_at DESC, message_id DESC LIMIT ?
                 ) page ORDER BY created_at ASC, message_id ASC`,
                [conversationId, cursorCreatedAt, cursorMessageId, amount],
            );
            messages = rows.map(rowToMessage);
        }
    }

    const grouped = await reactionsByMessage(messages.map(m => m.messageId));
    for (const message of messages) message.reactions = grouped.get(message.messageId) ?? [];

    let remainingInDirection = 0;
    if (messages.length === amount) {
        const edge = after ? messages[messages.length - 1] : messages[0];
        const op = after ? '>' : '<';
        const [[countRow]] = await getDB().promise().execute(
            `SELECT COUNT(*) AS n FROM hc_messages WHERE conversation_id = ? AND (created_at, message_id) ${op} (?, ?)`,
            [conversationId, edge.createdAt, edge.messageId],
        );
        remainingInDirection = Number(countRow.n);
    }
    return { messages, remainingInDirection };
});

headlessChatServer.onDeleteMessagesBefore(async (thresholdDate) => {
    const conn = await getDB().promise().getConnection();
    try {
        await conn.beginTransaction();

        // Capture the conversations with at least one expiring real message, deduped via DISTINCT, so the lib posts only one "messagesRemoved" system message per conversation
        // An expiring "messagesRemoved" system message alone doesn't count as affected, otherwise dormant conversations would re-post it daily
        const [affectedRows] = await conn.execute(
            `SELECT DISTINCT conversation_id FROM hc_messages WHERE created_at < ? AND (system_event_type IS NULL OR system_event_type != 'messagesRemoved') FOR UPDATE`,
            [thresholdDate],
        );
        const affectedConversationIds = affectedRows.map(r => String(r.conversation_id));

        // Deletions are restricted to affected conversations via the derived table, so expired "messagesRemoved" system messages roll forward to the new cut point there but stay put in dormant conversations
        await conn.execute(
            `DELETE r FROM hc_reactions r
             JOIN hc_messages m ON r.message_id = m.message_id
             JOIN (SELECT DISTINCT conversation_id FROM hc_messages WHERE created_at < ? AND (system_event_type IS NULL OR system_event_type != 'messagesRemoved')) a ON a.conversation_id = m.conversation_id
             WHERE m.created_at < ?`,
            [thresholdDate, thresholdDate],
        );
        await conn.execute(
            `DELETE m FROM hc_messages m
             JOIN (SELECT DISTINCT conversation_id FROM hc_messages WHERE created_at < ? AND (system_event_type IS NULL OR system_event_type != 'messagesRemoved')) a ON a.conversation_id = m.conversation_id
             WHERE m.created_at < ?`,
            [thresholdDate, thresholdDate],
        );
        await conn.commit();
        return { affectedConversationIds };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
});

// Reactions -----------------------------------------------------------------
headlessChatServer.onCreateReaction(async (reaction) => {
    // Replaces any prior reaction by this participant on this message (works with a UNIQUE key on (message_id, participant_id))
    const [result] = await getDB().promise().execute(
        `INSERT INTO hc_reactions (reaction_id, message_id, participant_id, content, created_at)
         SELECT ?, ?, ?, ?, ?
         FROM hc_messages m
         WHERE m.message_id = ?
           AND EXISTS (SELECT 1 FROM hc_conversation_participants WHERE conversation_id = m.conversation_id AND participant_id = ?)
         ON DUPLICATE KEY UPDATE
           reaction_id = VALUES(reaction_id),
           content = VALUES(content),
           created_at = VALUES(created_at)`,
        [
            reaction.reactionId, reaction.messageId, reaction.participantId, reaction.content, reaction.createdAt,
            reaction.messageId, String(reaction.participantId),
        ],
    );
    if (result.affectedRows === 0) throw new Error('Not a participant of this conversation');
});

headlessChatServer.onReadReaction(async (reactionId) => {
    const [rows] = await getDB().promise().execute(`SELECT * FROM hc_reactions WHERE reaction_id = ?`, [reactionId]);
    return rows.length === 0 ? null : rowToReaction(rows[0]);
});

headlessChatServer.onDeleteReaction(async (reactionId) => {
    await getDB().promise().execute(`DELETE FROM hc_reactions WHERE reaction_id = ?`, [reactionId]);
});

// Invites -------------------------------------------------------------------
headlessChatServer.onCreateInvite(async (invite, inviteLimitPerParticipant) => {
    const conversationId = invite.conversation.conversationId;

    // One query upfront to count existing users (must be 2), check whether the recipient is already a participant, and count the sender's pending outgoing invites
    const [precheck] = await getDB().promise().execute(
        `SELECT
            (SELECT COUNT(*) FROM users WHERE id IN (?, ?)) AS user_count,
            EXISTS(SELECT 1 FROM hc_conversation_participants WHERE conversation_id = ? AND participant_id = ?) AS recipient_is_participant,
            (SELECT COUNT(*) FROM hc_invites WHERE from_participant_id = ?) AS outgoing_count`,
        [String(invite.fromParticipantId), String(invite.toParticipantId), conversationId, String(invite.toParticipantId), String(invite.fromParticipantId)],
    );
    if (Number(precheck[0].user_count) < 2) throw new Error('Participant does not exist');
    if (Number(precheck[0].recipient_is_participant) === 1) throw new Error('Recipient is already a participant of this conversation');
    if (Number(precheck[0].outgoing_count) >= inviteLimitPerParticipant) throw new Error('Outgoing invite limit exceeded');

    // PRIMARY KEY on (conversation_id, from_participant_id, to_participant_id) makes INSERT IGNORE dedupe on the triple
    // Pre-check above already eliminated the recipient-is-participant case, so affectedRows === 0 here is purely a dedup no-op
    const [result] = await getDB().promise().execute(
        `INSERT IGNORE INTO hc_invites (conversation_id, from_participant_id, to_participant_id, created_at, seen) VALUES (?, ?, ?, ?, ?)`,
        [conversationId, invite.fromParticipantId, invite.toParticipantId, invite.createdAt, invite.seen ? 1 : 0],
    );
    return { inserted: result.affectedRows > 0 };
});

headlessChatServer.onReadInvite(async (conversationId, fromParticipantId, toParticipantId) => {
    const [rows] = await getDB().promise().execute(
        `SELECT * FROM hc_invites WHERE conversation_id = ? AND from_participant_id = ? AND to_participant_id = ?`,
        [conversationId, fromParticipantId, toParticipantId],
    );
    if (rows.length === 0) return null;
    const [convRows] = await getDB().promise().execute(CONVERSATION_SELECT + ` WHERE c.conversation_id = ?`, [conversationId]);
    if (convRows.length === 0) return null;
    const conversation = rowToConversation(convRows[0], await reactionsForLastMessage(convRows));
    return rowToInvite(rows[0], conversation);
});

headlessChatServer.onReadInvitesInvolvingParticipant(async (participantId) => {
    // Mark unseen invites as seen where this participant is the recipient, the subsequent SELECT picks up the post-update state
    await getDB().promise().execute(
        `UPDATE hc_invites SET seen = 1 WHERE to_participant_id = ? AND seen = 0`,
        [participantId],
    );
    // UNION ALL hits each index independently, OR across columns can defeat the optimizer at scale
    const [inviteRows] = await getDB().promise().execute(
        `SELECT * FROM (
             SELECT * FROM hc_invites WHERE from_participant_id = ?
             UNION ALL
             SELECT * FROM hc_invites WHERE to_participant_id = ?
         ) i ORDER BY created_at DESC`,
        [participantId, participantId],
    );
    return inviteRowsToInvites(inviteRows);
});

headlessChatServer.onReadInvitesForRecipient(async (conversationId, toParticipantId) => {
    const [inviteRows] = await getDB().promise().execute(
        `SELECT * FROM hc_invites WHERE conversation_id = ? AND to_participant_id = ? ORDER BY created_at DESC`,
        [conversationId, toParticipantId],
    );
    return inviteRowsToInvites(inviteRows);
});

headlessChatServer.onDeleteInvites(async (triples) => {
    if (triples.length === 0) return;
    const placeholders = triples.map(() => '(?, ?, ?)').join(', ');
    const flat = triples.flatMap(t => [t.conversationId, t.fromParticipantId, t.toParticipantId]);
    await getDB().promise().query(`DELETE FROM hc_invites WHERE (conversation_id, from_participant_id, to_participant_id) IN (${placeholders})`, flat);
});

headlessChatServer.onDeleteInvitesBefore(async (thresholdDate) => {
    const conn = await getDB().promise().getConnection();
    try {
        await conn.beginTransaction();

        // FOR UPDATE locks the rows so a concurrent revoke/accept can't race the DELETE below
        const [rows] = await conn.execute(
            `SELECT conversation_id, from_participant_id, to_participant_id FROM hc_invites WHERE created_at < ? FOR UPDATE`,
            [thresholdDate],
        );
        const deletedInvites = rows.map(r => ({
            conversationId: String(r.conversation_id),
            fromParticipantId: String(r.from_participant_id),
            toParticipantId: String(r.to_participant_id),
        }));

        await conn.execute(`DELETE FROM hc_invites WHERE created_at < ?`, [thresholdDate]);

        await conn.commit();
        return { deletedInvites };
    } catch (error) {
        await conn.rollback();
        throw error;
    } finally {
        conn.release();
    }
});

// Participant activity ------------------------------------------------------
headlessChatServer.onCreateConversationParticipantActivity(async (activity) => {
    await getDB().promise().execute(
        `INSERT IGNORE INTO hc_participant_activities (conversation_id, participant_id, last_read_message_id, last_read_message_created_at)
         SELECT ?, ?, ?, ?
         WHERE EXISTS (SELECT 1 FROM hc_conversation_participants WHERE conversation_id = ? AND participant_id = ?)`,
        [
            activity.conversationId, activity.participantId, activity.lastReadMessageId, activity.lastReadMessageCreatedAt,
            activity.conversationId, String(activity.participantId),
        ],
    );
});

headlessChatServer.onUpdateConversationParticipantActivity(async (activity) => {
    await getDB().promise().execute(
        `UPDATE hc_participant_activities pa
         SET pa.last_read_message_id = ?, pa.last_read_message_created_at = ?
         WHERE pa.conversation_id = ? AND pa.participant_id = ?
           AND EXISTS (SELECT 1 FROM hc_conversation_participants WHERE conversation_id = pa.conversation_id AND participant_id = pa.participant_id)`,
        [activity.lastReadMessageId, activity.lastReadMessageCreatedAt, activity.conversationId, activity.participantId],
    );
});

headlessChatServer.onReadConversationParticipantActivity(async (conversationId, participantId) => {
    const [rows] = await getDB().promise().execute(
        `SELECT * FROM hc_participant_activities WHERE conversation_id = ? AND participant_id = ?`,
        [conversationId, participantId],
    );
    return rows.length === 0 ? null : rowToActivity(rows[0]);
});

headlessChatServer.onReadParticipantActivities(async (participantId) => {
    const [rows] = await getDB().promise().execute(`SELECT * FROM hc_participant_activities WHERE participant_id = ?`, [participantId]);
    return rows.map(rowToActivity);
});

headlessChatServer.onReadHasNew(async (participantId) => {
    const [rows] = await getDB().promise().execute(
        `SELECT
            EXISTS(
                SELECT 1 FROM hc_conversation_participants cp
                JOIN hc_messages m ON m.conversation_id = cp.conversation_id
                LEFT JOIN hc_participant_activities pa ON pa.conversation_id = cp.conversation_id AND pa.participant_id = cp.participant_id
                WHERE cp.participant_id = ?
                  AND m.created_at > IFNULL(pa.last_read_message_created_at, 0)
            ) AS has_new_messages,
            EXISTS(
                SELECT 1 FROM hc_invites WHERE to_participant_id = ? AND seen = 0
            ) AS has_new_invites`,
        [participantId, participantId],
    );
    return {
        hasNewMessages: Number(rows[0].has_new_messages) === 1,
        hasNewInvites: Number(rows[0].has_new_invites) === 1,
    };
});

// Aliases come from the users table
// No error returned if that participant is no longer a user (account deleted), just omit the name
headlessChatServer.onReadAliases(async (participantIds) => {
    if (participantIds.length === 0) return [];
    const placeholders = participantIds.map(() => '?').join(',');
    const [rows] = await getDB().promise().query(`SELECT id, user_name FROM users WHERE id IN (${placeholders})`, participantIds);
    return rows.map(r => ({ participantId: String(r.id), alias: r.user_name }));
});

// Helpers -----------------------------------------------------------------------------------

// Hydrates invite rows with their full Conversation snapshots
async function inviteRowsToInvites(inviteRows) {
    if (inviteRows.length === 0) return [];
    const conversationIds = [...new Set(inviteRows.map(r => r.conversation_id))];
    const placeholders = conversationIds.map(() => '?').join(',');
    const [convRows] = await getDB().promise().query(CONVERSATION_SELECT + ` WHERE c.conversation_id IN (${placeholders})`, conversationIds);
    const reactions = await reactionsForLastMessage(convRows);
    const convosById = new Map();
    for (const row of convRows) convosById.set(row.conversation_id, rowToConversation(row, reactions));
    return inviteRows
        .map(r => ({ row: r, conv: convosById.get(r.conversation_id) }))
        .filter(({ conv }) => conv)
        .map(({ row, conv }) => rowToInvite(row, conv));
}

async function reactionsForLastMessage(rows) {
    return reactionsByMessage(rows.map(r => r.message_id).filter(Boolean));
}

async function reactionsByMessage(messageIds) {
    const out = new Map();
    if (messageIds.length === 0) return out;
    const placeholders = messageIds.map(() => '?').join(',');
    const [rows] = await getDB().promise().query(
        `SELECT * FROM hc_reactions WHERE message_id IN (${placeholders})`,
        messageIds,
    );
    for (const row of rows) {
        let list = out.get(row.message_id);
        if (!list) { list = []; out.set(row.message_id, list); }
        list.push(rowToReaction(row));
    }
    return out;
}

function rowToConversation(row, reactionsByMessageId) {
    // mysql2 only auto-parses columns of JSON type
    let rawParticipants = row.participants;

    if (typeof rawParticipants === 'string') rawParticipants = JSON.parse(rawParticipants);
    const participants = (rawParticipants ?? []).map(String);

    let lastMessage = null;

    if (row.message_id) {
        lastMessage = {
            messageId: row.message_id,
            conversationId: row.conversation_id,
            message: row.message,
            messageOptions: { referenceMessageId: row.reference_message_id, isForwarded: Boolean(row.is_forwarded) },
            participantId: String(row.m_participant_id),
            reactions: reactionsByMessageId.get(row.message_id) ?? [],
            deleted: Boolean(row.deleted),
            systemEvent: row.system_event_type ? { type: row.system_event_type, ...(row.system_event_participant_id !== null ? { participantId: String(row.system_event_participant_id) } : {}) } : null,
            createdAt: row.m_created_at,
            modifiedAt: row.m_modified_at,
        };
    }
    return {
        conversationId: row.conversation_id,
        participantIds: participants,
        createdAt: row.created_at,
        lastActivityAt: row.last_activity_at,
        maxSize: row.max_size,
        lastMessage,
    };
}

function rowToMessage(row) {
    return {
        messageId: row.message_id,
        conversationId: row.conversation_id,
        message: row.message,
        messageOptions: { referenceMessageId: row.reference_message_id, isForwarded: Boolean(row.is_forwarded) },
        participantId: String(row.participant_id),
        reactions: [], // Caller populates in batch
        deleted: Boolean(row.deleted),
        systemEvent: row.system_event_type ? { type: row.system_event_type, ...(row.system_event_participant_id !== null ? { participantId: String(row.system_event_participant_id) } : {}) } : null,
        createdAt: row.created_at,
        modifiedAt: row.modified_at,
    };
}

function rowToReaction(row) {
    return {
        reactionId: row.reaction_id,
        messageId: row.message_id,
        participantId: String(row.participant_id),
        content: row.content,
        createdAt: row.created_at,
    };
}

function rowToInvite(row, conversation) {
    return {
        fromParticipantId: String(row.from_participant_id),
        toParticipantId: String(row.to_participant_id),
        conversation,
        createdAt: row.created_at,
        seen: Boolean(row.seen),
    };
}

function rowToActivity(row) {
    return {
        conversationId: row.conversation_id,
        participantId: String(row.participant_id),
        lastReadMessageId: row.last_read_message_id,
        lastReadMessageCreatedAt: row.last_read_message_created_at,
    };
}
