const { createHash } = require("node:crypto");
const { serializeCanonicalJsonV1 } = require("../leagues/seasonRolloverEvidencePolicy");

// Identical canonical bytes and SHA-256 evidence, using the Node implementation
// for the large statistics payloads rather than a JavaScript SHA-256 loop.
function hashCanonicalJsonV1(value) {
  return createHash("sha256").update(serializeCanonicalJsonV1(value)).digest("hex");
}
module.exports = { hashCanonicalJsonV1 };
