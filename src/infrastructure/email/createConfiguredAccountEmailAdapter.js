const {
  createCaptureEmailAdapter,
} = require("./createCaptureEmailAdapter");
const {
  RESEND_API_ORIGIN,
  createResendEmailAdapter,
} = require("./createResendEmailAdapter");

function createConfiguredAccountEmailAdapter({
  emailConfig,
  fetchImplementation,
} = {}) {
  if (
    emailConfig === null ||
    typeof emailConfig !== "object" ||
    Array.isArray(emailConfig)
  ) {
    throw new TypeError("account email requires validated configuration");
  }
  if (emailConfig.deliveryMode === "disabled") return null;
  if (emailConfig.deliveryMode === "capture") {
    return createCaptureEmailAdapter();
  }
  if (
    !["sandbox", "send"].includes(emailConfig.deliveryMode) ||
    emailConfig.provider !== "resend" ||
    emailConfig.apiOrigin !== RESEND_API_ORIGIN ||
    typeof emailConfig.from !== "string" ||
    !emailConfig.apiKey ||
    emailConfig.apiKey.configured !== true ||
    typeof emailConfig.apiKey.value !== "string"
  ) {
    throw new TypeError("account email provider configuration is incomplete");
  }
  return createResendEmailAdapter({
    apiKey: emailConfig.apiKey.value,
    deliveryMode: emailConfig.deliveryMode,
    from: emailConfig.from,
    replyTo: emailConfig.replyTo,
    ...(fetchImplementation === undefined
      ? {}
      : { fetchImplementation }),
  });
}

module.exports = { createConfiguredAccountEmailAdapter };
