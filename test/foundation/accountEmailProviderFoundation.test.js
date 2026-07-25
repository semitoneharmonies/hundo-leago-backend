const assert = require("node:assert/strict");
const { describe, test } = require("node:test");

const {
  createAccountEmailDeliveryJob,
} = require(
  "../../src/application/services/accounts/createAccountEmailDeliveryJob"
);
const {
  createConfiguredAccountEmailAdapter,
} = require(
  "../../src/infrastructure/email/createConfiguredAccountEmailAdapter"
);
const {
  AccountEmailProviderError,
  RESEND_EMAIL_ENDPOINT,
  RESEND_SANDBOX_RECIPIENT,
  createResendEmailAdapter,
} = require(
  "../../src/infrastructure/email/createResendEmailAdapter"
);
const {
  ACTION_LINKS,
  SECURITY_NOTIFICATIONS,
  renderAccountActionLink,
  renderEmailVerification,
  renderSecurityNotification,
} = require("../../src/infrastructure/email/renderAccountEmail");

const API_KEY = "re_m3_21_fake_provider_key_0123456789";
const TOKEN = "A".repeat(43);
const NOW_MS = Date.parse("2026-07-21T18:30:00.000Z");
const EXPIRES_AT_MS = NOW_MS + 30 * 60 * 1000;

function verification(overrides = {}) {
  return {
    expiresAtMs: EXPIRES_AT_MS,
    idempotencyKey: "verification/event-1",
    to: "manager@example.test",
    verificationUrl: `https://hundo.example/verify-email#token=${TOKEN}`,
    ...overrides,
  };
}

function action(actionKind, overrides = {}) {
  return {
    actionKind,
    actionUrl: `https://hundo.example/action#token=${TOKEN}`,
    expiresAtMs: EXPIRES_AT_MS,
    idempotencyKey: `action/${actionKind}`,
    to: "manager@example.test",
    ...overrides,
  };
}

function notification(notificationKind, overrides = {}) {
  return {
    idempotencyKey: `notification/${notificationKind}`,
    notificationKind,
    occurredAtMs: NOW_MS,
    to: "manager@example.test",
    ...overrides,
  };
}

function response(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return typeof payload === "string" ? payload : JSON.stringify(payload);
    },
  };
}

describe("M3-21 account email rendering", () => {
  test("renders verification and every approved action link without third-party content", () => {
    const rendered = [
      renderEmailVerification(verification()),
      ...Object.keys(ACTION_LINKS).map((kind) =>
        renderAccountActionLink(action(kind))
      ),
    ];

    assert.equal(rendered.length, 4);
    for (const message of rendered) {
      assert.equal(Object.isFrozen(message), true);
      assert.match(message.subject, /Hundo Leago/);
      assert.match(message.text, new RegExp(TOKEN));
      assert.match(message.html, new RegExp(TOKEN));
      assert.match(message.text, /expires at 2026-07-21T19:00:00.000Z/);
      assert.doesNotMatch(message.html, /<img|<script|analytics|tracking/iu);
    }
  });

  test("renders every mandatory security notification without an action token", () => {
    const rendered = Object.keys(SECURITY_NOTIFICATIONS).map((kind) =>
      renderSecurityNotification(notification(kind))
    );

    assert.equal(rendered.length, 6);
    for (const message of rendered) {
      assert.match(message.subject, /Hundo Leago/);
      assert.match(message.text, /2026-07-21T18:30:00.000Z/);
      assert.doesNotMatch(message.text, /token=/u);
      assert.doesNotMatch(message.html, /token=|<img|<script/iu);
    }
  });

  test("escapes link values used in HTML", () => {
    const message = renderEmailVerification({
      ...verification(),
      verificationUrl:
        `https://hundo.example/verify-email#token=${TOKEN}&label=<unsafe>`,
    });
    assert.match(message.html, /&amp;label=&lt;unsafe&gt;/u);
    assert.doesNotMatch(message.html, /<unsafe>/u);
  });
});

