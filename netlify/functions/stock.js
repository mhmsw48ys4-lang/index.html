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

  const symbol = (event.queryStringParameters?.symbol || "").trim().toUpperCase();

  if (!symbol) {
    return send(400, { error: "اكتب رمز السهم" });
  }

  try {
    const yahooUrl =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?range=1y&interval=1d&events=splits&includeAdjustedClose=true";

    const response = await fetch(yahooUrl, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*"
      }
    });

    if (!response.ok) {
      throw new Error("Yahoo HTTP " + response.status);
    }

    const json = await response.json();
    const result = json?.chart?.result?.[0];

    if (!result) {
      throw new Error("لم تصل بيانات السهم من Yahoo");
    }

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};

    const rows = timestamps.map((ts, i) => {
      const d = new Date(Number(ts) * 1000);
      const date =
        d.getUTCFullYear() + "-" +
        String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
        String(d.getUTCDate()).padStart(2, "0");

      return {
        date,
        open: Number(quote.open?.[i]),
        high: Number(quote.high?.[i]),
        low: Number(quote.low?.[i]),
        close: Number(quote.close?.[i]),
        volume: Number(quote.volume?.[i] || 0)
      };
    }).filter(x =>
      [x.open, x.high, x.low, x.close].every(Number.isFinite)
    ).sort((a, b) => a.date.localeCompare(b.date));

    if (rows.length < 30) {
      return send(404, { error: "البيانات غير كافية للتحليل" });
    }

    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2];

    const lowest = rows.reduce((a, b) => b.low < a.low ? b : a, rows[0]);
    const highest = rows.reduce((a, b) => b.high > a.high ? b : a, rows[0]);

    const yahooSplits = result?.events?.splits || {};

    const splitList = Object.values(yahooSplits)
      .map(x => {
        const timestamp = Number(x.date);
        if (!timestamp) return null;

        const d = new Date(timestamp * 1000);
        const date =
          d.getUTCFullYear() + "-" +
          String(d.getUTCMonth() + 1).padStart(2, "0") + "-" +
          String(d.getUTCDate()).padStart(2, "0");

        return {
          date,
          numerator: x.numerator ?? null,
          denominator: x.denominator ?? null
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.date.localeCompare(b.date));

    const lastSplit = splitList.length
      ? splitList[splitList.length - 1]
      : null;

    let postSplitRows = rows;
    if (lastSplit) {
      postSplitRows = rows.filter(x => x.date >= lastSplit.date);
    }

    const highestAfterSplit = postSplitRows.length
      ? postSplitRows.reduce((a, b) => b.high > a.high ? b : a, postSplitRows[0])
      : null;

    const lowestAfterSplit = postSplitRows.length
      ? postSplitRows.reduce((a, b) => b.low < a.low ? b : a, postSplitRows[0])
      : null;

    let daysAfterSplit = null;
    if (lastSplit) {
      const d1 = new Date(lastSplit.date + "T00:00:00");
      const d2 = new Date(latest.date + "T00:00:00");
      daysAfterSplit = Math.max(
        0,
        Math.floor((d2.getTime() - d1.getTime()) / (1000 * 60 * 60 * 24))
      );
    }

    const ratio =
      lastSplit && lastSplit.numerator && lastSplit.denominator
        ? lastSplit.numerator + ":" + lastSplit.denominator
        : null;

    const data = {
      "Time Series (Daily)": Object.fromEntries(
        rows.map(x => [
          x.date,
          {
            "1. open": String(x.open),
            "2. high": String(x.high),
            "3. low": String(x.low),
            "4. close": String(x.close),
            "5. volume": String(x.volume)
          }
        ])
      )
    };

    return send(200, {
      symbol,
      data,
      latest,
      previous,
      lowest: { price: lowest.low, date: lowest.date },
      highest: { price: highest.high, date: highest.date },
      split: lastSplit
        ? {
            date: lastSplit.date,
            ratio,
            numerator: lastSplit.numerator,
            denominator: lastSplit.denominator,
            daysAfter: daysAfterSplit,
            highestAfter: highestAfterSplit
              ? { price: highestAfterSplit.high, date: highestAfterSplit.date }
              : null,
            lowestAfter: lowestAfterSplit
              ? { price: lowestAfterSplit.low, date: lowestAfterSplit.date }
              : null
          }
        : null
    });

  } catch (error) {
    return send(500, {
      error: "حدث خطأ أثناء جلب بيانات السهم",
      details: error.message
    });
  }
};

function send(statusCode, body) {
  return {
    statusCode,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json; charset=utf-8"
    },
    body: JSON.stringify(body)
  };
}
