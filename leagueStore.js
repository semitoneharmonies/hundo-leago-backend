const {
  createJsonLeagueRepository,
} = require(
  "./src/infrastructure/persistence/json/JsonLeagueRepository"
);

function createLeagueStore(options = {}) {
  if (!options.dataFilePath) {
    throw new Error(
      "createLeagueStore requires dataFilePath"
    );
  }
  return createJsonLeagueRepository(options);
}

module.exports = { createLeagueStore };
