const assert = require("node:assert/strict");
const express = require("express");
const { describe, test } = require("node:test");

const {
  createTargetRequestSecurity,
} = require(
  "../../src/transport/http/createTargetRequestSecurity"
);
const {
  createSessionCookie,
} = require(
  "../../src/transport/http/sessionCookie"
);

const ALLOWED_ORIGIN =
  "http://localhost:5173";
const RAW_SESSION_TOKEN = Buffer.alloc(
  32,
  41
).toString("base64url");
const RAW_CSRF_TOKEN = Buffer.alloc(
  32,
  73
).toString("base64url");
const OTHER_CSRF_TOKEN = Buffer.alloc(
  32,
  74
).toString("base64url");

function internalBootstrap() {
  const result = {
    kind: "internal_session_bootstrap",
    valid: true,
    code: "SESSION_VALID",
    user: {
      id: "user-1",
      status: "active",
      version: 1,
    },
    session: {
      id: "session-1",
      version: 1,
    },
  };
  Object.defineProperty(result, "rawCsrfToken", {
    enumerable: false,
    value: RAW_CSRF_TOKEN,
  });
  return Object.freeze(result);
}

async function startProbe(t) {
  const cookie = createSessionCookie({
    appEnv: "local",
    publicFrontendOrigin: ALLOWED_ORIGIN,
    sameSite: "lax",
  });
  const calls = [];
  const sessionService = {
    bootstrap(rawSessionToken) {
      calls.push({
        operation: "bootstrap",
        rawSessionToken,
      });
      return rawSessionToken ===
        RAW_SESSION_TOKEN
        ? internalBootstrap()
        : {
            valid: false,
            code: "SESSION_INVALID",
          };
    },
    resolveWithCsrf({
      rawSessionToken,
      rawCsrfToken,
    }) {
      calls.push({
        operation: "unsafe",
        rawSessionToken,
        rawCsrfToken,
      });
      if (
        rawSessionToken !== RAW_SESSION_TOKEN
      ) {
        return {
          valid: false,
          code: "SESSION_INVALID",
        };
      }
      if (rawCsrfToken !== RAW_CSRF_TOKEN) {
        return {
          valid: false,
          code: "CSRF_INVALID",
        };
      }
      return {
        valid: true,
        code: "SESSION_VALID",
        user: {
          id: "user-1",
          status: "active",
          version: 1,
        },
        session: {
          id: "session-1",
          version: 1,
        },
      };
    },
  };
  const security = createTargetRequestSecurity({
    isAllowedOrigin: (origin) =>
      origin === ALLOWED_ORIGIN,
    sessionCookie: cookie,
    sessionService,
  });
  const app = express();
  app.use(security.securityHeaders);
  app.use(security.credentialedCors);
  app.use(express.json());

  app.get(
    "/bootstrap",
    security.requireAllowedOrigin,
    security.authenticateBootstrap,
    (request, response) => {
      const bootstrap =
        security.getSessionBootstrap(request);
      response.json({
        data: {
          user: bootstrap.user,
          session: bootstrap.session,
          csrfToken: bootstrap.rawCsrfToken,
        },
      });
    }
  );
  app.post(
    "/unsafe",
    security.requireAllowedOrigin,
    security.requireJson,
    security.requireCompatibleFetchMetadata,
    security.authenticateUnsafe,
    (request, response) => {
      response.json({
        data:
          security.getAuthenticatedSession(
            request
          ),
      });
    }
  );

  const server = app.listen(0, "127.0.0.1");
  await new Promise((resolve, reject) => {
    server.once("listening", resolve);
    server.once("error", reject);
  });
  t.after(
    () =>
      new Promise((resolve, reject) => {
        server.close((error) =>
          error ? reject(error) : resolve()
        );
      })
  );
  const address = server.address();
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    calls,
    cookie,
  };
}

async function request(
  baseUrl,
  path,
  { method = "GET", headers, body } = {}
) {
  const response = await fetch(
    new URL(path, baseUrl),
    {
      method,
      headers,
      body,
    }
  );
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    text,
    json: text ? JSON.parse(text) : null,
  };
}

function browserHeaders(extra = {}) {
  return {
    Origin: ALLOWED_ORIGIN,
    Cookie: `hl_session=${RAW_SESSION_TOKEN}`,
    ...extra,
  };
}

