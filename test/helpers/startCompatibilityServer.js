const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const path = require("node:path");

const { findAvailablePort } = require("./findAvailablePort");
const { httpRequest } = require("./httpRequest");

const MAX_CAPTURE_BYTES = 64 * 1024;
const STORAGE_ENV_KEYS = [
  "LEAGUE_FILE",
  "PLAYERS_FILE",
  "STATS_FILE",
  "SNAPSHOT_DIR",
  "BACKUPS_DIR",
];

function appendBounded(current, chunk) {
  const next = current + chunk.toString("utf8");
  return next.length <= MAX_CAPTURE_BYTES
    ? next
    : next.slice(next.length - MAX_CAPTURE_BYTES);
}

function isInside(parentPath, childPath) {
  const relative = path.relative(
    path.resolve(parentPath),
    path.resolve(childPath)
  );
  return (
    relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
  );
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return true;

  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      resolve(false);
    }, timeoutMs);

    function onExit() {
      clearTimeout(timeout);
      resolve(true);
    }

    child.once("exit", onExit);
  });
}

async function startCompatibilityServer(
  runtime,
  { matchupsDebug = false, startupTimeoutMs = 8000 } = {}
) {
  const backendRoot = path.resolve(__dirname, "..", "..");
  const port = await findAvailablePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    LEAGUE_FILE: runtime.leagueFile,
    PLAYERS_FILE: runtime.playersFile,
    STATS_FILE: runtime.statsFile,
    SNAPSHOT_DIR: runtime.snapshotsDir,
    BACKUPS_DIR: runtime.backupsDir,
    MAX_BACKUPS: "10",
    SNAPSHOTS_ENABLED: "false",
    AUCTIONS_ENABLED: "false",
    MATCHUPS_ENABLED: "false",
    MATCHUPS_DEBUG: matchupsDebug ? "true" : "false",
    STATS_REFRESH_TOKEN: "characterization-test-only",
  };

  for (const key of STORAGE_ENV_KEYS) {
    assert.equal(
      isInside(runtime.root, env[key]),
      true,
      `${key} escaped the temporary runtime`
    );
    assert.equal(
      env[key].replaceAll("\\", "/").toLowerCase().includes(
        "/opt/render/project/data"
      ),
      false,
      `${key} referenced the Render persistent disk`
    );
  }

  const child = spawn(process.execPath, ["server.js"], {
    cwd: backendRoot,
    env,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let stopped = false;

  child.stdout.on("data", (chunk) => {
    stdout = appendBounded(stdout, chunk);
  });
  child.stderr.on("data", (chunk) => {
    stderr = appendBounded(stderr, chunk);
  });

  const deadline = Date.now() + startupTimeoutMs;
  let health = null;

  try {
    while (Date.now() < deadline) {
      if (child.exitCode !== null) {
        throw new Error(
          `compatibility server exited during startup (${child.exitCode})\n` +
            `stdout:\n${stdout}\nstderr:\n${stderr}`
        );
      }

      try {
        const response = await httpRequest(baseUrl, "/health", {
          timeoutMs: 500,
        });
        if (response.status === 200 && response.json?.ok === true) {
          health = response;
          break;
        }
      } catch {
        // The child may still be binding its loopback port.
      }

      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    if (!health) {
      throw new Error(
        `compatibility server did not become ready\n` +
          `stdout:\n${stdout}\nstderr:\n${stderr}`
      );
    }

    assert.equal(
      isInside(runtime.root, health.json.dataFilePath),
      true,
      "health dataFilePath escaped the temporary runtime"
    );
    assert.equal(
      isInside(runtime.root, health.json.backupsDir),
      true,
      "health backupsDir escaped the temporary runtime"
    );
  } catch (error) {
    child.kill("SIGKILL");
    await waitForExit(child, 2000);
    throw error;
  }

  return {
    baseUrl,
    child,
    health,
    get stdout() {
      return stdout;
    },
    get stderr() {
      return stderr;
    },
    async stop() {
      if (stopped) return;
      stopped = true;

      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        const exited = await waitForExit(child, 2000);
        if (!exited) {
          child.kill("SIGKILL");
          const forceExited = await waitForExit(child, 2000);
          if (!forceExited) {
            throw new Error(
              `compatibility server ${child.pid} did not terminate`
            );
          }
        }
      }
    },
  };
}

module.exports = { startCompatibilityServer };
