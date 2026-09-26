exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  try {
    // نستخدم Nasdaq Screener كمصدر لقائمة الأسهم بدلاً من Yahoo Screener.
    // الهدف: أسهم أمريكية بسعر $1-$7 ضمن نطاق small-cap واسع.
    // لا نحصر القائمة بقيمة سوقية شديدة الانخفاض حتى لا تختفي معظم الأسهم المرشحة للاستراتيجية.
    // نأخذ Nasdaq + NYSE + AMEX ثم نفلتر محلياً، وبعدها index.html يفحص القاع والشروط الفنية.
    const exchanges = ["NASDAQ", "NYSE", "AMEX"];

    async function getExchange(exchange) {
      const limit = 5000;
      const allRows = [];

      for (let offset = 0; offset < 20000; offset += limit) {
        const url =
          "https://api.nasdaq.com/api/screener/stocks" +
          "?tableonly=true&limit=" + limit +
          "&offset=" + offset +
          "&exchange=" + encodeURIComponent(exchange) +
          "&download=true";

        const response = await fetch(url, {
          headers: {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36",
            "Accept": "application/json,text/plain,*/*",
            "Accept-Language": "en-US,en;q=0.9",
            "Origin": "https://www.nasdaq.com",
            "Referer": "https://www.nasdaq.com/market-activity/stocks/screener"
          }
        });

        if (!response.ok) {
          throw new Error("Nasdaq " + exchange + " HTTP " + response.status);
        }

        const json = await response.json();
        const rows = json?.data?.rows;

        if (!Array.isArray(rows)) {
          throw new Error("Nasdaq " + exchange + " returned no rows");
        }

        allRows.push(...rows);

        if (rows.length < limit) break;
      }

      return allRows;
    }

    const lists = await Promise.all(exchanges.map(getExchange));
    const map = new Map();

    for (const rows of lists) {
      for (const q of rows) {
        const symbol = String(q.symbol || "").trim().toUpperCase();
        const price = Number(String(q.lastsale || "").replace(/[$,]/g, ""));
        const marketCap = Number(String(q.marketCap || "").replace(/[$,]/g, ""));

        if (
          symbol &&
          /^[A-Z0-9.-]+$/.test(symbol) &&
          Number.isFinite(price) &&
          price >= 1 &&
          price <= 7 &&
          Number.isFinite(marketCap) &&
          marketCap > 0 &&
          marketCap <= 250000000
        ) {
          map.set(symbol, q);
        }
      }
    }

    const quotes = [...map.values()];


    const symbols = quotes.map(q => String(q.symbol || "").trim().toUpperCase()).filter(Boolean);

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        symbols,
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