const TRANSFORM_ERROR_CODES = Object.freeze({
  argumentInvalid: "TRANSFORM_ARGUMENT_INVALID",
  unrepresentable: "TRANSFORM_UNREPRESENTABLE",
});

class TransformValueError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "TransformValueError";
    this.code = code;
  }
}

function transformError(code, message) {
  return new TransformValueError(code, message);
}

function countCodePoints(value) {
  return [...value].length;
}

function normalizeDisplayValue(
  value,
  {
    fieldName,
    maximumCodePoints,
  }
) {
  if (
    typeof value !== "string" ||
    !Number.isSafeInteger(maximumCodePoints) ||
    maximumCodePoints <= 0
  ) {
    throw transformError(
      TRANSFORM_ERROR_CODES.argumentInvalid,
      `${fieldName} must be a string with an explicit limit.`
    );
  }
  const displayValue = value.trim();
  if (
    displayValue.length === 0 ||
    countCodePoints(displayValue) > maximumCodePoints
  ) {
    throw transformError(
      TRANSFORM_ERROR_CODES.argumentInvalid,
      `${fieldName} is empty or exceeds its approved limit.`
    );
  }
  return displayValue;
}

function normalizeEmail(value) {
  const emailDisplay = normalizeDisplayValue(value, {
    fieldName: "email",
    maximumCodePoints: 320,
  });
  return Object.freeze({
    emailDisplay,
    emailNormalized: emailDisplay.toLowerCase(),
  });
}

function normalizeCaseInsensitiveName(
  value,
  {
    fieldName = "name",
    maximumCodePoints = 200,
  } = {}
) {
  const displayValue = normalizeDisplayValue(value, {
    fieldName,
    maximumCodePoints,
  });
  return Object.freeze({
    displayValue,
    normalizedValue: displayValue.toLowerCase(),
  });
}

function decimalSourceText(value, fieldName) {
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw transformError(
        TRANSFORM_ERROR_CODES.argumentInvalid,
        `${fieldName} must be a finite decimal value.`
      );
    }
    value = String(value);
  }
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 200 ||
    !/^\d+(?:\.\d+)?$/.test(value)
  ) {
    throw transformError(
      TRANSFORM_ERROR_CODES.argumentInvalid,
      `${fieldName} must be a non-negative plain decimal.`
    );
  }
  return value;
}

function decimalToHundredths(value, fieldName) {
  const source = decimalSourceText(value, fieldName);
  const [wholeText, fractionText = ""] = source.split(".");
  const whole = BigInt(wholeText);
  const hundredthsText = fractionText
    .slice(0, 2)
    .padEnd(2, "0");
  let scaled = whole * 100n + BigInt(hundredthsText);
  if (
    fractionText.length > 2 &&
    fractionText.charCodeAt(2) >= 53
  ) {
    scaled += 1n;
  }
  if (scaled > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw transformError(
      TRANSFORM_ERROR_CODES.unrepresentable,
      `${fieldName} cannot be represented as a safe integer.`
    );
  }
  return Number(scaled);
}

function toIntegerCents(value) {
  return decimalToHundredths(value, "money");
}

function toFantasyPointHundredths(value) {
  return decimalToHundredths(value, "fantasy points");
}

