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

test('team assignments remain inactive before start, when absent, disabled or under maintenance', async () => {
  let calls = 0;
  const teamAssignmentsJob = { async run() { calls++; return { status: 'succeeded' }; } };
  for (const options of [{ enabled: false }, { leagueWriteMode: 'closed' }]) {
    const state = harness({ ...options, teamAssignmentsJob });
    assert.equal((await state.scheduler.runTeamAssignmentsCycle()).reason, 'not_running');
    const started = state.scheduler.start();
    assert.equal(started.teamAssignmentsInitialRun, undefined);
    assert.equal(state.handles.length, 0);
    assert.equal((await state.scheduler.runTeamAssignmentsCycle()).reason, 'not_running');
    await state.scheduler.close();
  }
  const absent = harness();
  await absent.scheduler.start().initialRun;
  assert.equal((await absent.scheduler.runTeamAssignmentsCycle()).reason, 'not_running');
  await absent.scheduler.close();
  assert.equal(calls, 0);
  assert.throws(() => harness({ teamAssignmentsJob: {} }), /controlled team-assignment job/);
});

test('blocked team feed cannot delay league cycles or live polling, never overlaps, and shutdown drains it', async () => {
  let release, teamCalls = 0, liveCalls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const state = harness({
    teamAssignmentsJob: { run() { teamCalls++; return pending; } },
    liveStatisticsJob: { job: { async run() { liveCalls++; return { status: 'succeeded' }; } } },
  });
  const started = state.scheduler.start();
  assert.equal(state.scheduler.start(), started);
  await started.initialRun;
  assert.equal(teamCalls, 1);
  assert.deepEqual(state.handles.map(handle => handle.intervalMs), [30000, 10000, 30000]);
  assert.equal((await state.scheduler.runTeamAssignmentsCycle()).reason, 'overlap');
  state.handles[2].callback();
  await Promise.resolve();
  assert.equal(teamCalls, 1);
  assert.equal((await state.scheduler.runCycle()).status, 'succeeded');
  assert.equal((await state.scheduler.runLiveCycle()).status, 'succeeded');
  assert.equal(liveCalls, 1);
  assert.deepEqual(state.calls, ['domain', 'outbox', 'domain', 'outbox']);
  let closed = false;
  const closing = state.scheduler.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.ok(state.handles.every(handle => handle.cleared));
  assert.equal((await state.scheduler.runTeamAssignmentsCycle()).reason, 'not_running');
  release({ status: 'succeeded' });
  assert.equal((await started.teamAssignmentsInitialRun).status, 'succeeded');
  await closing;
  assert.equal(closed, true); assert.equal(state.scheduler.getState(), 'stopped');
});

test('team assignment timer resumes after completion while failures stay bounded and isolated', async () => {
  const errors = [];
  let calls = 0;
  const state = harness({ teamAssignmentsJob: { run() {
    calls++;
    if (calls === 1) throw new Error('private provider response');
    return Promise.resolve({ status: 'succeeded' });
  } }, logger: { error: (...args) => errors.push(args) } });
  const started = state.scheduler.start();
  assert.deepEqual(await started.teamAssignmentsInitialRun, { status: 'failed', code: 'TARGET_TEAM_ASSIGNMENTS_FAILED' });
  await started.initialRun;
  assert.equal(state.scheduler.getState(), 'running');
  assert.equal((await state.scheduler.runCycle()).status, 'succeeded');
  assert.deepEqual(errors, [['target_scheduler.team_assignments_failed', { code: 'TARGET_TEAM_ASSIGNMENTS_FAILED' }]]);
  state.handles[1].callback();
  await Promise.resolve();
  assert.equal(calls, 2);
  await state.scheduler.close();
});

test('live statistics stays disabled with league jobs or maintenance, and requires a controlled runner', async () => {
  let liveCalls = 0;
  const liveStatisticsJob = { job: { async run() { liveCalls += 1; } } };
  for (const options of [{ enabled: false }, { leagueWriteMode: 'closed' }]) {
    const state = harness({ ...options, liveStatisticsJob });
    state.scheduler.start();
    assert.equal(state.handles.length, 0);
    assert.equal((await state.scheduler.runLiveCycle()).reason, 'not_running');
    await state.scheduler.close();
  }
  assert.equal(liveCalls, 0);
  assert.throws(() => harness({ liveStatisticsJob: {} }), /controlled live statistics/);
});

test('independent live tick defers to pending league work and starts only after that cycle finishes', async () => {
  let release, liveCalls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const state = harness({ jobs: [{ name: 'lock', runner: { run: () => pending } }],
    liveStatisticsJob: { job: { async run() { liveCalls += 1; return { status: 'succeeded' }; } } } });
  const initial = state.scheduler.start().initialRun;
  assert.deepEqual(state.handles.map(handle => handle.intervalMs), [30000, 10000]);
  assert.equal((await state.scheduler.runLiveCycle()).reason, 'league_jobs_running');
  assert.equal(liveCalls, 0);
  release({ status: 'succeeded' }); await initial;
  assert.equal((await state.scheduler.runLiveCycle()).status, 'succeeded');
  assert.equal(liveCalls, 1);
  await state.scheduler.close();
  assert.ok(state.handles.every(handle => handle.cleared));
});

