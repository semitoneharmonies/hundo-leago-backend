function createSocketIoCompatibilityPublisher({
  app,
} = {}) {
  if (!app || typeof app.get !== "function") {
    throw new TypeError(
      "createSocketIoCompatibilityPublisher requires an application"
    );
  }

  function publish(eventName, payload) {
    const io = app.get("io");
    if (!io || typeof io.emit !== "function") {
      return false;
    }

    io.emit(eventName, payload);
    return true;
  }

  return { publish };
}

module.exports = {
  createSocketIoCompatibilityPublisher,
};
