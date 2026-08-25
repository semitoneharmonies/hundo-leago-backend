const SESSION_COOKIE_MAX_AGE_SECONDS =
  7 * 24 * 60 * 60;
const LOCAL_SESSION_COOKIE_NAME = "hl_session";
const HOST_SESSION_COOKIE_NAME =
  "__Host-hl_session";
const RAW_TOKEN_PATTERN =
  /^[A-Za-z0-9_-]{43}$/;
const MAXIMUM_COOKIE_HEADER_LENGTH = 8192;

const LOCAL_FRONTEND_ORIGINS = new Set([
  "http://localhost:5173",
  "http://localhost:5174",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
]);

class SessionCookieError extends Error {
  constructor(reasonCode) {
    super("The session cookie is invalid.");
    this.name = "SessionCookieError";
    this.code = "SESSION_COOKIE_INVALID";
    this.reasonCode = reasonCode;
  }
}

function cookieError(reasonCode) {
  throw new SessionCookieError(reasonCode);
}

function assertRawToken(rawToken) {
  if (
    typeof rawToken !== "string" ||
    !RAW_TOKEN_PATTERN.test(rawToken)
  ) {
    cookieError("SESSION_COOKIE_TOKEN_INVALID");
  }
  const bytes = Buffer.from(rawToken, "base64url");
  const canonical =
    bytes.byteLength === 32 &&
    bytes.toString("base64url") === rawToken;
  bytes.fill(0);
  if (!canonical) {
    cookieError("SESSION_COOKIE_TOKEN_INVALID");
  }
  return rawToken;
}

function assertOrigin(origin, appEnv) {
  if (typeof origin !== "string") {
    cookieError("SESSION_COOKIE_ORIGIN_INVALID");
  }
  let parsed;
  try {
    parsed = new URL(origin);
  } catch {
    cookieError("SESSION_COOKIE_ORIGIN_INVALID");
  }
  if (parsed.origin !== origin) {
    cookieError("SESSION_COOKIE_ORIGIN_INVALID");
  }

  if (appEnv === "local") {
    if (!LOCAL_FRONTEND_ORIGINS.has(origin)) {
      cookieError(
        "SESSION_COOKIE_LOCAL_ORIGIN_INVALID"
      );
    }
  } else if (parsed.protocol !== "https:") {
    cookieError(
      "SESSION_COOKIE_SECURE_ORIGIN_REQUIRED"
    );
  }
  return origin;
}

function createSessionCookie({
  appEnv,
  publicFrontendOrigin,
  sameSite,
} = {}) {
  if (
    !["local", "staging", "production"].includes(
      appEnv
    )
  ) {
    cookieError("SESSION_COOKIE_ENV_INVALID");
  }
  assertOrigin(publicFrontendOrigin, appEnv);

  const normalizedSameSite =
    typeof sameSite === "string"
      ? sameSite.toLowerCase()
      : "";
  if (
    !["lax", "none"].includes(
      normalizedSameSite
    )
  ) {
    cookieError(
      "SESSION_COOKIE_SAME_SITE_INVALID"
    );
  }
  if (
    appEnv === "local" &&
    normalizedSameSite !== "lax"
  ) {
    cookieError(
      "SESSION_COOKIE_LOCAL_SAME_SITE_INVALID"
    );
  }

  const secure = appEnv !== "local";
  const name = secure
    ? HOST_SESSION_COOKIE_NAME
    : LOCAL_SESSION_COOKIE_NAME;
  const sameSiteValue =
    normalizedSameSite === "none"
      ? "None"
      : "Lax";

  function attributes(maxAge) {
    const values = [
      `Max-Age=${maxAge}`,
      "Path=/",
      "HttpOnly",
    ];
    if (secure) values.push("Secure");
    values.push(`SameSite=${sameSiteValue}`);
    return values.join("; ");
  }

  function serialize(rawToken) {
    const token = assertRawToken(rawToken);
    return (
      `${name}=${token}; ` +
      attributes(
        SESSION_COOKIE_MAX_AGE_SECONDS
      )
    );
  }

  function clear() {
    return `${name}=; ${attributes(0)}`;
  }

  function read(cookieHeader) {
    if (
      cookieHeader === undefined ||
      cookieHeader === null ||
      cookieHeader === ""
    ) {
      return null;
    }
    if (
      typeof cookieHeader !== "string" ||
      cookieHeader.length >
        MAXIMUM_COOKIE_HEADER_LENGTH
    ) {
      cookieError(
        "SESSION_COOKIE_HEADER_INVALID"
      );
    }

    const matches = [];
    for (const segment of cookieHeader.split(";")) {
      const trimmed = segment.trim();
      const separator = trimmed.indexOf("=");
      if (separator < 1) continue;
      const cookieName = trimmed.slice(
        0,
        separator
      );
      if (cookieName !== name) continue;
      matches.push(
        trimmed.slice(separator + 1)
      );
    }

    if (matches.length === 0) return null;
    if (matches.length !== 1) {
      cookieError(
        "SESSION_COOKIE_DUPLICATE"
      );
    }
    return assertRawToken(matches[0]);
  }

  return Object.freeze({
    clear,
    name,
    read,
    sameSite: sameSiteValue,
    secure,
    serialize,
  });
}

module.exports = {
  HOST_SESSION_COOKIE_NAME,
  LOCAL_FRONTEND_ORIGINS,
  LOCAL_SESSION_COOKIE_NAME,
  MAXIMUM_COOKIE_HEADER_LENGTH,
  RAW_TOKEN_PATTERN,
  SESSION_COOKIE_MAX_AGE_SECONDS,
  SessionCookieError,
  createSessionCookie,
};
