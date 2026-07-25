const crypto = require("node:crypto");

function sha256(value) {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function hmac(key, value, encoding) {
  return crypto.createHmac("sha256", key).update(value).digest(encoding);
}

function encodeSegment(value) {
  return encodeURIComponent(value).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`
  );
}

function canonicalObjectPath(bucket, key) {
  return `/${encodeSegment(bucket)}/${key.split("/").map(encodeSegment).join("/")}`;
}

function amzTime(value) {
  if (!(value instanceof Date) || Number.isNaN(value.getTime())) {
    throw new TypeError("S3 client requires a valid request time");
  }
  return value.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

function createS3CompatibleClient({
  endpoint,
  region,
  bucket,
  accessKeyId,
  secretAccessKey,
  fetchImplementation = fetch,
  now = () => new Date(),
} = {}) {
  let parsedEndpoint;
  try {
    parsedEndpoint = new URL(endpoint);
  } catch {
    throw new TypeError("S3 client requires a canonical HTTPS endpoint");
  }
  if (
    parsedEndpoint.protocol !== "https:" ||
    parsedEndpoint.origin !== endpoint ||
    typeof region !== "string" ||
    region.trim() === "" ||
    typeof bucket !== "string" ||
    bucket.trim() === "" ||
    typeof accessKeyId !== "string" ||
    accessKeyId.trim() === "" ||
    typeof secretAccessKey !== "string" ||
    secretAccessKey.trim() === "" ||
    typeof fetchImplementation !== "function" ||
    typeof now !== "function"
  ) {
    throw new TypeError("S3 client requires complete private configuration");
  }

  async function request({ method, key, body = Buffer.alloc(0), contentType, metadata = {} }) {
    if (!Buffer.isBuffer(body)) {
      throw new TypeError("S3 client requires a buffer payload");
    }
    const timestamp = amzTime(now());
    const date = timestamp.slice(0, 8);
    const payloadHash = sha256(body);
    const canonicalUri = canonicalObjectPath(bucket, key);
    const headers = {
      host: parsedEndpoint.host,
      "x-amz-content-sha256": payloadHash,
      "x-amz-date": timestamp,
    };
    if (contentType) headers["content-type"] = contentType;
    for (const [name, value] of Object.entries(metadata).sort(([a], [b]) => a.localeCompare(b))) {
      if (!/^[a-z0-9-]{1,64}$/.test(name) || typeof value !== "string") {
        throw new TypeError("S3 client metadata is invalid");
      }
      headers[`x-amz-meta-${name}`] = value.trim();
    }
    const canonicalHeaderNames = Object.keys(headers).sort();
    const canonicalHeaders = canonicalHeaderNames
      .map((name) => `${name}:${headers[name].replace(/\s+/g, " ").trim()}\n`)
      .join("");
    const signedHeaders = canonicalHeaderNames.join(";");
    const canonicalRequest = [
      method,
      canonicalUri,
      "",
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join("\n");
    const scope = `${date}/${region}/s3/aws4_request`;
    const stringToSign = [
      "AWS4-HMAC-SHA256",
      timestamp,
      scope,
      sha256(canonicalRequest),
    ].join("\n");
    const dateKey = hmac(`AWS4${secretAccessKey}`, date);
    const regionKey = hmac(dateKey, region);
    const serviceKey = hmac(regionKey, "s3");
    const signingKey = hmac(serviceKey, "aws4_request");
    const signature = hmac(signingKey, stringToSign, "hex");
    headers.authorization =
      `AWS4-HMAC-SHA256 Credential=${accessKeyId}/${scope}, ` +
      `SignedHeaders=${signedHeaders}, Signature=${signature}`;
    const response = await fetchImplementation(`${endpoint}${canonicalUri}`, {
      method,
      headers,
      body: method === "PUT" ? body : undefined,
      redirect: "error",
    });
    if (!response?.ok) {
      const error = new Error("The private object-storage request failed.");
      error.code = "BACKUP_OBJECT_STORAGE_FAILED";
      error.status = response?.status || null;
      throw error;
    }
    return response;
  }

  return Object.freeze({
    async putObject({ key, body, contentType, metadata, visibility } = {}) {
      if (visibility !== "private") {
        throw new TypeError("S3 backup objects must remain private");
      }
      await request({ method: "PUT", key, body, contentType, metadata });
      return Object.freeze({ stored: true });
    },
    async headObject({ key } = {}) {
      const response = await request({ method: "HEAD", key });
      const byteSize = Number(response.headers.get("content-length"));
      const checksum = response.headers.get("x-amz-meta-sha256");
      if (!Number.isSafeInteger(byteSize) || byteSize < 0 || !/^[a-f0-9]{64}$/.test(checksum || "")) {
        throw new Error("The private object metadata is incomplete.");
      }
      return Object.freeze({ byteSize, sha256: checksum });
    },
    async getObject({ key } = {}) {
      const response = await request({ method: "GET", key });
      return Object.freeze({ body: Buffer.from(await response.arrayBuffer()) });
    },
  });
}

module.exports = {
  amzTime,
  canonicalObjectPath,
  createS3CompatibleClient,
  encodeSegment,
};
