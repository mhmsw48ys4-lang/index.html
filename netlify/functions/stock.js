exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers,
        body: ""
      };
    }

    const symbol = event.queryStringParameters?.symbol
      ?.trim()
      .toUpperCase();

    if (!symbol) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "رمز السهم مطلوب"
        })
      };
    }

    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: "مفتاح Alpha Vantage غير موجود في Netlify"
        })
      };
    }

    const url =
      "https://www.alphavantage.co/query" +
      "?function=TIME_SERIES_DAILY" +
      "&symbol=" + encodeURIComponent(symbol) +
      "&outputsize=compact" +
      "&apikey=" + encodeURIComponent(apiKey);

    const response = await fetch(url);

    if (!response.ok) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "تعذر الاتصال بمصدر البيانات",
          status: response.status
        })
      };
    }

    const data = await response.json();

    if (data["Error Message"]) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: "السهم غير موجود",
          symbol
        })
      };
    }

    if (data["Note"]) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
          error: "تم تجاوز حد طلبات Alpha Vantage",
          message: data["Note"]
        })
      };
    }

    if (!data["Time Series (Daily)"]) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "لم تصل بيانات الأسعار",
          symbol,
          data
        })
      };
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        symbol,
        source: "Alpha Vantage",
        data
      })
    };

  } catch (error) {
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({
        error: "حدث خطأ في الاتصال",
        details: error.message
      })
    };
  }
};
