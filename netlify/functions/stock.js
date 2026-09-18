exports.handler = async (event) => {

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: ""
    };
  }

  const symbol =
    (event.queryStringParameters?.symbol || "")
      .trim()
      .toUpperCase();

  if (!symbol) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({
        error: "اكتب رمز السهم"
      })
    };
  }

  const key =
    process.env.ALPHA_VANTAGE_API_KEY;

  if (!key) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "مفتاح Alpha Vantage غير موجود"
      })
    };
  }

  try {

    const url =
      "https://www.alphavantage.co/query" +
      "?function=TIME_SERIES_DAILY" +
      "&symbol=" +
      encodeURIComponent(symbol) +
      "&outputsize=compact" +
      "&apikey=" +
      encodeURIComponent(key);

    const r = await fetch(url);

    const data = await r.json();

    if (data["Error Message"]) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: "رمز السهم غير صحيح",
          details: data["Error Message"]
        })
      };
    }

    if (data["Note"] || data["Information"]) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
          error:
            "Alpha Vantage أوقف الطلب مؤقتاً بسبب حد الطلبات",
          details:
            data["Note"] ||
            data["Information"]
        })
      };
    }

    const series =
      data["Time Series (Daily)"];

    if (!series) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "لم تصل بيانات الأسعار",
          response: data
        })
      };
    }

    const dates =
      Object.keys(series).sort().reverse();

    const latestDate = dates[0];

    const latest =
      series[latestDate];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({

        data: data,

        symbol: symbol,

        latest: {
          date: latestDate,
          open:
            Number(latest["1. open"]),
          high:
            Number(latest["2. high"]),
          low:
            Number(latest["3. low"]),
          close:
            Number(latest["4. close"]),
          volume:
            Number(latest["5. volume"])
        },

        lowest: {
          price:
            Math.min(
              ...dates.map(
                d =>
                  Number(
                    series[d]["3. low"]
                  )
              )
            )
        },

        highest: {
          price:
            Math.max(
              ...dates.map(
                d =>
                  Number(
                    series[d]["2. high"]
                  )
              )
            )
        }

      })
    };

  } catch (error) {

    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error:
          "خطأ في الاتصال بمصدر الأسعار",
        details:
          error.message
      })
    };

  }
};