function toUtcUnixMilliseconds(value) {
  if (Number.isSafeInteger(value) && value >= 0) {
    return value;
  }
  const match =
    typeof value === "string"
      ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(
          value
        )
      : null;
  if (!match) {
    throw transformError(
      TRANSFORM_ERROR_CODES.argumentInvalid,
      "A non-negative Unix millisecond value or explicit-offset ISO timestamp is required."
    );
  }
  const [
    ,
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
    fractionText = "",
    ,
    offsetSign,
    offsetHourText,
    offsetMinuteText,
  ] = match;
  const calendarParts = [
    yearText,
    monthText,
    dayText,
    hourText,
    minuteText,
    secondText,
  ].map(Number);
  const [
    year,
    month,
    day,
    hour,
    minute,
    second,
  ] = calendarParts;
  const millisecond = Number(
    fractionText.padEnd(3, "0") || "0"
  );
  const localCalendar = new Date(
    Date.UTC(
      year,
      month - 1,
      day,
      hour,
      minute,
      second,
      millisecond
    )
  );
  const calendarValid =
    year >= 1970 &&
    localCalendar.getUTCFullYear() === year &&
    localCalendar.getUTCMonth() === month - 1 &&
    localCalendar.getUTCDate() === day &&
    localCalendar.getUTCHours() === hour &&
    localCalendar.getUTCMinutes() === minute &&
    localCalendar.getUTCSeconds() === second &&
    localCalendar.getUTCMilliseconds() === millisecond;
  const offsetValid =
    offsetSign === undefined ||
    (Number(offsetHourText) <= 23 &&
      Number(offsetMinuteText) <= 59);
  if (!calendarValid || !offsetValid) {
    throw transformError(
      TRANSFORM_ERROR_CODES.argumentInvalid,
      "The timestamp contains an invalid calendar date or offset."
    );
  }
  const timestamp = Date.parse(value);
  if (
    !Number.isSafeInteger(timestamp) ||
    timestamp < 0
  ) {
    throw transformError(
      TRANSFORM_ERROR_CODES.unrepresentable,
      "The timestamp cannot be represented as safe Unix milliseconds."
    );
  }
  return timestamp;
}

function normalizePlayerPosition(value) {
  if (typeof value !== "string") {
    throw transformError(
      TRANSFORM_ERROR_CODES.argumentInvalid,
      "A supported player position is required."
    );
  }
  const position = value.trim().toUpperCase();
  if (["C", "LW", "RW", "F"].includes(position)) return "F";
  if (["LD", "RD", "D"].includes(position)) return "D";
  if (position === "G") return "G";
  throw transformError(
    TRANSFORM_ERROR_CODES.argumentInvalid,
    "A supported player position is required."
  );
}

function requireExplicitStatus(value, allowedStatuses) {
  if (
    typeof value !== "string" ||
    !Array.isArray(allowedStatuses) ||
    allowedStatuses.length === 0 ||
    !allowedStatuses.every(
      (status) =>
        typeof status === "string" && status.length > 0
    ) ||
    new Set(allowedStatuses).size !==
      allowedStatuses.length ||
    !allowedStatuses.includes(value)
  ) {
    throw transformError(
      TRANSFORM_ERROR_CODES.argumentInvalid,
      "The status must be explicitly present in its approved allowlist."
    );
  }
  return value;
}

const SCHEDULE_FAMILIES = Object.freeze([
  "contract",
  "retention",
  "buyout",
]);

function buildLevelYearSchedule({
  family,
  annualAmountCents,
  termYears,
  startSeasonYear,
} = {}) {
  if (
    !SCHEDULE_FAMILIES.includes(family) ||
    !Number.isSafeInteger(annualAmountCents) ||
    annualAmountCents < 0 ||
    !Number.isSafeInteger(termYears) ||
    termYears <= 0 ||
    !Number.isSafeInteger(startSeasonYear) ||
    startSeasonYear < 0
  ) {
    throw transformError(
      TRANSFORM_ERROR_CODES.argumentInvalid,
      "An explicit family, safe annual amount, positive term, and starting season are required."
    );
  }

  const lastSeasonYear = startSeasonYear + termYears - 1;
  const totalAmountCents = annualAmountCents * termYears;
  if (
    !Number.isSafeInteger(lastSeasonYear) ||
    !Number.isSafeInteger(totalAmountCents)
  ) {
    throw transformError(
      TRANSFORM_ERROR_CODES.unrepresentable,
      "The yearly schedule exceeds the safe integer range."
    );
  }

  const years = Array.from(
    { length: termYears },
    (_, index) =>
      Object.freeze({
        sequence: index + 1,
        seasonYear: startSeasonYear + index,
        amountCents: annualAmountCents,
      })
  );
  return Object.freeze({
    family,
    startSeasonYear,
    termYears,
    annualAmountCents,
    totalAmountCents,
    years: Object.freeze(years),
  });
}

module.exports = {
  SCHEDULE_FAMILIES,
  TRANSFORM_ERROR_CODES,
  TransformValueError,
  buildLevelYearSchedule,
  countCodePoints,
  normalizeCaseInsensitiveName,
  normalizeEmail,
  normalizePlayerPosition,
  requireExplicitStatus,
  toFantasyPointHundredths,
  toIntegerCents,
  toUtcUnixMilliseconds,
};
