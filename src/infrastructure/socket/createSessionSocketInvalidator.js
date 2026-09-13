function createSessionSocketInvalidator({ getIo, getSocketRooms } = {}) {
  if (typeof getIo !== "function" || typeof getSocketRooms !== "function") {
    throw new TypeError("Session socket invalidation requires runtime resolvers.");
  }

  const pendingUsers = new Set();
  let scheduled = false;

  async function flush() {
    scheduled = false;
    const users = new Set(pendingUsers);
    pendingUsers.clear();
    let sockets;
    let rooms;
    try {
      sockets = getIo()?.sockets?.sockets;
      rooms = getSocketRooms();
    } catch {
      return;
    }
    if (!sockets || !rooms) return;
    for (const socket of sockets.values()) {
      if (!users.has(rooms.getAuthority(socket)?.userId)) continue;
      try {
        // Re-read authority after the enclosing synchronous transaction has
        // committed or rolled back. Never disconnect solely from a queued hint.
        await rooms.reauthorize(socket);
      } catch {
        // A failed connection must not prevent checks of the other sockets or
        // turn an already-committed account command into an apparent failure.
        try { socket.disconnect(true); } catch { /* already unavailable */ }
      }
    }
  }

  return function sessionChanged(userId) {
    pendingUsers.add(userId);
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => { void flush(); });
  };
}

module.exports = { createSessionSocketInvalidator };
