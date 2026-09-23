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

  try {
    const url =
      "https://api.nasdaq.com/api/calendar/splits" +
      "?fromdate=" + encodeURIComponent(from) +
      "&todate=" + encodeURIComponent(to) +
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
    const rows = json?.data?.rows || [];

    const events = rows.map(x => {
      const symbol = String(
        x.symbol || x.ticker || x.Symbol || ""
      ).trim().toUpperCase();

      const date = String(
        x.exDate || x.executionDate || x.date || ""
      ).slice(0, 10);

      const ratio = String(
        x.ratio || x.splitRatio || x.Ratio || "-"
      );

      return { symbol, date, ratio };
    }).filter(x =>
      x.symbol &&
      /^[-A-Z0-9.]+$/.test(x.symbol) &&
      /^\d{4}-\d{2}-\d{2}$/.test(x.date)
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ events })
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