const PROVIDER_CORRECTION_REASON = "Automatic NHL statistics correction";
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;

function isCorrectionSource({ source_type, actor_user_id, reason } = {}) {
  return (source_type === "correction" && UUID.test(actor_user_id || "")) ||
    (source_type === "provider_correction" && actor_user_id === null && reason === PROVIDER_CORRECTION_REASON);
}

module.exports = { PROVIDER_CORRECTION_REASON, isCorrectionSource };
