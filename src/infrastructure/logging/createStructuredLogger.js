const REDACTED = "[REDACTED]";
const REDACTED_EMAIL = "[REDACTED_EMAIL]";
const REDACTED_SECRET = "[REDACTED_SECRET]";
const REDACTED_URL = "[REDACTED_URL]";
const CIRCULAR = "[CIRCULAR]";
const UNSUPPORTED = "[UNSUPPORTED]";
const TRUNCATED = "[TRUNCATED]";

const MAX_CONTEXT_DEPTH = 6;
const MAX_CONTEXT_FIELDS = 50;
const MAX_ARRAY_ITEMS = 50;
const MAX_STRING_LENGTH = 4096;

const LEVEL_PRIORITY = Object.freeze({
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
});

const EVENT_NAME_PATTERN =
  /^[a-z][a-z0-9]*(?:[._:-][a-z0-9]+)*$/;
const CONTEXT_KEY_PATTERN =
  /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const RESERVED_CONTEXT_KEYS = new Set([
  "timestamp",
  "severity",
  "event",
  "environment",
  "buildId",
]);

const EMAIL_PATTERN =
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi;
const URL_PATTERN =
  /\b(?:https?|wss?):\/\/[^\s"'<>]+/gi;
const BEARER_PATTERN = /\bBearer\s+[^\s,;]+/gi;
const SENSITIVE_ASSIGNMENT_PATTERN =
  /\b(password(?:confirmation|hash)?|csrf(?:token)?|session(?:token)?|verificationtoken|setuptoken|resettoken|reactivationtoken|authorization|cookie|secret|credential|bid(?:value|amount))\b\s*([:=])\s*(?:"[^"]*"|'[^']*'|[^,;&\r\n]+)/gi;

function isPlainRecord(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function normalizeKey(key) {
  return String(key)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
}

function isSensitiveKey(key) {
  const normalized = normalizeKey(key);

  return (
    normalized === "cookie" ||
    normalized === "setcookie" ||
    normalized === "authorization" ||
    normalized === "headers" ||
    normalized === "email" ||
    normalized === "rawemail" ||
    normalized === "body" ||
    normalized === "request" ||
    normalized === "response" ||
    normalized === "payload" ||
    normalized === "query" ||
    normalized === "querystring" ||
    normalized === "url" ||
    normalized === "uri" ||
    normalized === "href" ||
    normalized === "fragment" ||
    normalized === "activebid" ||
    normalized === "sealedbid" ||
    normalized === "bid" ||
    normalized === "bids" ||
    normalized.includes("password") ||
    normalized.includes("token") ||
    normalized.includes("secret") ||
    normalized.includes("credential") ||
    normalized.includes("csrf") ||
    normalized.includes("emailaddress") ||
    normalized.includes("submittedemail") ||
    normalized.includes("originalurl") ||
    normalized.includes("requestbody") ||
    normalized.includes("responsebody") ||
    normalized.includes("bidvalue") ||
    normalized.includes("bidamount")
  );
}

function createSecretRedactor(sensitiveValues) {
  if (!Array.isArray(sensitiveValues)) {
    throw new TypeError(
      "sensitiveValues must be an array"
    );
  }

  const secrets = [
    ...new Set(
      sensitiveValues.filter(
        (value) =>
          typeof value === "string" &&
          value.length > 0
      )
    ),
  ].sort((left, right) => right.length - left.length);

  return function redactSecrets(value) {
    let redacted = value;
    for (const secret of secrets) {
      redacted = redacted
        .split(secret)
        .join(REDACTED_SECRET);
    }
    return redacted;
  };
}

function sanitizeString(value, redactSecrets) {
  let sanitized = redactSecrets(value);

  sanitized = sanitized
    .replace(BEARER_PATTERN, `Bearer ${REDACTED}`)
    .replace(
      SENSITIVE_ASSIGNMENT_PATTERN,
      (_match, label, separator) =>
        `${label}${separator}${REDACTED}`
    )
    .replace(URL_PATTERN, REDACTED_URL)
    .replace(EMAIL_PATTERN, REDACTED_EMAIL);

  if (sanitized.length > MAX_STRING_LENGTH) {
    return (
      sanitized.slice(0, MAX_STRING_LENGTH) +
      TRUNCATED
    );
  }
  return sanitized;
}

function sanitizeError(error, state, depth) {
  const output = Object.create(null);
  output.name = sanitizeString(
    String(error.name || "Error"),
    state.redactSecrets
  );
  if (
    typeof error.code === "string" ||
    typeof error.code === "number"
  ) {
    output.code = sanitizeString(
      String(error.code),
      state.redactSecrets
    );
  }
  output.message = sanitizeString(
    String(error.message || ""),
    state.redactSecrets
  );
  if (typeof error.stack === "string") {
    output.stack = sanitizeString(
      error.stack,
      state.redactSecrets
    );
  }

  for (const [key, value] of Object.entries(error)) {
    if (Object.hasOwn(output, key)) continue;
    if (Object.keys(output).length >= MAX_CONTEXT_FIELDS) {
      output.truncated = TRUNCATED;
      break;
    }
    output[key] = sanitizeValue(
      value,
      key,
      state,
      depth + 1
    );
  }

  return output;
}

function sanitizeObject(value, state, depth) {
  if (state.seen.has(value)) {
    return CIRCULAR;
  }
  state.seen.add(value);

  const output = Object.create(null);
  let count = 0;
  for (const [key, nestedValue] of Object.entries(value)) {
    if (count >= MAX_CONTEXT_FIELDS) {
      output.truncated = TRUNCATED;
      break;
    }
    output[key] = sanitizeValue(
      nestedValue,
      key,
      state,
      depth + 1
    );
    count += 1;
  }

  return output;
}

function sanitizeValue(
  value,
  key,
  state,
  depth = 0
) {
  if (isSensitiveKey(key)) {
    return REDACTED;
  }
  if (depth > MAX_CONTEXT_DEPTH) {
    return TRUNCATED;
  }
  if (value === null) {
    return null;
  }

  switch (typeof value) {
    case "string":
      return sanitizeString(
        value,
        state.redactSecrets
      );
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value)
        ? value
        : UNSUPPORTED;
    case "bigint":
      return value.toString();
    case "undefined":
    case "function":
    case "symbol":
      return UNSUPPORTED;
    default:
      break;
  }

  if (Buffer.isBuffer(value)) {
    return UNSUPPORTED;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime())
      ? UNSUPPORTED
      : value.toISOString();
  }
  if (value instanceof Error) {
    if (state.seen.has(value)) {
      return CIRCULAR;
    }
    state.seen.add(value);
    return sanitizeError(value, state, depth);
  }
  if (Array.isArray(value)) {
    if (state.seen.has(value)) {
      return CIRCULAR;
    }
    state.seen.add(value);
    const output = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map((item) =>
        sanitizeValue(item, "", state, depth + 1)
      );
    if (value.length > MAX_ARRAY_ITEMS) {
      output.push(TRUNCATED);
    }
    return output;
  }
  if (isPlainRecord(value)) {
    return sanitizeObject(value, state, depth);
  }

  return UNSUPPORTED;
}

