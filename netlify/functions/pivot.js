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
    // القاع وثبات 3-4 أيام.
    const screens = [
      "most_actives",
      "small_cap_gainers",
      "aggressive_small_caps",
      "day_gainers",
      "day_losers"
    ];

    async function getScreen(scrId) {
      const url =
        "https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved" +
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

      if (!response.ok) throw new Error(scrId + " HTTP " + response.status);

      const json = await response.json();
      return json?.finance?.result?.[0]?.quotes || [];
    }

    const lists = await Promise.allSettled(screens.map(getScreen));
    const map = new Map();

    for (const item of lists) {
      if (item.status !== "fulfilled") continue;

      for (const q of item.value) {
        const symbol = String(q.symbol || "").trim().toUpperCase();
        const price = Number(q.regularMarketPrice);
        const avgVol = Number(
          q.averageDailyVolume3Month ??
          q.averageDailyVolume10Day ??
          0
        );

        if (
          symbol &&
          /^[-A-Z0-9.]+$/.test(symbol) &&
          Number.isFinite(price) &&
          price >= 1 &&
          price <= 7 &&
          avgVol >= 100000
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