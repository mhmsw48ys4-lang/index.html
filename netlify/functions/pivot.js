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

  try {
    // نستخدم Yahoo Screener فقط لتكوين قائمة مرشحين:
    // أسهم أمريكية، سعر 1-10 دولار، وسيولة يومية معقولة.
    // شروط الارتكاز الدقيقة تُفحص لاحقاً في الموقع بنفس دوال البحث اليدوي.
    const body = {
      query: {
        operator: "AND",
        operands: [
          { operator: "EQ", operands: ["region", "us"] },
          { operator: "GTE", operands: ["intradayprice", 1] },
          { operator: "LTE", operands: ["intradayprice", 10] },
          { operator: "GT", operands: ["avgdailyvol3m", 200000] },
          {
            operator: "OR",
            operands: [
              { operator: "EQ", operands: ["exchange", "NMS"] },
              { operator: "EQ", operands: ["exchange", "NYQ"] }
            ]
          }
        ]
      },
      sortField: "dayvolume",
      sortType: "DESC",
      quoteType: "EQUITY",
      offset: 0,
      size: 100
    };

    const response = await fetch(
      "https://query2.finance.yahoo.com/v1/finance/screener" +
      "?formatted=false&lang=en-US&region=US&corsDomain=finance.yahoo.com",
      {
        method: "POST",
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json,text/plain,*/*",
          "Content-Type": "application/json"
        },
        body: JSON.stringify(body)
      }
    );

    if (!response.ok) {
      throw new Error("Yahoo Screener HTTP " + response.status);
    }

    const json = await response.json();
    const quotes = json?.finance?.result?.[0]?.quotes || [];

    const symbols = quotes
      .map(x => String(x.symbol || "").trim().toUpperCase())
      .filter(x => /^[-A-Z0-9.]+$/.test(x));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        symbols: [...new Set(symbols)],
        count: symbols.length
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