function sanitizeLogContext(
  context,
  { sensitiveValues = [] } = {}
) {
  if (!isPlainRecord(context)) {
    throw new TypeError(
      "structured log context must be a plain object"
    );
  }

  const entries = Object.entries(context);
  if (entries.length > MAX_CONTEXT_FIELDS) {
    throw new RangeError(
      `structured log context supports at most ${MAX_CONTEXT_FIELDS} fields`
    );
  }

  const state = {
    redactSecrets:
      createSecretRedactor(sensitiveValues),
    seen: new WeakSet(),
  };
  const output = Object.create(null);

  for (const [key, value] of entries) {
    if (!CONTEXT_KEY_PATTERN.test(key)) {
      throw new TypeError(
        "structured log context contains an invalid field name"
      );
    }
    if (RESERVED_CONTEXT_KEYS.has(key)) {
      throw new TypeError(
        "structured log context contains a reserved field"
      );
    }
    output[key] = sanitizeValue(value, key, state);
  }

  return output;
}

function normalizeSink(sink) {
  if (typeof sink === "function") {
    return sink;
  }
  if (sink && typeof sink.write === "function") {
    return (line) => sink.write(line);
  }
  throw new TypeError(
    "createStructuredLogger requires a writable sink"
  );
}

function createStructuredLogger({
  environment,
  buildId,
  logLevel = "info",
  clock,
  sink = process.stdout,
  sensitiveValues = [],
} = {}) {
  if (
    typeof environment !== "string" ||
    !environment
  ) {
    throw new TypeError(
      "createStructuredLogger requires an environment"
    );
  }
  if (typeof buildId !== "string" || !buildId) {
    throw new TypeError(
      "createStructuredLogger requires a build ID"
    );
  }
  if (!Object.hasOwn(LEVEL_PRIORITY, logLevel)) {
    throw new TypeError(
      "createStructuredLogger requires an approved log level"
    );
  }
  if (!clock || typeof clock.nowIso !== "function") {
    throw new TypeError(
      "createStructuredLogger requires an injected clock"
    );
  }

  const write = normalizeSink(sink);
  const redactionValues = [...sensitiveValues];

  function emit(severity, event, context = {}) {
    if (
      typeof event !== "string" ||
      !EVENT_NAME_PATTERN.test(event)
    ) {
      throw new TypeError(
        "structured log event name is invalid"
      );
    }

    const safeContext = sanitizeLogContext(
      context,
      { sensitiveValues: redactionValues }
    );

    if (
      LEVEL_PRIORITY[severity] <
      LEVEL_PRIORITY[logLevel]
    ) {
      return false;
    }

    const record = {
      timestamp: clock.nowIso(),
      severity,
      event,
      environment,
      buildId,
      ...safeContext,
    };
    write(`${JSON.stringify(record)}\n`);
    return true;
  }

  return Object.freeze({
    debug(event, context) {
      return emit("debug", event, context);
    },
    info(event, context) {
      return emit("info", event, context);
    },
    warn(event, context) {
      return emit("warn", event, context);
    },
    error(event, context) {
      return emit("error", event, context);
    },
  });
}

module.exports = {
  CIRCULAR,
  EVENT_NAME_PATTERN,
  LEVEL_PRIORITY,
  MAX_ARRAY_ITEMS,
  MAX_CONTEXT_DEPTH,
  MAX_CONTEXT_FIELDS,
  MAX_STRING_LENGTH,
  REDACTED,
  REDACTED_EMAIL,
  REDACTED_SECRET,
  REDACTED_URL,
  TRUNCATED,
  UNSUPPORTED,
  createStructuredLogger,
  isSensitiveKey,
  sanitizeLogContext,
};
