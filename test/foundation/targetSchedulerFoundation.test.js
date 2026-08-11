const assert = require("node:assert/strict");
const test = require("node:test");

const {
  createTargetScheduler,
} = require("../../src/application/services/operations/createTargetScheduler");

function harness(overrides = {}) {
  const states = [];
  const calls = [];
  const handles = [];
  const runner = (name, implementation = async () => ({ status: "succeeded" })) => ({
    name,
    runner: {
      async run() {
        calls.push(name);
        return implementation();
      },
    },
  });
  const email = {
    starts: 0,
    closes: 0,
    start() {
      this.starts += 1;
      return { initialRun: Promise.resolve(), recovered: 2 };
    },
    async close() {
      this.closes += 1;
    },
  };
  const scheduler = createTargetScheduler({
    enabled: true,
    emailEnabled: true,
    leagueWriteMode: "open",
    jobs: [runner("domain"), runner("outbox")],
    emailJob: email,
    health: { setSchedulerState: (state) => states.push(state) },
    logger: { error() {} },
    setIntervalFunction(callback, intervalMs) {
      const handle = { callback, intervalMs, unref() {} };
      handles.push(handle);
      return handle;
    },
    clearIntervalFunction(handle) {
      handle.cleared = true;
    },
    ...overrides,
  });
  return { calls, email, handles, runner, scheduler, states };
}

test("disabled and maintenance-paused schedulers create no work", async () => {
  for (const input of [
    { enabled: false, leagueWriteMode: "open", expected: "disabled" },
    { enabled: true, leagueWriteMode: "closed", expected: "paused_maintenance" },
  ]) {
    const evidence = harness({ ...input, emailEnabled: false });
    assert.deepEqual(evidence.scheduler.start(), { status: input.expected });
    assert.equal(evidence.scheduler.getState(), input.expected);
    assert.deepEqual(evidence.calls, []);
    assert.equal(evidence.email.starts, 0);
    assert.equal(evidence.handles.length, 0);
    await evidence.scheduler.close();
    assert.deepEqual(evidence.calls, []);
  }
});

test("email-only scheduler starts and closes email without running league jobs", async () => {
  const evidence = harness({
    enabled: false,
    emailEnabled: true,
    leagueWriteMode: "open",
  });
  const started = evidence.scheduler.start();
  assert.equal(started.status, "email_only");
  assert.equal(started.emailRecovered, 2);
  await started.emailInitialRun;
  assert.deepEqual(evidence.calls, []);
  assert.equal(evidence.email.starts, 1);
  assert.equal(evidence.handles.length, 0);
  assert.equal(evidence.scheduler.getState(), "disabled");
  await evidence.scheduler.close();
  assert.equal(evidence.email.closes, 1);
  assert.equal(evidence.scheduler.getState(), "disabled");
});

test("enabled open scheduler starts email and runs jobs in declared order", async () => {
  const evidence = harness();
  const started = evidence.scheduler.start();
  assert.equal(started.status, "running");
  assert.equal(started.emailRecovered, 2);
  assert.deepEqual(await started.initialRun, {
    status: "succeeded",
    outcomes: [
      { name: "domain", result: { status: "succeeded" } },
      { name: "outbox", result: { status: "succeeded" } },
    ],
  });
  assert.deepEqual(evidence.calls, ["domain", "outbox"]);
  assert.equal(evidence.email.starts, 1);
  assert.equal(evidence.handles.length, 1);
  assert.deepEqual(evidence.states, ["starting", "running"]);
  await evidence.scheduler.close();
  assert.equal(evidence.handles[0].cleared, true);
  assert.equal(evidence.email.closes, 1);
  assert.deepEqual(evidence.states, ["starting", "running", "stopping", "stopped"]);
});

