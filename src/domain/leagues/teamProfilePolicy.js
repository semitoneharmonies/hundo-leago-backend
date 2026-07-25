const MAXIMUM_LOGO_BYTES = 512 * 1024;
const MAXIMUM_LOGO_DIMENSION = 2048;
const MAXIMUM_TEAM_NAME_CODE_POINTS = 35;
const FORBIDDEN_TEXT_PATTERN =
  /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u;
const SUPPORTED_LOGO_MEDIA_TYPES = Object.freeze([
  "image/jpeg",
  "image/png",
  "image/webp",
]);
const SUPPORTED_LOGO_MEDIA_TYPE_SET = new Set(
  SUPPORTED_LOGO_MEDIA_TYPES
);
const COLOUR_PATTERN = /^#[0-9a-f]{6}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const PROFILE_KEYS = new Set([
  "logo",
  "name",
  "primaryColour",
  "secondaryColour",
]);
const LOGO_KEYS = new Set(["contentBase64", "mediaType"]);

class TeamProfilePolicyError extends Error {
  constructor(reasonCode) {
    super("The team-profile request is invalid.");
    this.name = "TeamProfilePolicyError";
    this.code = "TEAM_PROFILE_INPUT_INVALID";
    this.reasonCode = reasonCode;
  }
}

function fail(reasonCode) {
  throw new TeamProfilePolicyError(reasonCode);
}

function isPlainObject(value) {
  if (
    value === null ||
    typeof value !== "object" ||
    Array.isArray(value)
  ) {
    return false;
  }
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateTeamName(value) {
  if (typeof value !== "string") fail("team_name_invalid");
  const name = value.trim();
  const nameNormalized = name.toLowerCase();
  if (
    name.length < 1 ||
    Array.from(name).length > MAXIMUM_TEAM_NAME_CODE_POINTS ||
    FORBIDDEN_TEXT_PATTERN.test(name) ||
    nameNormalized.length > 120
  ) {
    fail("team_name_invalid");
  }
  return Object.freeze({ name, nameNormalized });
}

function exactKeys(value, approvedKeys, expectedCount = null) {
  if (!isPlainObject(value)) return false;
  const keys = Object.keys(value);
  return (
    (expectedCount === null || keys.length === expectedCount) &&
    keys.every((key) => approvedKeys.has(key))
  );
}

function validateExpectedVersion(value) {
  if (!Number.isSafeInteger(value) || value < 1) {
    fail("expected_version_invalid");
  }
  return value;
}

function validateColour(value) {
  if (typeof value !== "string" || !COLOUR_PATTERN.test(value)) {
    fail("team_colour_invalid");
  }
  return value;
}

function validateDimensions(width, height) {
  if (
    !Number.isSafeInteger(width) ||
    !Number.isSafeInteger(height) ||
    width < 1 ||
    height < 1 ||
    width > MAXIMUM_LOGO_DIMENSION ||
    height > MAXIMUM_LOGO_DIMENSION
  ) {
    fail("team_logo_dimensions_invalid");
  }
  return { width, height };
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value =
        value & 1
          ? 0xedb88320 ^ (value >>> 1)
          : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value = CRC32_TABLE[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function inspectPng(bytes) {
  const signature = Buffer.from("89504e470d0a1a0a", "hex");
  if (bytes.length < 45 || !bytes.subarray(0, 8).equals(signature)) {
    fail("team_logo_content_invalid");
  }
  let offset = 8;
  let dimensions = null;
  let sawIdat = false;
  let sawIend = false;
  let chunkIndex = 0;
  while (offset < bytes.length) {
    if (offset + 12 > bytes.length) fail("team_logo_content_invalid");
    const length = bytes.readUInt32BE(offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + 4;
    if (chunkEnd > bytes.length) fail("team_logo_content_invalid");
    const typeBytes = bytes.subarray(typeStart, dataStart);
    const type = typeBytes.toString("ascii");
    if (!/^[A-Za-z]{4}$/.test(type)) fail("team_logo_content_invalid");
    const expectedCrc = bytes.readUInt32BE(dataEnd);
    if (
      crc32(bytes.subarray(typeStart, dataEnd)) !== expectedCrc
    ) {
      fail("team_logo_content_invalid");
    }
    if (chunkIndex === 0 && (type !== "IHDR" || length !== 13)) {
      fail("team_logo_content_invalid");
    }
    if (type === "IHDR") {
      if (dimensions || length !== 13) fail("team_logo_content_invalid");
      const colourType = bytes[dataStart + 9];
      const bitDepth = bytes[dataStart + 8];
      const validDepths = {
        0: new Set([1, 2, 4, 8, 16]),
        2: new Set([8, 16]),
        3: new Set([1, 2, 4, 8]),
        4: new Set([8, 16]),
        6: new Set([8, 16]),
      };
      if (
        !validDepths[colourType]?.has(bitDepth) ||
        bytes[dataStart + 10] !== 0 ||
        bytes[dataStart + 11] !== 0 ||
        ![0, 1].includes(bytes[dataStart + 12])
      ) {
        fail("team_logo_content_invalid");
      }
      dimensions = validateDimensions(
        bytes.readUInt32BE(dataStart),
        bytes.readUInt32BE(dataStart + 4)
      );
    } else if (type === "acTL") {
      fail("team_logo_animation_not_allowed");
    } else if (type === "IDAT") {
      if (!dimensions || sawIend) fail("team_logo_content_invalid");
      sawIdat = true;
    } else if (type === "IEND") {
      if (length !== 0 || !sawIdat || sawIend) {
        fail("team_logo_content_invalid");
      }
      sawIend = true;
      if (chunkEnd !== bytes.length) fail("team_logo_content_invalid");
    }
    offset = chunkEnd;
    chunkIndex += 1;
  }
  if (!dimensions || !sawIdat || !sawIend) {
    fail("team_logo_content_invalid");
  }
  return dimensions;
}

const JPEG_START_OF_FRAME_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7,
  0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);

function inspectJpeg(bytes) {
  if (
    bytes.length < 12 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8
  ) {
    fail("team_logo_content_invalid");
  }
  let offset = 2;
  let dimensions = null;
  let sawScan = false;
  while (offset < bytes.length) {
    if (bytes[offset] !== 0xff) fail("team_logo_content_invalid");
    const markerStart = offset;
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) fail("team_logo_content_invalid");
    const marker = bytes[offset];
    offset += 1;
    if (marker === 0xd9) {
      if (!dimensions || !sawScan || offset !== bytes.length) {
        fail("team_logo_content_invalid");
      }
      return dimensions;
    }
    if (marker === 0x00 || marker === 0xd8) {
      fail("team_logo_content_invalid");
    }
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
      if (!sawScan) fail("team_logo_content_invalid");
      continue;
    }
    if (offset + 2 > bytes.length) fail("team_logo_content_invalid");
    const length = bytes.readUInt16BE(offset);
    if (length < 2 || offset + length > bytes.length) {
      fail("team_logo_content_invalid");
    }
    const dataStart = offset + 2;
    const segmentEnd = offset + length;
    if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
      if (length < 8 || dimensions || sawScan) {
        fail("team_logo_content_invalid");
      }
      dimensions = validateDimensions(
        bytes.readUInt16BE(dataStart + 3),
        bytes.readUInt16BE(dataStart + 1)
      );
    }
    offset = segmentEnd;
    if (marker === 0xda) {
      sawScan = true;
      while (offset < bytes.length) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        let next = offset + 1;
        while (next < bytes.length && bytes[next] === 0xff) next += 1;
        if (next >= bytes.length) fail("team_logo_content_invalid");
        if (bytes[next] === 0x00 || (bytes[next] >= 0xd0 && bytes[next] <= 0xd7)) {
          offset = next + 1;
          continue;
        }
        offset = markerStart === offset ? offset + 1 : offset;
        break;
      }
    }
  }
  fail("team_logo_content_invalid");
}

