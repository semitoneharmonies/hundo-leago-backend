const assert = require("node:assert/strict");
const { test } = require("node:test");
const { createSessionSocketInvalidator } = require("../../src/infrastructure/socket/createSessionSocketInvalidator");

test("session invalidation defers, coalesces users, and continues after a connection failure", async () => {
  const sockets = new Map([
    ["a", { userId: "changed", id: "a", disconnect() { throw new Error("gone"); } }],
    ["b", { userId: "changed", id: "b" }],
    ["c", { userId: "other", id: "c" }],
  ]);
  const checked = [];
  const notify = createSessionSocketInvalidator({
    getIo: () => ({ sockets: { sockets } }),
    getSocketRooms: () => ({
      getAuthority: (socket) => ({ userId: socket.userId }),
      async reauthorize(socket) {
        checked.push(socket.id);
        if (socket.id === "a") throw new Error("connection unavailable");
      },
    }),
  });
  notify("changed");
  notify("changed");
  assert.deepEqual(checked, []);
  await new Promise(setImmediate);
  assert.deepEqual(checked, ["a", "b"]);
});

test("session invalidation tolerates a runtime without an attached socket server", async () => {
  const notify = createSessionSocketInvalidator({ getIo: () => null, getSocketRooms: () => null });
  notify("changed");
  await new Promise(setImmediate);
});
