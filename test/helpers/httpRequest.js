async function httpRequest(
  baseUrl,
  requestPath,
  { method = "GET", headers, body, timeoutMs = 3000 } = {}
) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(new URL(requestPath, baseUrl), {
      method,
      headers,
      body,
      signal: controller.signal,
    });

    const text = await response.text();
    const contentType = response.headers.get("content-type") || "";
    let json = null;

    if (text && contentType.toLowerCase().includes("application/json")) {
      json = JSON.parse(text);
    }

    return {
      status: response.status,
      contentType,
      text,
      json,
    };
  } finally {
    clearTimeout(timeout);
  }
}

module.exports = { httpRequest };
