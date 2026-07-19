function createFakePublisher() {
  const calls = [];
  let nextFailure = null;

  return {
    calls,
    failNext(error = new Error("fake publisher failure")) {
      nextFailure = error;
    },
    clear() {
      calls.length = 0;
      nextFailure = null;
    },
    async publish(eventName, payload) {
      if (nextFailure) {
        const error = nextFailure;
        nextFailure = null;
        throw error;
      }

      calls.push({
        eventName,
        payload: structuredClone(payload),
      });
    },
  };
}

module.exports = { createFakePublisher };
