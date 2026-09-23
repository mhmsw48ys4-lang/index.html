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

  async function fetchDay(day) {
    const url =
      "https://api.nasdaq.com/api/calendar/splits" +
      "?date=" + encodeURIComponent(day) +
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

  function dateList(from, to) {
    const out = [];
    let d = new Date(from + "T00:00:00Z");
    const end = new Date(to + "T00:00:00Z");
    while (d <= end) {
      out.push(d.toISOString().slice(0,10));
      d.setUTCDate(d.getUTCDate() + 1);
    }
    return out;
  }

  try {
    /*
      The Nasdaq calendar endpoint is reliable for a specific date.
      Query each day in the requested rolling window, in small parallel
      batches, then merge and deduplicate the split events.
    */
    const all = [];
    const days = dateList(from, to);

    for (let i = 0; i < days.length; i += 10) {
      const batch = days.slice(i, i + 10);
      const results = await Promise.all(batch.map(fetchDay));
      for (const rows of results) all.push(...rows);
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