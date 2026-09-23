exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
  }

  const params = event.queryStringParameters || {};
  const from = params.fromdate || "";
  const to = params.todate || "";

  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ error: "صيغة التاريخ غير صحيحة" })
    };
  }

  function addDays(dateString, days) {
    const d = new Date(dateString + "T00:00:00Z");
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function normalizeRows(rows) {
    return (rows || []).map(x => {
      const symbol = String(
        x.symbol || x.ticker || x.Symbol || ""
      ).trim().toUpperCase();

      const rawDate = String(
        x.executionDate || x.exDate || x.date || ""
      ).trim();

      let date = rawDate.slice(0, 10);

      if (/^\d{2}\/\d{2}\/\d{4}$/.test(rawDate)) {
        const [mm, dd, yyyy] = rawDate.split("/");
        date = yyyy + "-" + mm + "-" + dd;
      }

      const ratio = String(
        x.ratio || x.splitRatio || x.Ratio || "-"
      );

      return { symbol, date, ratio };
    }).filter(x =>
      x.symbol &&
      /^[-A-Z0-9.]+$/.test(x.symbol) &&
      /^\d{4}-\d{2}-\d{2}$/.test(x.date)
    );
  }

  async function fetchRange(rangeFrom, rangeTo) {
    const url =
      "https://api.nasdaq.com/api/calendar/splits" +
      "?fromdate=" + encodeURIComponent(rangeFrom) +
      "&todate=" + encodeURIComponent(rangeTo) +
      "&limit=5000";

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.nasdaq.com/"
      }
    });

    if (!response.ok) {
      throw new Error("Nasdaq HTTP " + response.status);
    }

    const json = await response.json();
    return normalizeRows(json?.data?.rows || []);
  }

  try {
    /*
      Nasdaq's calendar endpoint can return only a limited slice when a
      large historical range is requested. Split the requested period into
      10-day windows, then merge and deduplicate the results.
    */
    const all = [];
    let cursor = from;

    while (cursor <= to) {
      const chunkTo = addDays(cursor, 9) < to ? addDays(cursor, 9) : to;
      const rows = await fetchRange(cursor, chunkTo);
      all.push(...rows);

      if (chunkTo === to) break;
      cursor = addDays(chunkTo, 1);
    }

    const unique = {};
    for (const row of all) {
      const key = row.symbol + "|" + row.date + "|" + row.ratio;
      unique[key] = row;
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ events: Object.values(unique) })
    };

  } catch (error) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: "تعذر جلب تقويم التقسيمات من Nasdaq",
        details: error.message
      })
    };
  }
};