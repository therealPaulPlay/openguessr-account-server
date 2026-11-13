const roomTimers = new Map();

function getOrCreateTimers(roomId) {
    if (!roomTimers.has(roomId)) roomTimers.set(roomId, new Map());
    return roomTimers.get(roomId);
}

const roomTimer = {
    set(roomId, ms, callback, timerId = null) {
        this.stop(roomId, timerId);
        getOrCreateTimers(roomId).set(timerId, {
            timeoutId: setTimeout(() => {
                getOrCreateTimers(roomId).delete(timerId);
                try {
                    callback();
                } catch (error) {
                    console.error(`Error occurred in room timer callback: ${error.message}`);
                }
            }, ms),
            callback
        });
    },

    stop(roomId, timerId = null) {
        const timeout = getOrCreateTimers(roomId).get(timerId);
        if (timeout) {
            clearTimeout(timeout.timeoutId);
            getOrCreateTimers(roomId).delete(timerId);
        }
    },

    stopAll(roomId) {
        getOrCreateTimers(roomId).forEach((timeout) => clearTimeout(timeout.timeoutId));
        roomTimers.delete(roomId);
    },

    adjust(roomId, ms, timerId = null) {
        const timeout = getOrCreateTimers(roomId).get(timerId);
        if (timeout) this.set(roomId, ms, timeout.callback, timerId);
    },

    isRunning(roomId, timerId = null) {
        return getOrCreateTimers(roomId).has(timerId);
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