function inspectWebp(bytes) {
  if (
    bytes.length < 20 ||
    bytes.toString("ascii", 0, 4) !== "RIFF" ||
    bytes.toString("ascii", 8, 12) !== "WEBP" ||
    bytes.readUInt32LE(4) + 8 !== bytes.length
  ) {
    fail("team_logo_content_invalid");
  }
  let offset = 12;
  let containerDimensions = null;
  let imageDimensions = null;
  let imageChunks = 0;
  while (offset < bytes.length) {
    if (offset + 8 > bytes.length) fail("team_logo_content_invalid");
    const type = bytes.toString("ascii", offset, offset + 4);
    const length = bytes.readUInt32LE(offset + 4);
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    const chunkEnd = dataEnd + (length % 2);
    if (chunkEnd > bytes.length) fail("team_logo_content_invalid");
    if (type === "ANIM" || type === "ANMF") {
      fail("team_logo_animation_not_allowed");
    }
    if (type === "VP8X") {
      if (length !== 10 || containerDimensions) {
        fail("team_logo_content_invalid");
      }
      if (
        bytes[dataStart] & 0xc1 ||
        bytes[dataStart + 1] !== 0 ||
        bytes[dataStart + 2] !== 0 ||
        bytes[dataStart + 3] !== 0
      ) {
        fail("team_logo_content_invalid");
      }
      if (bytes[dataStart] & 0x02) {
        fail("team_logo_animation_not_allowed");
      }
      containerDimensions = validateDimensions(
        bytes.readUIntLE(dataStart + 4, 3) + 1,
        bytes.readUIntLE(dataStart + 7, 3) + 1
      );
    } else if (type === "VP8 ") {
      if (
        length < 10 ||
        bytes[dataStart] & 0x01 ||
        bytes[dataStart + 3] !== 0x9d ||
        bytes[dataStart + 4] !== 0x01 ||
        bytes[dataStart + 5] !== 0x2a
      ) {
        fail("team_logo_content_invalid");
      }
      imageDimensions = validateDimensions(
        bytes.readUInt16LE(dataStart + 6) & 0x3fff,
        bytes.readUInt16LE(dataStart + 8) & 0x3fff
      );
      imageChunks += 1;
    } else if (type === "VP8L") {
      if (length < 5 || bytes[dataStart] !== 0x2f) {
        fail("team_logo_content_invalid");
      }
      const packed = bytes.readUInt32LE(dataStart + 1);
      if ((packed >>> 28) !== 0) fail("team_logo_content_invalid");
      imageDimensions = validateDimensions(
        (packed & 0x3fff) + 1,
        ((packed >>> 14) & 0x3fff) + 1
      );
      imageChunks += 1;
    }
    offset = chunkEnd;
  }
  if (
    offset !== bytes.length ||
    imageChunks !== 1 ||
    !imageDimensions ||
    (containerDimensions &&
      (containerDimensions.width !== imageDimensions.width ||
        containerDimensions.height !== imageDimensions.height))
  ) {
    fail("team_logo_content_invalid");
  }
  return imageDimensions;
}

