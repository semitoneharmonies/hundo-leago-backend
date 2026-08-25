"use strict";

const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  JOB_NAME,
  createProcessFreeAgentDraftAllocationCycleJob,
} = require(
  "../../src/jobs/definitions/processFreeAgentDraftAllocationCycle"
);

function result(job, status = "succeeded", extra = {}) {
  return Object.freeze({ job, status, ...extra });
}

function harness({
  lifecycleResults = [
    result("lifecycle", "succeeded", {
      startedAllocating: 1,
    }),
    result("lifecycle", "succeeded", {
      enteredRapid: 1,
    }),
  ],
  allocationResult = result(
    "allocations",
    "succeeded",
    { succeeded: 1 }
  ),
} = {}) {
  const calls = [];
  const remaining = [...lifecycleResults];
  const errors = [];
  const job =
    createProcessFreeAgentDraftAllocationCycleJob({
      allocationLifecycleJob: {
        async run() {
          calls.push("lifecycle");
          return remaining.shift();
        },
      },
      candidateAllocationJob: {
        async run() {
          calls.push("allocation");
          return allocationResult;
        },
      },
      logger: {
        error(...input) {
          errors.push(input);
        },
      },
    });
  return { calls, errors, job };
}

describe("FAD composed allocation scheduler cycle", () => {
  test("coordinates before and after per-player allocation in one successful cycle", async () => {
    const current = harness();
    const output = await current.job.run();

    assert.deepEqual(current.calls, [
      "lifecycle",
      "allocation",
      "lifecycle",
    ]);
    assert.equal(output.job, JOB_NAME);
    assert.equal(output.status, "succeeded");
    assert.equal(output.before.startedAllocating, 1);
    assert.equal(output.allocation.succeeded, 1);
    assert.equal(output.after.enteredRapid, 1);
    assert.deepEqual(current.errors, []);
  });

  test("still performs post-coordination after an isolated allocation failure and reports the cycle failed", async () => {
    const current = harness({
      allocationResult: result(
        "allocations",
        "failed",
        { failed: 1 }
      ),
    });

    const output = await current.job.run();
    assert.deepEqual(current.calls, [
      "lifecycle",
      "allocation",
      "lifecycle",
    ]);
    assert.equal(output.status, "failed");
    assert.equal(output.allocation.failed, 1);
    assert.equal(output.after.enteredRapid, 1);
  });

  test("fails closed through the shared runner when a nested result is malformed", async () => {
    const current = harness({
      lifecycleResults: [null],
    });

    const output = await current.job.run();
    assert.equal(output.job, JOB_NAME);
    assert.equal(output.status, "failed");
    assert.match(
      output.error.message,
      /pre-allocation lifecycle result/i
    );
    assert.deepEqual(current.calls, ["lifecycle"]);
    assert.equal(current.errors.length, 1);
    assert.equal(
      current.errors[0][0],
      "job_runner.failed"
    );
    assert.deepEqual(current.errors[0][1], {
      job: JOB_NAME,
      classification: "transient",
    });
    assert.equal(
      JSON.stringify(current.errors).includes(
        output.error.message
      ),
      false
    );
  });

  test("validates both nested runners and the logger", () => {
    assert.throws(
      () =>
        createProcessFreeAgentDraftAllocationCycleJob(),
      /lifecycle runner/i
    );
    assert.throws(
      () =>
        createProcessFreeAgentDraftAllocationCycleJob({
          allocationLifecycleJob: { run() {} },
        }),
      /per-player allocation runner/i
    );
    assert.throws(
      () =>
        createProcessFreeAgentDraftAllocationCycleJob({
          allocationLifecycleJob: { run() {} },
          candidateAllocationJob: { run() {} },
          logger: {},
        }),
      /error logger/i
    );
  });
});
