"use strict";

const {
  CANDIDATE_CARD_POLICY_CODES,
  CandidateCardPolicyError,
} = require("./candidateCardPolicy");
const {
  normalizeCandidateCardIdempotencyKey,
} = require("./candidateCardMutationPolicy");

const CANDIDATE_CARD_HELP_MESSAGE_MAXIMUM_CODE_POINTS =
  500;
const HELP_MESSAGE_CONTROL_PATTERN =
  /[\u0000-\u001f\u007f-\u009f]/u;

function failInput(reasonCode) {
  throw new CandidateCardPolicyError(
    CANDIDATE_CARD_POLICY_CODES.inputInvalid,
    reasonCode
  );
}

function exactHelpBody(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    ![
      Object.prototype,
      null,
    ].includes(Object.getPrototypeOf(value)) ||
    Object.getOwnPropertySymbols(value).length !== 0
  ) {
    failInput("help_body_invalid");
  }
  const fields =
    Object.getOwnPropertyNames(value).sort();
  if (
    fields.length > 1 ||
    (fields.length === 1 && fields[0] !== "message") ||
    fields.some(
      (field) =>
        Object.getOwnPropertyDescriptor(value, field)
          ?.enumerable !== true
    )
  ) {
    failInput("help_body_invalid");
  }
}

function normalizeCandidateCardHelpMessage(value) {
  if (value === undefined || value === null) {
    return null;
  }
  if (
    typeof value !== "string" ||
    HELP_MESSAGE_CONTROL_PATTERN.test(value)
  ) {
    failInput("help_message_invalid");
  }
  const normalized = value.trim();
  if (normalized.length === 0) {
    return null;
  }
  if (
    [...normalized].length >
    CANDIDATE_CARD_HELP_MESSAGE_MAXIMUM_CODE_POINTS
  ) {
    failInput("help_message_invalid");
  }
  return normalized;
}

function normalizeCandidateCardHelpBody(value) {
  exactHelpBody(value);
  return Object.freeze({
    message: normalizeCandidateCardHelpMessage(
      Object.prototype.hasOwnProperty.call(
        value,
        "message"
      )
        ? value.message
        : undefined
    ),
  });
}

module.exports = {
  CANDIDATE_CARD_HELP_MESSAGE_MAXIMUM_CODE_POINTS,
  normalizeCandidateCardHelpBody,
  normalizeCandidateCardHelpMessage,
  normalizeCandidateCardHelpIdempotencyKey:
    normalizeCandidateCardIdempotencyKey,
};
