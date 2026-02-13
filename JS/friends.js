import express from 'express';
import { standardLimiter, friendRequestLimiter } from "./rateLimiters.js";
import { authenticateTokenWithId } from "./authUtils.js";
import { getSseClients, sendEventToClient } from "./serverSentEvents.js";
import { getDB } from "./dbConnection.js";
import { cacheResponse } from "./responseCache.js";

const friendRouter = express.Router();

// Send a friend request
friendRouter.post('/send', friendRequestLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: senderId, recipientId } = req.body;

    if (!senderId || !recipientId) return res.status(400).json({ error: 'Sender ID and recipient ID are required.' });
    if (senderId == recipientId) return res.status(400).json({ error: 'You cannot send a friend request to yourself.' });

    try {
        const db = getDB();
        // Check if the users are already friends
        const checkFriendsQuery = `
            SELECT * FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
        `;
        const [existingFriends] = await db.promise().query(checkFriendsQuery, [senderId, recipientId, recipientId, senderId]);
        if (existingFriends.length > 0) return res.status(409).json({ error: 'You are already friends with this user.' });

        // Check if a friend request already exists
        const checkRequestQuery = `
            SELECT * FROM friend_requests WHERE sender_id = ? AND recipient_id = ?
        `;
        const [existingRequest] = await db.promise().query(checkRequestQuery, [senderId, recipientId]);
        if (existingRequest.length > 0) return res.status(409).json({ error: 'Friend request already sent.' });

        // Get name
        const [users] = await db.promise().query(`SELECT user_name FROM users WHERE id = ?`, [senderId]);
        if (!users.length) return res.status(400).json({ error: 'User not found.' });
        const senderName = users[0]?.user_name;

        // Insert the friend request into the database
        const sendRequestQuery = `
            INSERT INTO friend_requests (sender_id, recipient_id, created_at)
            VALUES (?, ?, NOW())
        `;
        await db.promise().query(sendRequestQuery, [senderId, recipientId]);

        // Set the new_request field to true for the recipient
        const updateRecipientQuery = `
            UPDATE users SET new_request = 1 WHERE id = ?
        `;
        await db.promise().query(updateRecipientQuery, [recipientId]);

        // Send notification to recipient if they are online - using SSE
        try {
            const eventData = {
                type: 'friend-request-received',
                from: senderId,
                name: senderName
            };

            sendEventToClient(recipientId, eventData);
        } catch (error) {
            console.error('Error sending invite SSE notification:', error);
        }

        res.status(201).json({ message: 'Friend request sent successfully.' });
    } catch (error) {
        console.error('Error sending friend request:', error);
        res.status(500).json({ error: 'An error occurred while sending the friend request.' });
    }
});

// Accept a friend request
friendRouter.post('/accept', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: recipientId, senderId } = req.body;

    if (!senderId || !recipientId) {
        return res.status(400).json({ error: 'Sender ID and recipient ID are required.' });
    }

    try {
        const db = getDB();
        // Check if the friend request exists
        const checkRequestQuery = `
            SELECT * FROM friend_requests WHERE sender_id = ? AND recipient_id = ?
        `;
        const [existingRequest] = await db.promise().query(checkRequestQuery, [senderId, recipientId]);
        if (existingRequest.length === 0) return res.status(404).json({ error: 'Friend request not found.' });

        // Insert into friends table (two-way friendship)
        const addFriendsQuery = `
            INSERT INTO friends (user_id, friend_id)
            VALUES (?, ?), (?, ?)
        `;
        await db.promise().query(addFriendsQuery, [senderId, recipientId, recipientId, senderId]);

        // Delete the friend request from sender to recipient
        const deleteRequestQuery = `
            DELETE FROM friend_requests WHERE sender_id = ? AND recipient_id = ?
        `;
        await db.promise().query(deleteRequestQuery, [senderId, recipientId]);

        // Also delete any friend request from recipient to sender if it exists
        const deleteReverseRequestQuery = `
            DELETE FROM friend_requests WHERE sender_id = ? AND recipient_id = ?
        `;
        await db.promise().query(deleteReverseRequestQuery, [recipientId, senderId]);

        res.status(200).json({ message: 'Friend request accepted successfully.' });
    } catch (error) {
        console.error('Error accepting friend request:', error);
        res.status(500).json({ error: 'An error occurred while accepting the friend request.' });
    }
});