describe("M3-21 Resend account email adapter", () => {
  test("sends exact authenticated JSON with provider idempotency and reply-to", async () => {
    const requests = [];
    const adapter = createResendEmailAdapter({
      apiKey: API_KEY,
      deliveryMode: "send",
      from: "Hundo Leago <accounts@hundo.example>",
      replyTo: "support@hundo.example",
      async fetchImplementation(url, options) {
        requests.push({ url, options });
        return response(200, { id: "email-provider-id-1" });
      },
    });

    const result = await adapter.sendEmailVerification(verification());
    assert.deepEqual(result, {
      accepted: true,
      duplicate: false,
      providerMessageId: "email-provider-id-1",
    });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].url, RESEND_EMAIL_ENDPOINT);
    assert.equal(requests[0].options.method, "POST");
    assert.equal(
      requests[0].options.headers.Authorization,
      `Bearer ${API_KEY}`
    );
    assert.equal(
      requests[0].options.headers["Idempotency-Key"],
      "verification/event-1"
    );
    const body = JSON.parse(requests[0].options.body);
    assert.deepEqual(body.to, ["manager@example.test"]);
    assert.equal(body.from, "Hundo Leago <accounts@hundo.example>");
    assert.equal(body.reply_to, "support@hundo.example");
    assert.match(body.text, new RegExp(TOKEN));
    assert.match(body.html, new RegExp(TOKEN));
    assert.equal(JSON.stringify(adapter).includes(API_KEY), false);
  });

  test("forces staging sandbox traffic to Resend's non-delivering test recipient", async () => {
    let requestBody;
    const adapter = createResendEmailAdapter({
      apiKey: API_KEY,
      deliveryMode: "sandbox",
      from: "Hundo Leago <accounts@hundo.example>",
      async fetchImplementation(_url, options) {
        requestBody = options.body;
        return response(200, { id: "sandbox-email-id" });
      },
    });

    await adapter.sendAccountActionLink(action("password_reset"));
    assert.deepEqual(JSON.parse(requestBody).to, [RESEND_SANDBOX_RECIPIENT]);
    assert.equal(requestBody.includes("manager@example.test"), false);
  });

  test("uses the same provider boundary for all approved security notifications", async () => {
    const subjects = [];
    const adapter = createResendEmailAdapter({
      apiKey: API_KEY,
      deliveryMode: "send",
      from: "accounts@hundo.example",
      async fetchImplementation(_url, options) {
        subjects.push(JSON.parse(options.body).subject);
        return response(200, { id: `provider-${subjects.length}` });
      },
    });
    for (const kind of Object.keys(SECURITY_NOTIFICATIONS)) {
      await adapter.sendSecurityNotification(notification(kind));
    }
    assert.equal(subjects.length, 6);
    assert.equal(new Set(subjects).size, 6);
  });

  test("maps safe retryable and terminal failures without exposing provider bodies", async () => {
    const cases = [
      [409, { name: "concurrent_idempotent_requests", private: API_KEY }, true],
      [409, { name: "invalid_idempotent_request", private: API_KEY }, false],
      [429, { name: "rate_limit_exceeded", private: API_KEY }, true],
      [500, { name: "application_error", private: API_KEY }, true],
      [400, { name: "validation_error", private: API_KEY }, false],
      [403, { name: "invalid_api_key", private: API_KEY }, false],
    ];

    for (const [status, payload, retryable] of cases) {
      const adapter = createResendEmailAdapter({
        apiKey: API_KEY,
        deliveryMode: "send",
        from: "accounts@hundo.example",
        fetchImplementation: async () => response(status, payload),
      });
      await assert.rejects(
        adapter.sendEmailVerification(verification()),
        (error) => {
          assert.equal(error instanceof AccountEmailProviderError, true);
          assert.equal(error.retryable, retryable);
          assert.equal(error.statusCode, status);
          assert.equal(JSON.stringify(error).includes(API_KEY), false);
          assert.equal(error.stack.includes(API_KEY), false);
          return true;
        }
      );
    }
  });

  test("treats network, timeout, and malformed success responses as retryable", async () => {
    const network = createResendEmailAdapter({
      apiKey: API_KEY,
      deliveryMode: "send",
      from: "accounts@hundo.example",
      fetchImplementation: async () => {
        throw new Error(`network details ${API_KEY}`);
      },
    });
    await assert.rejects(
      network.sendEmailVerification(verification()),
      (error) => error.retryable === true && !error.stack.includes(API_KEY)
    );

    const malformed = createResendEmailAdapter({
      apiKey: API_KEY,
      deliveryMode: "send",
      from: "accounts@hundo.example",
      fetchImplementation: async () => response(200, "not-json"),
    });
    await assert.rejects(
      malformed.sendEmailVerification(verification()),
      (error) => error.retryable === true && error.statusCode === 200
    );

    const malformedResponse = createResendEmailAdapter({
      apiKey: API_KEY,
      deliveryMode: "send",
      from: "accounts@hundo.example",
      fetchImplementation: async () => ({
        ok: false,
        async text() {
          return "not-json";
        },
      }),
    });
    await assert.rejects(
      malformedResponse.sendEmailVerification(verification()),
      (error) => error.retryable === true && error.statusCode === null
    );

    const timedOut = createResendEmailAdapter({
      apiKey: API_KEY,
      deliveryMode: "send",
      from: "accounts@hundo.example",
      setTimeoutFunction(callback) {
        callback();
        return 1;
      },
      clearTimeoutFunction() {},
      fetchImplementation: async (_url, { signal }) => {
        assert.equal(signal.aborted, true);
        throw new Error("aborted");
      },
    });
    await assert.rejects(
      timedOut.sendEmailVerification(verification()),
      (error) => error.retryable === true
    );
  });

  test("fails closed for invalid construction and message inputs", async () => {
    for (const options of [
      { apiKey: "bad" },
      { deliveryMode: "capture" },
      { from: "not-an-email" },
      { timeoutMs: 0 },
    ]) {
      assert.throws(() =>
        createResendEmailAdapter({
          apiKey: API_KEY,
          deliveryMode: "send",
          from: "accounts@hundo.example",
          fetchImplementation: async () => response(200, { id: "unused" }),
          ...options,
        })
      );
    }

    const adapter = createResendEmailAdapter({
      apiKey: API_KEY,
      deliveryMode: "send",
      from: "accounts@hundo.example",
      fetchImplementation: async () => response(200, { id: "unused" }),
    });
    await assert.rejects(
      adapter.sendSecurityNotification(notification("unapproved")),
      /approved security notification/
    );
  });
});