function inspectTeamLogo(value) {
  if (!exactKeys(value, LOGO_KEYS, 2)) {
    fail("team_logo_input_invalid");
  }
  if (!SUPPORTED_LOGO_MEDIA_TYPE_SET.has(value.mediaType)) {
    fail("team_logo_media_type_invalid");
  }
  if (
    typeof value.contentBase64 !== "string" ||
    value.contentBase64.length < 1 ||
    value.contentBase64.length > 699052 ||
    !BASE64_PATTERN.test(value.contentBase64)
  ) {
    fail("team_logo_base64_invalid");
  }
  const bytes = Buffer.from(value.contentBase64, "base64");
  if (
    bytes.length < 1 ||
    bytes.length > MAXIMUM_LOGO_BYTES ||
    bytes.toString("base64") !== value.contentBase64
  ) {
    fail(
      bytes.length > MAXIMUM_LOGO_BYTES
        ? "team_logo_bytes_too_large"
        : "team_logo_base64_invalid"
    );
  }
  const dimensions =
    value.mediaType === "image/png"
      ? inspectPng(bytes)
      : value.mediaType === "image/jpeg"
        ? inspectJpeg(bytes)
        : inspectWebp(bytes);
  return Object.freeze({
    byteLength: bytes.length,
    bytes,
    height: dimensions.height,
    mediaType: value.mediaType,
    width: dimensions.width,
  });
}

function validateTeamProfileInput(input) {
  if (
    !exactKeys(input, PROFILE_KEYS) ||
    Object.keys(input).length < 1
  ) {
    fail("team_profile_input_invalid");
  }
  const hasName = Object.prototype.hasOwnProperty.call(input, "name");
  const hasPrimary = Object.prototype.hasOwnProperty.call(
    input,
    "primaryColour"
  );
  const hasSecondary = Object.prototype.hasOwnProperty.call(
    input,
    "secondaryColour"
  );
  const hasLogo = Object.prototype.hasOwnProperty.call(input, "logo");
  if (hasPrimary !== hasSecondary) fail("team_colours_incomplete");
  let name = null;
  if (hasName) name = validateTeamName(input.name);
  let colours = null;
  if (hasPrimary) {
    if (input.primaryColour === null && input.secondaryColour === null) {
      colours = Object.freeze({ primaryColour: null, secondaryColour: null });
    } else {
      colours = Object.freeze({
        primaryColour: validateColour(input.primaryColour),
        secondaryColour: validateColour(input.secondaryColour),
      });
    }
  }
  const logo = !hasLogo
    ? undefined
    : input.logo === null
      ? null
      : inspectTeamLogo(input.logo);
  return Object.freeze({ colours, hasLogo, hasName, logo, name });
}

module.exports = {
  COLOUR_PATTERN,
  MAXIMUM_LOGO_BYTES,
  MAXIMUM_LOGO_DIMENSION,
  SUPPORTED_LOGO_MEDIA_TYPES,
  TeamProfilePolicyError,
  inspectTeamLogo,
  validateExpectedVersion,
  validateTeamProfileInput,
};
