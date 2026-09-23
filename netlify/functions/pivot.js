exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  try {
    // قوائم Yahoo الجاهزة تعمل عبر GET ولا تحتاج custom screener.
    // نجمع عدة قوائم لتكوين كون مرشحين واسع، ثم index.html يفحص
    // القاع والثبات 3 أيام أو أكثر. المرشح: سعر $1-$7 وقيمة سوقية <= $10M.
    // نستخدم Yahoo Custom Screener مباشرة بدل القوائم الجاهزة.
    // القوائم الجاهزة تضع حدوداً سوقية كبيرة، لذلك كانت ترجع قائمة فارغة
    // بعد شرطنا <= $10M.
    const screenBody = {
      offset: 0,
      size: 250,
      sortField: "eodvolume",
      sortType: "DESC",
      quoteType: "EQUITY",
      query: {
        operator: "AND",
        operands: [
          {
            operator: "EQ",
            operands: ["region", "us"]
          },
          {
            operator: "GTE",
            operands: ["intradayprice", 1]
          },
          {
            operator: "LTE",
            operands: ["intradayprice", 7]
          },
          {
            operator: "LTE",
            operands: ["intradaymarketcap", 10000000]
          },
          {
            operator: "IS-IN",
            operands: ["exchange", "NMS", "NYQ"]
          }
        ]
      },
      userId: "",
      userIdType: "guid"
    };

    async function getCandidates() {
      const urls = [
        "https://query2.finance.yahoo.com/v1/finance/screener",
        "https://query1.finance.yahoo.com/v1/finance/screener"
      ];

      let lastError = null;

      for (const url of urls) {
        try {
          const response = await fetch(
            url + "?formatted=false&lang=en-US&region=US&corsDomain=finance.yahoo.com",
            {
              method: "POST",
              headers: {
                "User-Agent": "Mozilla/5.0",
                "Accept": "application/json,text/plain,*/*",
                "Content-Type": "application/json"
              },
              body: JSON.stringify(screenBody)
            }
          );

          if (!response.ok) {
            lastError = new Error("Yahoo screener HTTP " + response.status);
            continue;
          }

          const json = await response.json();
          const quotes = json?.finance?.result?.[0]?.quotes;

          if (Array.isArray(quotes)) return quotes;

          lastError = new Error("Yahoo screener returned no quotes");
        } catch (e) {
          lastError = e;
        }
      }

      throw lastError || new Error("Yahoo screener failed");
    }

    const quotes = await getCandidates();

    const map = new Map();

    for (const q of quotes) {
      const symbol = String(q.symbol || "").trim().toUpperCase();
      const price = Number(q.regularMarketPrice);
      const marketCap = Number(q.marketCap);

      if (
        symbol &&
        /^[-A-Z0-9.]+$/.test(symbol) &&
        Number.isFinite(price) &&
        price >= 1 &&
        price <= 7 &&
        Number.isFinite(marketCap) &&
        marketCap <= 10000000
      ) {
        map.set(symbol, q);
      }
    }

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        symbols: [...map.keys()],
        count: map.size
      })
    };
  } catch (error) {
    return {
      statusCode: 502,
      headers,
      body: JSON.stringify({
        error: "تعذر جلب قائمة الأسهم المرشحة",
        details: error.message
      })
    };
  }
};