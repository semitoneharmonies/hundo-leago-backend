const MANAGED_ROOMS = Symbol(
  "hundo.managedSocketRooms"
);
const AUTHORITY_DATA_KEY = "hundoAuthority";

const SOCKET_ROOM_CODES = Object.freeze({
  authorizationUnavailable:
    "SOCKET_AUTHORIZATION_UNAVAILABLE",
  sessionRequired: "SOCKET_SESSION_REQUIRED",
});

const SAFE_MESSAGES = Object.freeze({
  [SOCKET_ROOM_CODES.authorizationUnavailable]:
    "Socket authorization is unavailable.",
  [SOCKET_ROOM_CODES.sessionRequired]:
    "A valid session is required.",
});

function connectionError(error) {
  const code =
    typeof error?.code === "string" &&
    error.code.startsWith("SOCKET_")
      ? error.code
      : SOCKET_ROOM_CODES.authorizationUnavailable;
  const output = new Error(
    SAFE_MESSAGES[code] ||
      SAFE_MESSAGES[
        SOCKET_ROOM_CODES.sessionRequired
      ]
  );
  output.data = Object.freeze({ code });
  return output;
}

function assertSocket(socket) {
  if (
    !socket ||
    !socket.handshake ||
    typeof socket.join !== "function" ||
    typeof socket.leave !== "function" ||
    typeof socket.disconnect !== "function"
  ) {
    throw new TypeError(
      "authenticated socket rooms require a Socket.IO socket"
    );
  }
  if (
    !socket.data ||
    typeof socket.data !== "object" ||
    Array.isArray(socket.data)
  ) {
    throw new TypeError(
      "authenticated socket rooms require socket data"
    );
  }
  return socket;
}

function createAuthenticatedSocketRooms({
  authorizationService,
} = {}) {
  if (
    !authorizationService ||
    typeof authorizationService.authorizeHandshake !==
      "function"
  ) {
    throw new TypeError(
      "authenticated socket rooms require an authorization service"
    );
  }

  async function applyAuthority(socket, authority) {
    const desired = new Set(authority.rooms);
    const previous = socket[MANAGED_ROOMS] || new Set();

    for (const room of previous) {
      if (!desired.has(room)) {
        await socket.leave(room);
      }
    }
    for (const room of desired) {
      if (!previous.has(room)) {
        await socket.join(room);
      }
    }

    Object.defineProperty(socket, MANAGED_ROOMS, {
      configurable: true,
      enumerable: false,
      value: desired,
      writable: false,
    });
    socket.data[AUTHORITY_DATA_KEY] = authority;
    return authority;
  }

  function middleware(socket, next) {
    if (typeof next !== "function") {
      throw new TypeError(
        "authenticated socket middleware requires next"
      );
    }
    try {
      assertSocket(socket);
      const authority =
        authorizationService.authorizeHandshake(
          socket.handshake
        );
      Promise.resolve(
        applyAuthority(socket, authority)
      ).then(
        () => next(),
        (error) => next(connectionError(error))
      );
    } catch (error) {
      next(connectionError(error));
    }
  }

  async function reauthorize(socket) {
    assertSocket(socket);
    try {
      const authority =
        authorizationService.authorizeHandshake(
          socket.handshake
        );
      await applyAuthority(socket, authority);
      return true;
    } catch {
      delete socket.data[AUTHORITY_DATA_KEY];
      socket.disconnect(true);
      return false;
    }
  }

  function getAuthority(socket) {
    return socket?.data?.[AUTHORITY_DATA_KEY] || null;
  }

  return Object.freeze({
    getAuthority,
    middleware,
    reauthorize,
  });
}

module.exports = {
  AUTHORITY_DATA_KEY,
  SOCKET_ROOM_CODES,
  createAuthenticatedSocketRooms,
};
