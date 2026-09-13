const {
  FREE_AGENT_DRAFT_STATUSES,
  validateFreeAgentDraftStatusTransition,
} = require(
  "../../../domain/freeAgentDraft/freeAgentDraftPolicy"
);

const ROUTE_FIELDS = Object.freeze([
  "fromStatus",
  "toStatus",
  "writer",
]);

function invalid(message) {
  throw new TypeError(message);
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return (
    prototype === Object.prototype ||
    prototype === null
  );
}

function hasExactFields(value, fields) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...fields].sort();
  return (
    actual.length === expected.length &&
    actual.every(
      (field, index) => field === expected[index]
    )
  );
}

function edgeKey(fromStatus, toStatus) {
  return `${fromStatus}\u0000${toStatus}`;
}

function canonicalEdge(
  fromStatus,
  toStatus,
  description
) {
  if (
    !FREE_AGENT_DRAFT_STATUSES.includes(
      fromStatus
    ) ||
    !FREE_AGENT_DRAFT_STATUSES.includes(toStatus)
  ) {
    invalid(
      `A canonical ${description} is required.`
    );
  }
  try {
    return validateFreeAgentDraftStatusTransition({
      fromStatus,
      toStatus,
    });
  } catch {
    invalid(
      `A canonical ${description} is required.`
    );
  }
}

function normalizeRoute(route, index) {
  if (!hasExactFields(route, ROUTE_FIELDS)) {
    invalid(
      `FAD transition route ${index} must contain exactly fromStatus, toStatus, and writer.`
    );
  }
  const edge = canonicalEdge(
    route.fromStatus,
    route.toStatus,
    "FAD transition route edge"
  );
  const writer = route.writer;
  if (
    writer === null ||
    (typeof writer !== "object" &&
      typeof writer !== "function") ||
    typeof writer.beforeTransition !== "function"
  ) {
    invalid(
      `FAD transition route ${index} writer must expose beforeTransition.`
    );
  }
  if (
    writer.afterTransition !== undefined &&
    typeof writer.afterTransition !== "function"
  ) {
    invalid(
      `FAD transition route ${index} writer afterTransition must be a function when provided.`
    );
  }
  return Object.freeze({
    ...edge,
    beforeTransition:
      writer.beforeTransition.bind(writer),
    afterTransition:
      writer.afterTransition === undefined
        ? null
        : writer.afterTransition.bind(writer),
  });
}

function normalizeRoutes(routes) {
  if (
    !Array.isArray(routes) ||
    routes.length < 1 ||
    Object.keys(routes).length !== routes.length ||
    !routes.every((_, index) =>
      Object.hasOwn(routes, index)
    )
  ) {
    invalid(
      "An exact nonempty FAD transition route array is required."
    );
  }
  const keys = new Set();
  const normalized = routes.map((route, index) => {
    const result = normalizeRoute(route, index);
    const key = edgeKey(
      result.fromStatus,
      result.toStatus
    );
    if (keys.has(key)) {
      invalid(
        `Duplicate FAD transition route ${result.fromStatus} -> ${result.toStatus}.`
      );
    }
    keys.add(key);
    return result;
  });
  return Object.freeze(normalized);
}

function commandEdge(command, description) {
  if (
    !isPlainObject(command) ||
    !Object.hasOwn(command, "fromStatus") ||
    !Object.hasOwn(command, "toStatus")
  ) {
    invalid(
      `A canonical ${description} command edge is required.`
    );
  }
  return canonicalEdge(
    command.fromStatus,
    command.toStatus,
    `${description} command edge`
  );
}

function createFreeAgentDraftTransitionWriterDispatcher(
  routes
) {
  const configuration = normalizeRoutes(routes);
  const routeByEdge = Object.freeze(
    Object.fromEntries(
      configuration.map((route) => [
        edgeKey(route.fromStatus, route.toStatus),
        route,
      ])
    )
  );

  function select(command, description) {
    const edge = commandEdge(command, description);
    const route =
      routeByEdge[
        edgeKey(edge.fromStatus, edge.toStatus)
      ];
    if (!route) {
      invalid(
        `No FAD transition writer is registered for ${edge.fromStatus} -> ${edge.toStatus}.`
      );
    }
    return route;
  }

  function beforeTransition(input) {
    const route = select(input, "before-transition");
    return route.beforeTransition(input);
  }

  function afterTransition(input) {
    if (
      !isPlainObject(input) ||
      !Object.hasOwn(input, "effectiveCommand")
    ) {
      invalid(
        "An exact FAD after-transition payload is required."
      );
    }
    const route = select(
      input.effectiveCommand,
      "after-transition"
    );
    return route.afterTransition === null
      ? undefined
      : route.afterTransition(input);
  }

  return Object.freeze({
    beforeTransition,
    afterTransition,
  });
}

module.exports = {
  createFreeAgentDraftTransitionWriterDispatcher,
};
