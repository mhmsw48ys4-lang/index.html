exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: ""
    };
  }

  const symbol = (
    event.queryStringParameters?.symbol || ""
  ).trim().toUpperCase();

  if (!symbol) {
    return send(400, { error: "اكتب رمز السهم" });
  }

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;

  if (!apiKey) {
    return send(500, {
      error: "مفتاح Alpha Vantage غير موجود في Netlify"
    });
  }

  try {
    const url =
      "https://www.alphavantage.co/query" +
      "?function=TIME_SERIES_DAILY" +
      "&symbol=" + encodeURIComponent(symbol) +
      "&outputsize=compact" +
      "&apikey=" + encodeURIComponent(apiKey);

    const response = await fetch(url);
    const data = await response.json();

    if (data["Error Message"]) {
      return send(404, {
        error: "رمز السهم غير صحيح أو غير متوفر",
        details: data["Error Message"]
      });
    }

    if (data["Note"] || data["Information"]) {
      return send(429, {
        error: "تم الوصول إلى حد طلبات البيانات مؤقتاً",
        details: data["Note"] || data["Information"]
      });
    }

    const series = data["Time Series (Daily)"];

    if (!series) {
      return send(404, {
        error: "لم تصل بيانات السهم"
      });
    }

    const rows = Object.entries(series)
      .map(([date, v]) => ({
        date,
        open: Number(v["1. open"]),
        high: Number(v["2. high"]),
        low: Number(v["3. low"]),
        close: Number(v["4. close"]),
        volume: Number(v["5. volume"])
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (rows.length < 30) {
      return send(404, {
        error: "البيانات غير كافية للتحليل"
      });
    }

    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2];

    const lowest = rows.reduce(
      (a, b) => b.low < a.low ? b : a,
      rows[0]
    );

    const highest = rows.reduce(
      (a, b) => b.high > a.high ? b : a,
      rows[0]
    );

    return send(200, {
      symbol,
      data,
      latest,
      previous,
      lowest: {
        price: lowest.low,
        date: lowest.date
      },
      highest: {
        price: highest.high,
        date: highest.date
      }
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
