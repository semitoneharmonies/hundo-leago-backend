const historicalDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/Vancouver", year: "numeric", month: "2-digit", day: "2-digit",
});
const permanentPacificStart = Date.parse("2026-03-08T10:00:00Z");
const pacificOffsetMs = -7 * 60 * 60 * 1000;

function vancouverDate(epochMs) {
  // Some supported Node releases still have the former Vancouver winter offset.
  if (epochMs < permanentPacificStart) return historicalDate.format(epochMs);
  return new Date(epochMs + pacificOffsetMs).toISOString().slice(0, 10);
}

module.exports = { vancouverDate };