// Get all friends of a user
friendRouter.post('/friends', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: userId } = req.body;
    if (!userId) {
        return res.status(400).json({ error: 'User ID is required.' });
    }

    try {
        const db = getDB();
        const getFriendsQuery = `
            SELECT
                users.id,
                users.user_name
            FROM friends
            JOIN users ON friends.friend_id = users.id
            WHERE friends.user_id = ?
            ORDER BY users.user_name ASC;
        `;

        const [friends] = await db.promise().query(getFriendsQuery, [userId]);
        const activeClients = getSseClients();

        // Add online status based on SSE connection and sort
        const friendsWithOnlineStatus = friends.map(friend => ({
            ...friend,
            online: activeClients.hasOwnProperty(friend.id)
        }));

        // Sort by online status (online first), then by username
        friendsWithOnlineStatus.sort((a, b) => {
            if (a.online !== b.online) return b.online - a.online; // Online users first
            return a.user_name.localeCompare(b.user_name); // Then alphabetical
        });

        res.status(200).json({ friends: friendsWithOnlineStatus });
    } catch (error) {
        console.error('Error fetching friends:', error);
        res.status(500).json({ error: 'An error occurred while fetching friends.' });
    }
});

// Search for users by name using full-text search
friendRouter.get('/search/:query', standardLimiter, cacheResponse("friends-search", 5000), async (req, res) => {
    let { query } = req.params;

    if (!query) return res.status(400).json({ error: 'Search query is required.' });

    try {
        query = query
            .replace(/[+\-><\(\)~*\"@]+/g, ' ')
            .trim()
            .replace(/\s+/g, ' ');

        if (!query) return res.status(400).json({ error: 'Invalid search query after sanitization.' });

        const db = getDB();

        // For short queries (1-2 chars), use prefix matching which is much faster than full-text search
        let searchQuery, searchParams;

        if (query.length <= 2) {
            searchQuery = `
                SELECT id, user_name FROM users
                WHERE user_name LIKE ?
                ORDER BY LENGTH(user_name) ASC
                LIMIT 25
            `;
            searchParams = [`${query}%`];
        } else {
            searchQuery = `
                SELECT id, user_name FROM users
                WHERE MATCH(user_name) AGAINST(? IN BOOLEAN MODE)
                ORDER BY MATCH(user_name) AGAINST(? IN BOOLEAN MODE) DESC, LENGTH(user_name) ASC
                LIMIT 25
            `;
            searchParams = [`${query}*`, `${query}*`];
        }

        const [users] = await db.promise().execute(searchQuery, searchParams);

        res.status(200).json({ users });
    } catch (error) {
        console.error('Error searching for users:', error);
        res.status(500).json({ error: 'An error occurred while searching for users.' });
    }
});

// Load all friend requests for a user
friendRouter.post('/requests', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: recipientId } = req.body;

    if (!recipientId) return res.status(400).json({ error: 'Recipient ID is required.' });

    try {
        const db = getDB();
        const getRequestsQuery = `
            SELECT users.id, users.user_name
            FROM friend_requests
            JOIN users ON friend_requests.sender_id = users.id
            WHERE friend_requests.recipient_id = ?
        `;
        const [requests] = await db.promise().query(getRequestsQuery, [recipientId]);

        const updateRecipientQuery = `
            UPDATE users SET new_request = 0 WHERE id = ?
        `;
        await db.promise().query(updateRecipientQuery, [recipientId]);

        res.status(200).json({ requests });
    } catch (error) {
        console.error('Error loading friend requests:', error);
        res.status(500).json({ error: 'An error occurred while loading friend requests.' });
    }
});

// Decline a friend request
friendRouter.post('/decline', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: recipientId, senderId } = req.body;

    if (!senderId || !recipientId) return res.status(400).json({ error: 'Sender ID and recipient ID are required.' });

    try {
        const db = getDB();
        const deleteRequestQuery = `
            DELETE FROM friend_requests WHERE sender_id = ? AND recipient_id = ?
        `;
        const [result] = await db.promise().query(deleteRequestQuery, [senderId, recipientId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Friend request not found.' });
        }

        res.status(200).json({ message: 'Friend request declined successfully.' });
    } catch (error) {
        console.error('Error declining friend request:', error);
        res.status(500).json({ error: 'An error occurred while declining the friend request.' });
    }
});

