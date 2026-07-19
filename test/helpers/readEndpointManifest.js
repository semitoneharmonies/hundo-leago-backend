const fs = require("node:fs");
const path = require("node:path");

const ROUTE_PATTERN =
  /app\.(get|post|put|patch|delete)\(\s*["']([^"']+)["']/g;

function readEndpointManifest(backendRoot) {
  const sourceFiles = [
    path.join(backendRoot, "server.js"),
    ...fs
      .readdirSync(path.join(backendRoot, "routes"), {
        withFileTypes: true,
      })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".js"))
      .map((entry) => path.join(backendRoot, "routes", entry.name)),
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
  const source = fs.readFileSync(path.join(backendRoot, "server.js"), "utf8");
  const guardIndex = source.indexOf("if (DEBUG_MATCHUPS) {");
  const nextNormalRouteIndex = source.indexOf(
    'app.post("/api/matchups/schedule/generate"'
  );

  if (guardIndex < 0 || nextNormalRouteIndex <= guardIndex) return false;

  const debugBlock = source.slice(guardIndex, nextNormalRouteIndex);
  const debugPaths = [
    "/api/matchups/debug/stateSummary",
    "/api/matchups/debug/resetLocks",
    "/api/matchups/debug/resetBaselineForWeek",
    "/api/matchups/debug/captureBaselineNow",
    "/api/matchups/debug/runLockNow",
    "/api/matchups/debug/setTeamRosterEmpty",
  ];

  return debugPaths.every((routePath) => debugBlock.includes(routePath));
}

module.exports = { debugRoutesAreGuarded, readEndpointManifest };
