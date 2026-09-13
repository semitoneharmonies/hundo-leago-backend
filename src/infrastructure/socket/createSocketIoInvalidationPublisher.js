const {
  createSocketEventEnvelope,
} = require("../../domain/leagues/socketInvalidation");

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const EVENT_TYPE_PATTERN =
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){1,7}$/;
const METADATA_NAME_PATTERN =
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+){0,7}$/;
const REQUIRED_EVENT_KEYS = Object.freeze([
  "aggregateId",
  "aggregateType",
  "audiences",
  "eventId",
  "eventType",
  "leagueId",
  "payload",
]);
const OPTIONAL_EVENT_KEYS = Object.freeze([
  "authorizeUserAudience",
]);
const AUDIENCE_KEYS = Object.freeze([
  "kind",
  "leagueId",
  "teamId",
  "userId",
]);
const PRIVATE_REAUTHORIZATION_EVENT_TYPES = new Set([
  "candidate_card.changed",
  "candidate_card_help.changed",
  "fad_nomination_queue.changed",
]);

function publisherError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function invalidAudience() {
  throw publisherError(
    "SOCKET_AUDIENCE_INVALID",
    "Socket.IO publication requires a valid explicit audience."
  );
}

function invalidEvent() {
  throw publisherError(
    "SOCKET_EVENT_INVALID",
    "Socket.IO publication requires exact invalidation metadata."
  );
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype || prototype === null
  );
}

function hasExactKeys(value, expectedKeys) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...expectedKeys].sort();
  return (
    actual.length === expected.length &&
    actual.every((key, index) => key === expected[index])
  );
}

function validateEvent(event) {
  if (!isPlainObject(event)) invalidEvent();
  const eventKeys = Object.keys(event);
  if (
    REQUIRED_EVENT_KEYS.some(
      (key) => !eventKeys.includes(key)
    ) ||
    eventKeys.some(
      (key) =>
        !REQUIRED_EVENT_KEYS.includes(key) &&
        !OPTIONAL_EVENT_KEYS.includes(key)
    ) ||
    !UUID_PATTERN.test(event.eventId || "") ||
    !UUID_PATTERN.test(event.leagueId || "") ||
    !UUID_PATTERN.test(event.aggregateId || "") ||
    !EVENT_TYPE_PATTERN.test(event.eventType || "") ||
    !METADATA_NAME_PATTERN.test(event.aggregateType || "") ||
    !Array.isArray(event.audiences) ||
    event.audiences.length === 0
  ) {
    invalidEvent();
  }

  let payload;
  try {
    payload = createSocketEventEnvelope({
      eventId: event.payload?.eventId,
      type: event.payload?.type,
      leagueId: event.payload?.leagueId,
      resourceId: event.payload?.resourceId,
      version: event.payload?.version,
      reasonCode: event.payload?.reasonCode,
      occurredAt: event.payload?.occurredAt,
      related: event.payload?.related,
    });
  } catch {
    invalidEvent();
  }
  if (
    !hasExactKeys(event.payload, Object.keys(payload)) ||
    payload.eventId !== event.eventId ||
    payload.type !== event.eventType ||
    payload.leagueId !== event.leagueId ||
    payload.resourceId !== event.aggregateId
  ) {
    invalidEvent();
  }
  if (
    event.audiences.some(
      (audience) => audience?.kind === "league"
    ) &&
    event.audiences.length !== 1
  ) {
    invalidAudience();
  }
  return payload;
}

function audienceRoom(audience, leagueId) {
  if (
    !hasExactKeys(audience, AUDIENCE_KEYS) ||
    audience.leagueId !== leagueId
  ) {
    invalidAudience();
  }
  if (
    audience.kind === "league" &&
    audience.teamId === null &&
    audience.userId === null
  ) {
    return `league:${leagueId}`;
  }
  if (
    audience.kind === "team" &&
    UUID_PATTERN.test(audience.teamId || "") &&
    audience.userId === null
  ) {
    return `team:${audience.teamId}`;
  }
  if (
    audience.kind === "user" &&
    audience.teamId === null &&
    UUID_PATTERN.test(audience.userId || "")
  ) {
    return `user:${audience.userId}`;
  }
  invalidAudience();
}