// Remove a friend
friendRouter.post('/remove', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: userId, friendId } = req.body;

    if (!userId || !friendId) return res.status(400).json({ error: 'User ID and Friend ID are required.' });

    const db = getDB();

    try {
        const deleteFriendshipQuery = `
            DELETE FROM friends WHERE (user_id = ? AND friend_id = ?) OR (user_id = ? AND friend_id = ?)
        `;
        const [result] = await db.promise().query(deleteFriendshipQuery, [userId, friendId, friendId, userId]);

        if (result.affectedRows === 0) {
            return res.status(404).json({ error: 'Friendship not found.' });
        }

        res.status(200).json({ message: 'Friend removed successfully.' });
    } catch (error) {
        console.error('Error removing friend:', error);
        res.status(500).json({ error: 'An error occurred while removing the friend.' });
    }
});

// Invites ----------------------------------------------------------------------------------------------------
friendRouter.post('/send-invite', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id: senderId, friend_id: recipientId, roomcode } = req.body;

    const db = getDB();

    if (!senderId || !recipientId || !roomcode) return res.status(400).json({ error: 'Sender ID, recipient ID and roomcode are required.' });

    try {
        // Get sender name
        const [rows] = await db.promise().query(`SELECT user_name FROM users WHERE id = ?`, [senderId]);
        if (!rows.length) return res.status(400).json({ error: 'User not found.' });
        const senderName = rows[0]?.user_name;

        // Check friend status
        const [friendRows] = await db.promise().query(`SELECT * FROM friends WHERE user_id = ? AND friend_id = ?`, [senderId, recipientId]);
        if (!friendRows.length) return res.status(400).json({ error: 'Not friends with this user.' });

        const eventData = {
            type: 'room-invite',
            roomcode,
            from: senderId,
            name: senderName
        };

        if (sendEventToClient(recipientId, eventData)) {
            return res.status(200).json({ message: 'Invite sent successfully.' });
        } else {
            return res.status(404).json({ error: 'Recipient is now offline.' });
        }
    } catch (error) {
        console.error('Error sending invite:', error);
        return res.status(500).json({ error: 'An error occurred while sending the invite.' });
    }
});

// Accept an invite
friendRouter.post('/accept-invite', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id, friend_id: friendId } = req.body;

    if (!id || !friendId) return res.status(400).json({ error: 'Id and friend id are required.' });

    const db = getDB();

    try {
        // Get name
        const [rows] = await db.promise().query(`SELECT user_name FROM users WHERE id = ?`, [id]);
        if (!rows.length) return res.status(400).json({ error: 'User not found.' });
        const senderName = rows[0]?.user_name;

        // Confirm friendship
        const [friendRows] = await db.promise().query(`SELECT * FROM friends WHERE user_id = ? AND friend_id = ?`, [id, friendId]);
        if (!friendRows.length) return res.status(400).json({ error: 'Not friends with this user.' });

        const eventData = {
            type: 'invite-accepted',
            from: id,
            name: senderName
        };

        sendEventToClient(friendId, eventData)
        return res.json({ message: 'Invite accepted successfully.' });
    } catch (error) {
        console.error('Error accepting invite:', error);
        return res.status(500).json({ error: 'An error occurred while accepting the invite.' });
    }
});

// Decline an invite
friendRouter.post('/decline-invite', standardLimiter, authenticateTokenWithId, async (req, res) => {
    const { id, friend_id: friendId } = req.body;

    if (!id || !friendId) return res.status(400).json({ error: 'Id and friend id are required.' });

    const db = getDB();

    try {
        // Get name
        const [rows] = await db.promise().query(`SELECT user_name FROM users WHERE id = ?`, [id]);
        if (!rows.length) return res.status(400).json({ error: 'User not found.' });
        const senderName = rows[0]?.user_name;

        // Confirm friendship
        const [friendRows] = await db.promise().query(`SELECT * FROM friends WHERE user_id = ? AND friend_id = ?`, [id, friendId]);
        if (!friendRows.length) return res.status(400).json({ error: 'Not friends with this user.' });

        const eventData = {
            type: 'invite-declined',
            from: id,
            name: senderName
        };

        if (sendEventToClient(friendId, eventData)) {
            return res.status(200).json({ message: 'Invite declined.' });
        } else {
            return res.status(404).json({ error: 'Sender is now offline.' });
        }
    } catch (error) {
        console.error('Error declining invite:', error);
        return res.status(500).json({ error: 'An error occurred while declining the invite.' });
    }
});

export default friendRouter;