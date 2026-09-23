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
    const screens = [
      "most_actives",
      "small_cap_gainers",
      "aggressive_small_caps",
      "day_gainers",
      "day_losers"
    ];

    async function getScreen(scrId) {
      const bases = [
        "https://query2.finance.yahoo.com/v1/finance/screener/predefined/saved",
        "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved"
      ];
      let lastError = null;

      for (const base of bases) {
        try {
          const url =
            base +
            "?formatted=false&lang=en-US&region=US" +
            "&scrIds=" + encodeURIComponent(scrId) +
            "&count=250&start=0" +
            "&corsDomain=finance.yahoo.com";

          const response = await fetch(url, {
            headers: {
              "User-Agent": "Mozilla/5.0",
              "Accept": "application/json,text/plain,*/*"
            }
          });

          if (!response.ok) {
            lastError = new Error(scrId + " HTTP " + response.status);
            continue;
          }

          const json = await response.json();
          const quotes = json?.finance?.result?.[0]?.quotes;

          if (Array.isArray(quotes) && quotes.length) return quotes;

          lastError = new Error(scrId + " returned no quotes");
        } catch (e) {
          lastError = e;
        }
      }

      throw lastError || new Error(scrId + " failed");
    }

    const lists = await Promise.allSettled(screens.map(getScreen));
    const map = new Map();

    for (const item of lists) {
      if (item.status !== "fulfilled") continue;

      for (const q of item.value) {
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