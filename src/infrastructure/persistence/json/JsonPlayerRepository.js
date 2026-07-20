const fs = require("node:fs");

function statSafe(fsModule, filePath) {
  try {
    if (!fsModule.existsSync(filePath)) return { exists: false };
    const stat = fsModule.statSync(filePath);
    return {
      exists: true,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
    };
  } catch (error) {
    return {
      exists: false,
      error: String(error?.message || error),
    };
  }
}

function createJsonPlayerRepository({
  playerFile,
  repositoryPlayerFile,
  fsModule = fs,
} = {}) {
  if (!playerFile) {
    throw new TypeError(
      "createJsonPlayerRepository requires a playerFile"
    );
  }

  function loadPlayers() {
    if (!fsModule.existsSync(playerFile)) {
      return {
        ok: true,
        players: [],
        source: "missing-file",
      };
    }

    try {
      const raw = fsModule.readFileSync(playerFile, "utf8");
      const parsed = JSON.parse(raw);
      const players = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed?.players)
          ? parsed.players
          : [];

      return {
        ok: true,
        players,
        source: playerFile,
      };
    } catch (error) {
      return {
        ok: false,
        players: [],
        error: String(error?.message || error),
      };
    }
  }

  function getDebugInfo() {
    return {
      playerFile,
      disk: statSafe(fsModule, playerFile),
      repo: repositoryPlayerFile
        ? statSafe(fsModule, repositoryPlayerFile)
        : { exists: false },
    };
  }

  return {
    getDebugInfo,
    loadPlayers,
    playerFile,
  };
}

module.exports = {
  createJsonPlayerRepository,
  statSafe,
};
