const fs = require("node:fs");
const path = require("node:path");

const ROUTE_PATTERN =
  /\b(?:app|router)\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;

function listJavaScriptFiles(directoryPath) {
  if (!fs.existsSync(directoryPath)) return [];

  const files = [];
  const entries = fs.readdirSync(directoryPath, {
    withFileTypes: true,
  });

  for (const entry of entries) {
    const fullPath = path.join(directoryPath, entry.name);
    if (entry.isDirectory()) {
      files.push(...listJavaScriptFiles(fullPath));
    } else if (entry.isFile() && entry.name.endsWith(".js")) {
      files.push(fullPath);
    }
  }

  return files;
}

function readEndpointManifest(backendRoot) {
  const sourceFiles = [
    path.join(backendRoot, "server.js"),
    ...listJavaScriptFiles(path.join(backendRoot, "routes")),
    ...listJavaScriptFiles(
      path.join(backendRoot, "src", "transport", "http", "routes")
    ),
  ];

  const endpoints = [];

  for (const sourceFile of sourceFiles) {
    const source = fs.readFileSync(sourceFile, "utf8");
    let match;

    ROUTE_PATTERN.lastIndex = 0;
    while ((match = ROUTE_PATTERN.exec(source)) !== null) {
      const routePath = match[2];
      if (!routePath.startsWith("/")) continue;

      endpoints.push({
        method: match[1].toUpperCase(),
        path: routePath,
        key: `${match[1].toUpperCase()} ${routePath}`,
        debug: routePath.startsWith("/api/matchups/debug/"),
        sourceFile: path.relative(backendRoot, sourceFile).replaceAll("\\", "/"),
        sourceIndex: match.index,
      });
    }
  }

  return endpoints.sort((left, right) => left.key.localeCompare(right.key));
}

function debugRoutesAreGuarded(backendRoot) {
  const runtimeSource = fs.readFileSync(
    path.join(
      backendRoot,
      "src",
      "bootstrap",
      "createCompatibilityRuntime.js"
    ),
    "utf8"
  );
  const routerSource = fs.readFileSync(
    path.join(
      backendRoot,
      "src",
      "transport",
      "http",
      "routes",
      "matchupsDebugCompatibilityRouter.js"
    ),
    "utf8"
  );
  const guardIndex = runtimeSource.indexOf(
    "if (config.debugMatchups) {"
  );
  const routerUseIndex = runtimeSource.indexOf(
    "createMatchupsDebugCompatibilityRouter({",
    guardIndex
  );
  const nextRouteIndex = runtimeSource.indexOf(
    "const generateScheduleService =",
    guardIndex
  );

  if (
    guardIndex < 0 ||
    routerUseIndex < guardIndex ||
    nextRouteIndex < routerUseIndex
  ) {
    return false;
  }

  const debugPaths = [
    "/api/matchups/debug/stateSummary",
    "/api/matchups/debug/resetLocks",
    "/api/matchups/debug/resetBaselineForWeek",
    "/api/matchups/debug/captureBaselineNow",
    "/api/matchups/debug/runLockNow",
    "/api/matchups/debug/setTeamRosterEmpty",
  ];

  return debugPaths.every((routePath) =>
    routerSource.includes(routePath)
  );
}

module.exports = { debugRoutesAreGuarded, readEndpointManifest };
