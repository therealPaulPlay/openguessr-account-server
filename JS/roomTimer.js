const roomTimeouts = new Map();

const roomTimer = {
    set(roomId, ms, callback) {
        this.stop(roomId);
        roomTimeouts.set(roomId, {
            timeoutId: setTimeout(() => {
                roomTimeouts.delete(roomId);
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
        const timeout = roomTimeouts.get(roomId);
        if (timeout) {
            clearTimeout(timeout.timeoutId);
            roomTimeouts.delete(roomId);
        }
    },

    adjust(roomId, ms) {
        const timeout = roomTimeouts.get(roomId);
        if (timeout) this.set(roomId, ms, timeout.callback);
    },
    
    isRunning(roomId) {
        return roomTimeouts.has(roomId);
    }
};

export { roomTimer };