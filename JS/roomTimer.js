const roomTimers = new Map();

const roomTimer = {
    set(roomId, ms, callback) {
        this.stop(roomId);
        roomTimers.set(roomId, {
            timeoutId: setTimeout(() => {
                roomTimers.delete(roomId);
                try {
                    callback();
                } catch (error) {
                    console.error(`Error occurred in room timer callback: ${error.message}`);
                }
            }, ms),
            callback
        });
    },

    stop(roomId) {
        const timeout = roomTimers.get(roomId);
        if (timeout) {
            clearTimeout(timeout.timeoutId);
            roomTimers.delete(roomId);
        }
    },

    adjust(roomId, ms) {
        const timeout = roomTimers.get(roomId);
        if (timeout) this.set(roomId, ms, timeout.callback);
    },

    isRunning(roomId) {
        return roomTimers.has(roomId);
    }
};

const roomTimeouts = new Map();

const setRoomTimeout = (roomId, callbackFn = () => { }, delay = 0) => {
    const newTimeout = setTimeout(() => {
        roomTimeouts.get(roomId)?.splice(roomTimeouts.get(roomId).indexOf(newTimeout), 1);
        callbackFn();
    }, delay);

    const timeoutsForRoom = roomTimeouts.get(roomId);
    if (timeoutsForRoom) timeoutsForRoom.push(newTimeout);
    else roomTimeouts.set(roomId, [newTimeout]);
}

function cancelAllRoomTimeouts(roomId) {
    const timeouts = roomTimeouts.get(roomId);
    timeouts?.forEach((timeout) => {
        clearTimeout(timeout);
    });
    roomTimeouts.delete(roomId);
}

export { roomTimer, setRoomTimeout, cancelAllRoomTimeouts };