function assertSecurityHeaders(response) {
  assert.equal(
    response.headers.get(
      "x-content-type-options"
    ),
    "nosniff"
  );
  assert.equal(
    response.headers.get("referrer-policy"),
    "no-referrer"
  );
  assert.equal(
    response.headers.get("x-frame-options"),
    "DENY"
  );
  assert.equal(
    response.headers.get("permissions-policy"),
    "camera=(), microphone=(), geolocation=()"
  );
  assert.equal(
    response.headers.get("cache-control"),
    "no-store"
  );
}

describe("M3-05 exact credentialed request security", () => {
  test("reuses one immutable request ID across composed routers", () => {
    let factoryCalls = 0;
    const security = createTargetRequestSecurity({
      isAllowedOrigin: (origin) => origin === ALLOWED_ORIGIN,
      requestIdFactory() {
        factoryCalls += 1;
        return `request-${factoryCalls}`;
      },
      sessionCookie: createSessionCookie({
        appEnv: "local",
        publicFrontendOrigin: ALLOWED_ORIGIN,
        sameSite: "lax",
      }),
      sessionService: {
        bootstrap() {},
        resolveWithCsrf() {},
      },
    });
    const request = {};
    const response = {
      status() {
        assert.fail("request-ID assignment must not fail");
      },
    };
    let nextCalls = 0;
    security.assignRequestId(request, response, () => {
      nextCalls += 1;
    });
    security.assignRequestId(request, response, () => {
      nextCalls += 1;
    });
    assert.equal(security.getRequestId(request), "request-1");
    assert.equal(factoryCalls, 1);
    assert.equal(nextCalls, 2);
  });

  test("allows only the exact configured Origin and emits required headers", async (t) => {
    const runtime = await startProbe(t);
    const allowed = await request(
      runtime.baseUrl,
      "/bootstrap",
      {
        headers: browserHeaders(),
      }
    );

    assert.equal(allowed.status, 200);
    assert.equal(
      allowed.headers.get(
        "access-control-allow-origin"
      ),
      ALLOWED_ORIGIN
    );
    assert.equal(
      allowed.headers.get(
        "access-control-allow-credentials"
      ),
      "true"
    );
    assert.match(
      allowed.headers.get("vary"),
      /(?:^|,\s*)Origin(?:,|$)/
    );
    assertSecurityHeaders(allowed);
    assert.deepEqual(allowed.json.data.user, {
      id: "user-1",
      status: "active",
      version: 1,
    });
    assert.equal(
      allowed.json.data.csrfToken,
      RAW_CSRF_TOKEN
    );
    assert.equal(
      allowed.text.includes(RAW_SESSION_TOKEN),
      false
    );

    for (const origin of [
      undefined,
      "https://preview--hundo.netlify.app",
      "http://localhost:5173.attacker.test",
      "*",
    ]) {
      const headers = browserHeaders();
      if (origin === undefined) {
        delete headers.Origin;
      } else {
        headers.Origin = origin;
      }
      const denied = await request(
        runtime.baseUrl,
        "/bootstrap",
        { headers }
      );
      assert.equal(denied.status, 403);
      assert.equal(
        denied.headers.get(
          "access-control-allow-origin"
        ),
        null
      );
      assert.equal(
        denied.text.includes(
          String(origin)
        ),
        false
      );
      assertSecurityHeaders(denied);
    }
  });

  test("answers only bounded exact preflights", async (t) => {
    const runtime = await startProbe(t);
    const allowed = await request(
      runtime.baseUrl,
      "/unsafe",
      {
        method: "OPTIONS",
        headers: {
          Origin: ALLOWED_ORIGIN,
          "Access-Control-Request-Method":
            "POST",
          "Access-Control-Request-Headers":
            "Content-Type, X-CSRF-Token",
        },
      }
    );

    assert.equal(allowed.status, 204);
    assert.equal(
      allowed.headers.get(
        "access-control-max-age"
      ),
      "600"
    );
    assert.equal(
      allowed.headers
        .get("access-control-allow-methods")
        .includes("TRACE"),
      false
    );
    assert.equal(
      allowed.headers
        .get("access-control-allow-headers")
        .includes("X-CSRF-Token"),
      true
    );
    assertSecurityHeaders(allowed);

    for (const headers of [
      {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method":
          "TRACE",
      },
      {
        Origin: ALLOWED_ORIGIN,
        "Access-Control-Request-Method":
          "POST",
        "Access-Control-Request-Headers":
          "Content-Type, X-Admin-Role",
      },
      {
        Origin:
          "https://preview--hundo.netlify.app",
        "Access-Control-Request-Method":
          "POST",
      },
    ]) {
      const denied = await request(
        runtime.baseUrl,
        "/unsafe",
        {
          method: "OPTIONS",
          headers,
        }
      );
      assert.equal(denied.status, 403);
      assertSecurityHeaders(denied);
    }
  });

  test("bootstraps only one valid configured session cookie", async (t) => {
    const runtime = await startProbe(t);
    const invalidCookies = [
      undefined,
      "hl_session=malformed",
      `hl_session=${RAW_SESSION_TOKEN}; hl_session=${RAW_SESSION_TOKEN}`,
    ];

    for (const cookieHeader of invalidCookies) {
      const headers = {
        Origin: ALLOWED_ORIGIN,
      };
      if (cookieHeader !== undefined) {
        headers.Cookie = cookieHeader;
      }
      const denied = await request(
        runtime.baseUrl,
        "/bootstrap",
        { headers }
      );
      assert.equal(denied.status, 401);
      assert.equal(
        denied.json.error.code,
        "SESSION_REQUIRED"
      );
      assert.equal(
        denied.text.includes(
          RAW_SESSION_TOKEN
        ),
        false
      );
    }
  });

  test("requires JSON, compatible Fetch Metadata, session, and CSRF for unsafe requests", async (t) => {
    const runtime = await startProbe(t);
    const valid = await request(
      runtime.baseUrl,
      "/unsafe",
      {
        method: "POST",
        headers: browserHeaders({
          "Content-Type":
            "application/json; charset=utf-8",
          "X-CSRF-Token": RAW_CSRF_TOKEN,
          "Sec-Fetch-Site": "cross-site",
          "Sec-Fetch-Mode": "cors",
          "Sec-Fetch-Dest": "empty",
        }),
        body: "{}",
      }
    );
    assert.equal(valid.status, 200);
    assert.equal(valid.json.data.valid, true);
    assert.equal(
      valid.text.includes(RAW_SESSION_TOKEN),
      false
    );
    assert.equal(
      valid.text.includes(RAW_CSRF_TOKEN),
      false
    );

    const cases = [
      {
        headers: browserHeaders({
          "Content-Type":
            "application/x-www-form-urlencoded",
          "X-CSRF-Token": RAW_CSRF_TOKEN,
        }),
        status: 415,
        code: "CONTENT_TYPE_INVALID",
      },
      {
        headers: browserHeaders({
          "Content-Type": "application/json",
          "X-CSRF-Token": RAW_CSRF_TOKEN,
          "Sec-Fetch-Site": "none",
        }),
        status: 403,
        code: "FETCH_METADATA_INVALID",
      },
      {
        headers: browserHeaders({
          "Content-Type": "application/json",
          "X-CSRF-Token": OTHER_CSRF_TOKEN,
        }),
        status: 403,
        code: "CSRF_INVALID",
      },
      {
        headers: {
          Origin: ALLOWED_ORIGIN,
          "Content-Type": "application/json",
          "X-CSRF-Token": RAW_CSRF_TOKEN,
        },
        status: 401,
        code: "SESSION_REQUIRED",
      },
    ];

    for (const item of cases) {
      const denied = await request(
        runtime.baseUrl,
        "/unsafe",
        {
          method: "POST",
          headers: item.headers,
          body: "{}",
        }
      );
      assert.equal(denied.status, item.status);
      assert.equal(
        denied.json.error.code,
        item.code
      );
      assertSecurityHeaders(denied);
      assert.equal(
        denied.text.includes(RAW_SESSION_TOKEN),
        false
      );
      assert.equal(
        denied.text.includes(OTHER_CSRF_TOKEN),
        false
      );
    }
  });

  test("rejects invalid factory dependencies and unbounded preflight ages", () => {
    const cookie = {
      read() {
        return null;
      },
    };
    const service = {
      bootstrap() {},
      resolveWithCsrf() {},
    };
    assert.throws(
      () =>
        createTargetRequestSecurity({
          sessionCookie: cookie,
          sessionService: service,
        }),
      /exact origin predicate/
    );
    assert.throws(
      () =>
        createTargetRequestSecurity({
          isAllowedOrigin: () => true,
          sessionCookie: cookie,
          sessionService: service,
          preflightMaxAgeSeconds: 601,
        }),
      /bounded preflight age/
    );
  });
});