async function reauthorizePrivateSockets({
  event,
  io,
  rooms,
  getSocketReauthorizer,
}) {
  if (!PRIVATE_REAUTHORIZATION_EVENT_TYPES.has(event.eventType)) {
    return;
  }
  let reauthorizeSocket;
  try {
    reauthorizeSocket = getSocketReauthorizer?.();
  } catch {
    reauthorizeSocket = null;
  }
  if (typeof reauthorizeSocket !== "function") {
    throw publisherError(
      "SOCKET_AUDIENCE_AUTHORIZATION_FAILED",
      "Socket.IO audience authorization is unavailable."
    );
  }

  const inspectionRooms = new Set([
    `league:${event.leagueId}`,
    ...rooms,
  ]);
  const sockets = new Map();
  try {
    for (const room of inspectionRooms) {
      const operator = io?.in?.(room);
      if (!operator || typeof operator.fetchSockets !== "function") {
        throw new Error("socket inspection unavailable");
      }
      const joined = await operator.fetchSockets();
      if (!Array.isArray(joined)) {
        throw new Error("socket inspection unavailable");
      }
      for (const socket of joined) {
        if (
          !socket ||
          typeof socket.id !== "string" ||
          socket.id.length === 0
        ) {
          throw new Error("socket inspection unavailable");
        }
        sockets.set(socket.id, socket);
      }
    }
    for (const socket of sockets.values()) {
      const reauthorized = await reauthorizeSocket(socket);
      if (typeof reauthorized !== "boolean") {
        throw new Error("socket reauthorization unavailable");
      }
    }
  } catch {
    throw publisherError(
      "SOCKET_AUDIENCE_AUTHORIZATION_FAILED",
      "Socket.IO audience authorization is unavailable."
    );
  }
}

function createSocketIoInvalidationPublisher({
  getIo,
  getSocketReauthorizer,
} = {}) {
  if (typeof getIo !== "function") {
    throw new TypeError("Socket.IO publication requires an IO resolver");
  }
  if (
    getSocketReauthorizer !== undefined &&
    typeof getSocketReauthorizer !== "function"
  ) {
    throw new TypeError(
      "Socket.IO publication requires a socket reauthorization resolver"
    );
  }

  return Object.freeze({
    async publish(event) {
      const payload = validateEvent(event);
      const destinations = new Set();
      const declaredDestinations = new Set();
      for (const audience of event.audiences) {
        const room = audienceRoom(
          audience,
          event.leagueId
        );
        if (declaredDestinations.has(room)) {
          invalidAudience();
        }
        declaredDestinations.add(room);
        if (audience.kind === "user") {
          if (
            typeof event.authorizeUserAudience !==
            "function"
          ) {
            invalidAudience();
          }
          let authorized;
          try {
            authorized =
              event.authorizeUserAudience({
                leagueId: event.leagueId,
                userId: audience.userId,
              });
          } catch {
            throw publisherError(
              "SOCKET_AUDIENCE_AUTHORIZATION_FAILED",
              "Socket.IO audience authorization is unavailable."
            );
          }
          if (typeof authorized !== "boolean") {
            throw publisherError(
              "SOCKET_AUDIENCE_AUTHORIZATION_FAILED",
              "Socket.IO audience authorization is unavailable."
            );
          }
          if (!authorized) continue;
        }
        destinations.add(room);
      }

      if (destinations.size === 0) {
        return Object.freeze({
          delivered: false,
          roomCount: 0,
        });
      }

      let target;
      try {
        target = getIo();
        await reauthorizePrivateSockets({
          event,
          io: target,
          rooms: destinations,
          getSocketReauthorizer,
        });
        for (const room of destinations) {
          if (!target || typeof target.to !== "function") {
            throw publisherError(
              "SOCKET_PUBLISHER_UNAVAILABLE",
              "Socket.IO publication is unavailable."
            );
          }
          target = target.to(room);
        }
        if (!target || typeof target.emit !== "function") {
          throw publisherError(
            "SOCKET_PUBLISHER_UNAVAILABLE",
            "Socket.IO publication is unavailable."
          );
        }
        target.emit(payload.type, payload);
      } catch (error) {
        if (
          error?.code === "SOCKET_PUBLISHER_UNAVAILABLE" ||
          error?.code ===
            "SOCKET_AUDIENCE_AUTHORIZATION_FAILED"
        ) {
          throw error;
        }
        throw publisherError(
          "SOCKET_PUBLICATION_FAILED",
          "Socket.IO publication failed."
        );
      }

      return Object.freeze({
        delivered: true,
        roomCount: destinations.size,
      });
    },
  });
}

module.exports = { createSocketIoInvalidationPublisher };
