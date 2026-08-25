function assertUtcMilliseconds(value) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(
      "clock source must return safe-integer UTC milliseconds"
    );
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new RangeError(
      "clock source returned an unsupported UTC timestamp"
    );
  }

  return value;
}

function createSample(value) {
  const nowMs = assertUtcMilliseconds(value);
  return Object.freeze({
    nowMs,
    nowIso: new Date(nowMs).toISOString(),
  });
}

function createSystemClock({
  now = Date.now,
} = {}) {
  if (typeof now !== "function") {
    throw new TypeError(
      "createSystemClock requires a time-source function"
    );
  }

  return Object.freeze({
    nowMs() {
      return assertUtcMilliseconds(now());
    },
    nowIso() {
      return createSample(now()).nowIso;
    },
    sample() {
      return createSample(now());
    },
  });
}

module.exports = {
  assertUtcMilliseconds,
  createSystemClock,
};
