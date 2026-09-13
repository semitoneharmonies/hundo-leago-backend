const DEFAULT_USER_AGENT = "hundo-leago/1.0";
const DEFAULT_ORIGIN = "https://api.nhle.com";

function createNhlStatisticsAdapter({
  fetchImpl = fetch,
  seasonId,
  gameTypeId = 2,
  pageSize = 100,
  userAgent = DEFAULT_USER_AGENT,
  origin = DEFAULT_ORIGIN,
} = {}) {
  if (!seasonId) {
    throw new TypeError(
      "createNhlStatisticsAdapter requires a seasonId"
    );
  }
  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new TypeError("createNhlStatisticsAdapter requires an HTTPS origin");
  }
  if (
    parsedOrigin.protocol !== "https:" ||
    parsedOrigin.origin !== origin ||
    parsedOrigin.username ||
    parsedOrigin.password
  ) {
    throw new TypeError("createNhlStatisticsAdapter requires an HTTPS origin");
  }

  function buildUrl(start) {
    const sort = encodeURIComponent(
      JSON.stringify([
        { property: "points", direction: "DESC" },
        { property: "playerId", direction: "ASC" },
      ])
    );
    const cayenneExpression = encodeURIComponent(
      `gameTypeId=${gameTypeId} and seasonId>=${seasonId} and seasonId<=${seasonId}`
    );
    const factCayenneExpression =
      encodeURIComponent("gamesPlayed>=1");

    return (
      `${origin}/stats/rest/en/skater/summary` +
      `?isAggregate=false&isGame=false&sort=${sort}` +
      `&start=${start}&limit=${pageSize}` +
      `&factCayenneExp=${factCayenneExpression}` +
      `&cayenneExp=${cayenneExpression}`
    );
  }

  async function fetchJson(url) {
    const response = await fetchImpl(url, {
      headers: { "User-Agent": userAgent },
    });
    if (!response.ok) {
      throw new Error(
        `NHL stats fetch failed: ${response.status} ${response.statusText}`
      );
    }
    return response.json();
  }

  async function fetchRows() {
    const first = await fetchJson(buildUrl(0));
    const total = Number(first?.total || 0);
    const pages = Math.ceil(total / pageSize);

    if (!Array.isArray(first?.data) || total <= 0) {
      throw new Error(`Unexpected NHL response (total=${total})`);
    }

    const rows = [...first.data];

    for (let pageIndex = 1; pageIndex < pages; pageIndex += 1) {
      const page = await fetchJson(buildUrl(pageIndex * pageSize));
      if (!Array.isArray(page?.data)) {
        throw new Error("Unexpected NHL page shape");
      }
      rows.push(...page.data);
    }

    return rows;
  }

  return {
    buildUrl,
    fetchRows,
  };
}

module.exports = {
  DEFAULT_USER_AGENT,
  DEFAULT_ORIGIN,
  createNhlStatisticsAdapter,
};