test("awaits the composed FAD auction chain before ordinary resolution and completion", async () => {
  const order = [
    "free_agent_draft_auction_resolution",
    "free_agent_draft_restricted_activation",
    "free_agent_draft_fallback_activation",
    "free_agent_draft_queued_nomination_activation",
    "free_agent_draft_rollover_finalization",
    "auction_resolution",
    "free_agent_draft_completion",
  ];
  const observations = [];
  const completed = [];
  const jobs = order.map((name, index) => ({
    name,
    runner: {
      async run() {
        assert.deepEqual(completed, order.slice(0, index));
        observations.push(`start:${name}`);
        await Promise.resolve();
        completed.push(name);
        observations.push(`complete:${name}`);
        return { status: "succeeded" };
      },
    },
  }));
  const scheduler = createTargetScheduler({
    enabled: true,
    emailEnabled: false,
    leagueWriteMode: "open",
    jobs,
    health: { setSchedulerState() {} },
    logger: { error() {} },
    setIntervalFunction: () => ({ unref() {} }),
    clearIntervalFunction() {},
  });

  const cycle = await scheduler.start().initialRun;

  assert.equal(cycle.status, "succeeded");
  assert.deepEqual(
    cycle.outcomes.map(({ name }) => name),
    order
  );
  assert.deepEqual(
    observations,
    order.flatMap((name) => [
      `start:${name}`,
      `complete:${name}`,
    ])
  );
  await scheduler.close();

  const disabledCalls = [];
  const disabledScheduler = createTargetScheduler({
    enabled: false,
    emailEnabled: false,
    leagueWriteMode: "open",
    jobs: order.map((name) => ({
      name,
      runner: {
        async run() {
          disabledCalls.push(name);
          return { status: "succeeded" };
        },
      },
    })),
    health: { setSchedulerState() {} },
    logger: { error() {} },
  });
  assert.deepEqual(
    disabledScheduler.start(),
    { status: "disabled" }
  );
  assert.deepEqual(
    await disabledScheduler.runCycle(),
    { status: "skipped", reason: "not_running" }
  );
  assert.deepEqual(disabledCalls, []);
  await disabledScheduler.close();
});

test("scheduler suppresses overlapping cycles and drains before close", async () => {
  let release;
  const blocked = new Promise((resolve) => {
    release = resolve;
  });
  const evidence = harness();
  evidence.scheduler = createTargetScheduler({
    enabled: true,
    emailEnabled: false,
    leagueWriteMode: "open",
    jobs: [
      evidence.runner("domain", async () => {
        await blocked;
        return { status: "succeeded" };
      }),
    ],
    health: { setSchedulerState: (state) => evidence.states.push(state) },
    logger: { error() {} },
    setIntervalFunction: () => ({ unref() {} }),
    clearIntervalFunction() {},
  });
  const initial = evidence.scheduler.start().initialRun;
  assert.deepEqual(await evidence.scheduler.runCycle(), {
    status: "skipped",
    reason: "overlap",
  });
  const closing = evidence.scheduler.close();
  assert.equal(evidence.scheduler.getState(), "stopping");
  release();
  await Promise.all([initial, closing]);
  assert.equal(evidence.scheduler.getState(), "stopped");
});

test("one failed job is contained and later jobs still run", async () => {
  const evidence = harness();
  const errors = [];
  const scheduler = createTargetScheduler({
    enabled: true,
    emailEnabled: false,
    leagueWriteMode: "open",
    jobs: [
      evidence.runner("throws", async () => {
        throw new Error("private provider detail");
      }),
      evidence.runner("outbox"),
    ],
    health: { setSchedulerState() {} },
    logger: { error: (...args) => errors.push(args) },
    setIntervalFunction: () => ({ unref() {} }),
    clearIntervalFunction() {},
  });
  const result = await scheduler.start().initialRun;
  assert.equal(result.status, "failed");
  assert.deepEqual(evidence.calls, ["throws", "outbox"]);
  assert.deepEqual(errors, [
    [
      "target_scheduler.job_failed",
      { code: "TARGET_SCHEDULED_JOB_FAILED", job: "throws" },
    ],
  ]);
  await scheduler.close();
});