describe("M3-21 configured adapter and delivery job", () => {
  test("selects disabled, capture, and provider adapters without a live request", async () => {
    assert.equal(
      createConfiguredAccountEmailAdapter({
        emailConfig: { deliveryMode: "disabled" },
      }),
      null
    );
    const capture = createConfiguredAccountEmailAdapter({
      emailConfig: { deliveryMode: "capture" },
    });
    await capture.sendEmailVerification(verification());
    assert.equal(capture.listCaptured().length, 1);

    let calls = 0;
    const provider = createConfiguredAccountEmailAdapter({
      emailConfig: {
        apiKey: {
          configured: true,
          value: API_KEY,
        },
        apiOrigin: "https://api.resend.com",
        deliveryMode: "sandbox",
        from: "accounts@hundo.example",
        provider: "resend",
        replyTo: null,
      },
      fetchImplementation: async () => {
        calls += 1;
        return response(200, { id: "configured-provider-id" });
      },
    });
    assert.equal(calls, 0);
    await provider.sendEmailVerification(verification());
    assert.equal(calls, 1);
  });

  test("recovers once, runs bounded non-overlapping cycles, unreferences its timer, and closes", async () => {
    const calls = [];
    let release;
    let timerCallback;
    let unreferenced = false;
    let cleared = false;
    const deliveryService = {
      recoverInterrupted(options) {
        calls.push(["recover", options]);
        return ["recovered-event"];
      },
      async deliverDue(options) {
        calls.push(["deliver", options]);
        if (calls.filter(([kind]) => kind === "deliver").length === 2) {
          await new Promise((resolve) => {
            release = resolve;
          });
        }
        return [];
      },
    };
    const job = createAccountEmailDeliveryJob({
      deliveryService,
      logger: { error() {} },
      intervalMs: 1_000,
      batchLimit: 7,
      recoveryLimit: 8,
      setIntervalFunction(callback, interval) {
        timerCallback = callback;
        assert.equal(interval, 1_000);
        return {
          unref() {
            unreferenced = true;
          },
        };
      },
      clearIntervalFunction() {
        cleared = true;
      },
    });

    const started = job.start();
    assert.deepEqual(started.recovered, ["recovered-event"]);
    assert.equal(unreferenced, true);
    assert.deepEqual(await started.initialRun, {
      status: "succeeded",
      delivered: 0,
      outcomes: [],
    });
    timerCallback();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(job.isRunning(), true);
    assert.deepEqual(await job.runCycle(), {
      status: "skipped",
      reason: "overlap",
    });
    const closePromise = job.close();
    assert.equal(cleared, true);
    release();
    await closePromise;
    assert.equal(job.isRunning(), false);
    assert.deepEqual(calls[0], ["recover", { limit: 8 }]);
    assert.deepEqual(calls[1], ["deliver", { limit: 7 }]);
    assert.deepEqual(await job.runCycle(), {
      status: "skipped",
      reason: "closed",
    });
  });

  test("returns and logs only a safe code when a cycle fails", async () => {
    const logs = [];
    const job = createAccountEmailDeliveryJob({
      deliveryService: {
        recoverInterrupted() {
          return [];
        },
        async deliverDue() {
          throw new Error(`private provider body ${API_KEY}`);
        },
      },
      logger: {
        error(event, context) {
          logs.push({ event, context });
        },
      },
      setIntervalFunction() {
        return { unref() {} };
      },
      clearIntervalFunction() {},
    });
    const result = await job.runCycle();
    assert.deepEqual(result, {
      status: "failed",
      code: "ACCOUNT_EMAIL_DELIVERY_CYCLE_FAILED",
    });
    assert.equal(JSON.stringify({ logs, result }).includes(API_KEY), false);
    await job.close();
  });
});
