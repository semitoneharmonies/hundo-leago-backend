const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createFreeAgentDraftTransitionWriterDispatcher,
} = require(
  "../../src/infrastructure/persistence/sqlite/createFreeAgentDraftTransitionWriterDispatcher"
);

function route(
  fromStatus,
  toStatus,
  writer
) {
  return { fromStatus, toStatus, writer };
}

function command(fromStatus, toStatus) {
  return { fromStatus, toStatus, witness: {} };
}

test("routes each registered before-transition edge to only its configured writer", () => {
  const calls = [];
  const makeWriter = (name) => ({
    beforeTransition(input) {
      calls.push({ input, name });
      return `${name}:before`;
    },
  });
  const dispatcher =
    createFreeAgentDraftTransitionWriterDispatcher([
      route(
        "cards_open",
        "deadline_locked",
        makeWriter("deadline")
      ),
      route(
        "deadline_locked",
        "allocating",
        makeWriter("coordinator")
      ),
      route(
        "allocating",
        "rapid",
        makeWriter("completion")
      ),
    ]);
  const inputs = [
    command("cards_open", "deadline_locked"),
    command("deadline_locked", "allocating"),
    command("allocating", "rapid"),
  ];

  assert.equal(
    dispatcher.beforeTransition(inputs[0]),
    "deadline:before"
  );
  assert.equal(
    dispatcher.beforeTransition(inputs[1]),
    "coordinator:before"
  );
  assert.equal(
    dispatcher.beforeTransition(inputs[2]),
    "completion:before"
  );
  assert.deepEqual(
    calls.map(({ name }) => name),
    ["deadline", "coordinator", "completion"]
  );
  assert.deepEqual(
    calls.map(({ input }) => input),
    inputs
  );
});

test("routes after-transition by only the effective command and no-ops when that writer has no after hook", () => {
  const calls = [];
  const deadlineWriter = {
    beforeTransition() {},
    afterTransition(input) {
      calls.push(input);
      return "deadline:after";
    },
  };
  const allocationWriter = {
    beforeTransition() {},
  };
  const dispatcher =
    createFreeAgentDraftTransitionWriterDispatcher([
      route(
        "cards_open",
        "deadline_locked",
        deadlineWriter
      ),
      route(
        "deadline_locked",
        "allocating",
        allocationWriter
      ),
    ]);
  const deadlinePayload = {
    fromStatus: "deadline_locked",
    toStatus: "allocating",
    effectiveCommand: command(
      "cards_open",
      "deadline_locked"
    ),
    existing: {},
    updated: {},
  };
  const allocationPayload = {
    fromStatus: "cards_open",
    toStatus: "deadline_locked",
    effectiveCommand: command(
      "deadline_locked",
      "allocating"
    ),
    existing: {},
    updated: {},
  };

  assert.equal(
    dispatcher.afterTransition(deadlinePayload),
    "deadline:after"
  );
  assert.strictEqual(calls[0], deadlinePayload);
  assert.equal(
    dispatcher.afterTransition(allocationPayload),
    undefined
  );
  assert.equal(calls.length, 1);
});

test("preserves writer this binding, input identity, thrown errors, and promise values", () => {
  const marker = Symbol("writer");
  const thrown = new Error("writer failed");
  const promise = Promise.resolve("async result");
  let invocation = 0;
  let observedInput;
  const writer = {
    marker,
    beforeTransition(input) {
      assert.equal(this.marker, marker);
      observedInput = input;
      invocation += 1;
      if (invocation === 1) throw thrown;
      return promise;
    },
  };
  const dispatcher =
    createFreeAgentDraftTransitionWriterDispatcher([
      route(
        "cards_open",
        "deadline_locked",
        writer
      ),
    ]);
  const input = command(
    "cards_open",
    "deadline_locked"
  );

  assert.throws(
    () => dispatcher.beforeTransition(input),
    (error) => error === thrown
  );
  assert.strictEqual(observedInput, input);
  assert.strictEqual(
    dispatcher.beforeTransition(input),
    promise
  );
});

