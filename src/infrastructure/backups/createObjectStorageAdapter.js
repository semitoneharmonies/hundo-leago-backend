function createObjectStorageAdapter({ client } = {}) {
  for (const method of ["getObject", "headObject", "putObject"]) {
    if (!client || typeof client[method] !== "function") {
      throw new TypeError("object storage requires a complete private client");
    }
  }

  function key(value) {
    if (
      typeof value !== "string" ||
      value.length < 1 ||
      value.length > 512 ||
      value.trim() !== value ||
      value.startsWith("/") ||
      value.includes("..") ||
      /[\u0000-\u001f\u007f-\u009f\\]/u.test(value)
    ) {
      throw new TypeError("object storage requires a canonical private key");
    }
    return value;
  }

  return Object.freeze({
    async putPrivateObject({ objectKey, body, contentType, metadata = {} } = {}) {
      if (
        !Buffer.isBuffer(body) ||
        typeof contentType !== "string" ||
        contentType.trim() === "" ||
        !metadata ||
        typeof metadata !== "object" ||
        Array.isArray(metadata)
      ) {
        throw new TypeError("object storage requires a private object payload");
      }
      return client.putObject({
        key: key(objectKey),
        body,
        contentType,
        metadata: Object.freeze({ ...metadata }),
        visibility: "private",
      });
    },
    async headPrivateObject({ objectKey } = {}) {
      return client.headObject({ key: key(objectKey) });
    },
    async getPrivateObject({ objectKey } = {}) {
      const result = await client.getObject({ key: key(objectKey) });
      if (!result || !Buffer.isBuffer(result.body)) {
        throw new Error("The private object response is invalid.");
      }
      return Object.freeze({ ...result, body: Buffer.from(result.body) });
    },
  });
}

module.exports = { createObjectStorageAdapter };
