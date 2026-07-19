function assertSafeTimestamp(value) {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError("clock value must be a safe integer UTC millisecond");
  }
}

function createFixedClock(initialMs) {
  assertSafeTimestamp(initialMs);
  let currentMs = initialMs;

  return {
    nowMs() {
      return currentMs;
    },
    set(nextMs) {
      assertSafeTimestamp(nextMs);
      currentMs = nextMs;
      return currentMs;
    },
    advance(deltaMs) {
      assertSafeTimestamp(deltaMs);
      const nextMs = currentMs + deltaMs;
      assertSafeTimestamp(nextMs);
      currentMs = nextMs;
      return currentMs;
    },
  };
}

module.exports = { createFixedClock };