test("rejects malformed, unknown, noncanonical, and duplicate configuration", () => {
  const writer = { beforeTransition() {} };
  assert.throws(
    () =>
      createFreeAgentDraftTransitionWriterDispatcher(),
    /exact nonempty FAD transition route array/
  );
  assert.throws(
    () =>
      createFreeAgentDraftTransitionWriterDispatcher([]),
    /exact nonempty FAD transition route array/
  );
  const sparse = [];
  sparse.length = 1;
  assert.throws(
    () =>
      createFreeAgentDraftTransitionWriterDispatcher(
        sparse
      ),
    /exact nonempty FAD transition route array/
  );
  assert.throws(
    () =>
      createFreeAgentDraftTransitionWriterDispatcher([
        {
          fromStatus: "cards_open",
          toStatus: "deadline_locked",
          writer,
          extra: true,
        },
      ]),
    /must contain exactly/
  );
  assert.throws(
    () =>
      createFreeAgentDraftTransitionWriterDispatcher([
        route("unknown", "deadline_locked", writer),
      ]),
    /canonical FAD transition route edge/
  );
  assert.throws(
    () =>
      createFreeAgentDraftTransitionWriterDispatcher([
        route("cards_open", "rapid", writer),
      ]),
    /canonical FAD transition route edge/
  );
  assert.throws(
    () =>
      createFreeAgentDraftTransitionWriterDispatcher([
        route(
          "cards_open",
          "deadline_locked",
          {}
        ),
      ]),
    /must expose beforeTransition/
  );
  assert.throws(
    () =>
      createFreeAgentDraftTransitionWriterDispatcher([
        route(
          "cards_open",
          "deadline_locked",
          {
            beforeTransition() {},
            afterTransition: null,
          }
        ),
      ]),
    /afterTransition must be a function/
  );
  assert.throws(
    () =>
      createFreeAgentDraftTransitionWriterDispatcher([
        route(
          "cards_open",
          "deadline_locked",
          writer
        ),
        route(
          "cards_open",
          "deadline_locked",
          writer
        ),
      ]),
    /Duplicate FAD transition route/
  );
});

test("fails closed for unregistered and malformed hook edges", () => {
  const dispatcher =
    createFreeAgentDraftTransitionWriterDispatcher([
      route(
        "cards_open",
        "deadline_locked",
        { beforeTransition() {} }
      ),
    ]);

  assert.throws(
    () =>
      dispatcher.beforeTransition(
        command("deadline_locked", "allocating")
      ),
    /No FAD transition writer is registered/
  );
  assert.throws(
    () => dispatcher.beforeTransition({}),
    /command edge is required/
  );
  assert.throws(
    () =>
      dispatcher.beforeTransition(
        command("cards_open", "unknown")
      ),
    /canonical before-transition command edge/
  );
  assert.throws(
    () => dispatcher.afterTransition({}),
    /exact FAD after-transition payload/
  );
  assert.throws(
    () =>
      dispatcher.afterTransition({
        effectiveCommand: command(
          "deadline_locked",
          "allocating"
        ),
      }),
    /No FAD transition writer is registered/
  );
});

test("freezes the dispatcher configuration snapshot against later caller mutation", () => {
  const calls = [];
  const originalWriter = {
    beforeTransition() {
      calls.push("original");
    },
  };
  const configuredRoute = route(
    "cards_open",
    "deadline_locked",
    originalWriter
  );
  const routes = [configuredRoute];
  const dispatcher =
    createFreeAgentDraftTransitionWriterDispatcher(
      routes
    );

  assert.equal(Object.isFrozen(dispatcher), true);
  configuredRoute.fromStatus = "rapid";
  configuredRoute.toStatus = "completed";
  originalWriter.beforeTransition = () => {
    calls.push("replacement");
  };
  routes[0] = route(
    "rapid",
    "completed",
    originalWriter
  );
  routes.push(
    route("deadline_locked", "allocating", originalWriter)
  );

  dispatcher.beforeTransition(
    command("cards_open", "deadline_locked")
  );
  assert.deepEqual(calls, ["original"]);
  assert.throws(
    () =>
      dispatcher.beforeTransition(
        command("deadline_locked", "allocating")
      ),
    /No FAD transition writer is registered/
  );
});
