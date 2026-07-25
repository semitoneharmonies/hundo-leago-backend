function createSocketIoInvalidationPublisher({ getIo } = {}) {
  if (typeof getIo !== "function") {
    throw new TypeError("Socket.IO publication requires an IO resolver");
  }

  return Object.freeze({
    async publish(event) {
      const io = getIo();
      if (!io || typeof io.to !== "function") {
        const error = new Error("Socket.IO publication is unavailable.");
        error.code = "SOCKET_PUBLISHER_UNAVAILABLE";
        throw error;
      }
      const room = io.to(`league:${event.leagueId}`);
      if (!room || typeof room.emit !== "function") {
        const error = new Error("Socket.IO publication is unavailable.");
        error.code = "SOCKET_PUBLISHER_UNAVAILABLE";
        throw error;
      }
      room.emit(event.eventType, {
        eventId: event.eventId,
        type: event.eventType,
        leagueId: event.leagueId,
        resourceId: event.aggregateId,
        version: event.payload.version,
        occurredAt: event.payload.changedAtMs,
      });
    },
  });
}

module.exports = { createSocketIoInvalidationPublisher };