test('slow live work never delays the next league cycle, never overlaps itself, and shutdown waits for it', async () => {
  let release, liveCalls = 0;
  const pending = new Promise(resolve => { release = resolve; });
  const state = harness({ liveStatisticsJob: { job: { run() { liveCalls += 1; return pending; } } } });
  await state.scheduler.start().initialRun;
  const liveRun = state.scheduler.runLiveCycle();
  await Promise.resolve();
  assert.equal((await state.scheduler.runLiveCycle()).reason, 'overlap');
  assert.equal((await state.scheduler.runCycle()).status, 'succeeded');
  assert.deepEqual(state.calls, ['domain', 'outbox', 'domain', 'outbox']);
  assert.equal(liveCalls, 1);
  let closed = false;
  const closing = state.scheduler.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  assert.ok(state.handles.every(handle => handle.cleared));
  assert.equal((await state.scheduler.runLiveCycle()).reason, 'not_running');
  release({ status: 'succeeded' }); await liveRun; await closing;
  assert.equal(closed, true);
  assert.equal(state.scheduler.getState(), 'stopped');
});

test('live feed failure is isolated from ordinary scheduler health and subsequent league jobs', async () => {
  const errors = [];
  const state = harness({ liveStatisticsJob: { job: { async run() { throw new Error('private upstream error'); } } },
    logger: { error: (...args) => errors.push(args) } });
  await state.scheduler.start().initialRun;
  assert.deepEqual(await state.scheduler.runLiveCycle(), { status: 'failed', code: 'TARGET_LIVE_STATISTICS_FAILED' });
  assert.equal(state.scheduler.getState(), 'running');
  assert.equal((await state.scheduler.runCycle()).status, 'succeeded');
  assert.equal(JSON.stringify(errors).includes('private upstream error'), false);
  await state.scheduler.close();
});

test("Daily companion backup honors the open scheduler gate without changing main backup lifecycle", async () => {
  for (const options of [{ enabled: false }, { leagueWriteMode: "closed" }, {}]) {
    let dailyStarts = 0, dailyCloses = 0, mainStarts = 0;
    const state = harness({ ...options, backupEnabled: true,
      backupJob: { start() { mainStarts++; return { initialRun: Promise.resolve("main-only") }; }, async close() {} },
      dailyBackupJob: { start() { dailyStarts++; return { initialRun: Promise.resolve("daily-only") }; }, async close() { dailyCloses++; } },
    });
    const started = state.scheduler.start();
    assert.equal(await started.backupInitialRun, "main-only");
    await started.initialRun;
    assert.equal(mainStarts, 1);
    assert.equal(dailyStarts, Object.keys(options).length ? 0 : 1);
    await state.scheduler.close();
    assert.equal(dailyCloses, dailyStarts);
  }
});

test("Daily backup startup and delivery failures cannot fail Leago scheduler health", async () => {
  for (const immediate of [true, false]) {
    const errors = [];
    const state = harness({ dailyBackupJob: {
      start() {
        if (immediate) throw new Error("private backup failure");
        return { initialRun: Promise.reject(new Error("private backup failure")) };
      }, async close() { throw new Error("private shutdown failure"); },
    }, logger: { error: (...args) => errors.push(args) } });
    await state.scheduler.start().initialRun;
    assert.equal(state.scheduler.getState(), "running");
    assert.equal((await state.scheduler.runCycle()).status, "succeeded");
    await state.scheduler.close();
    assert.equal(state.scheduler.getState(), "stopped");
    assert.ok(errors.length);
    assert.equal(JSON.stringify(errors).includes("private"), false);
  }
});

test("Daily backup shutdown drains pending companion work before releasing the runtime", async () => {
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const state = harness({ dailyBackupJob: { start: () => ({ initialRun: pending }), close: () => pending } });
  await state.scheduler.start().initialRun;
  let closed = false;
  const closing = state.scheduler.close().then(() => { closed = true; });
  await Promise.resolve();
  assert.equal(closed, false);
  release();
  await closing;
  assert.equal(closed, true);
});

test("backup lifecycle runs while league writes or jobs are disabled and shutdown drains its pending work", async () => {
  for (const enabled of [true, false]) {
    let finish;
    let closes = 0;
    const pending = new Promise((resolve) => { finish = resolve; });
    const backupJob = { start: () => ({ initialRun: pending }), async close() { closes += 1; await pending; } };
    const state = harness({ enabled, emailEnabled: false, leagueWriteMode: "closed", backupEnabled: true, backupJob });
    const start = state.scheduler.start();
    assert.equal(start.status, "backup_only");
    assert.equal(start.backupInitialRun, pending);
    assert.deepEqual(state.calls, []);
    let closed = false;
    const closing = state.scheduler.close().then(() => { closed = true; });
    await Promise.resolve();
    assert.equal(closed, false);
    assert.equal(closes, 1);
    finish({ status: "succeeded" });
    await closing;
    await state.scheduler.close();
    assert.equal(closes, 1);
  }
});

test("disabled backup lifecycle never starts and enabled backup requires a runner", async () => {
  const backupJob = { start() { throw new Error("disabled worker started"); }, close() { throw new Error("disabled worker closed"); } };
  const state = harness({ backupEnabled: false, backupJob });
  await state.scheduler.start().initialRun;
  await state.scheduler.close();
  assert.throws(() => harness({ backupEnabled: true }), /controlled backup job/);
});

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
