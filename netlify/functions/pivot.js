exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  try {
    // نستخدم واجهة Yahoo الجاهزة (GET) بدل الـ custom screener الذي كان يرفض الطلب.
    // نجمع أكثر من قائمة حتى لا نعتمد على قائمة واحدة فقط.
    const screens = [
      "most_actives",
      "most_shorted_stocks",
      "aggressive_small_caps",
      "small_cap_gainers",
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
        const price = Number(q.regularMarketPrice ?? q.priceHint);
        const avgVol = Number(q.averageDailyVolume3Month ?? q.averageDailyVolume10Day ?? 0);

        if (
          symbol &&
          /^[-A-Z0-9.]+$/.test(symbol) &&
          Number.isFinite(price) &&
          price >= 1 &&
          price <= 7 &&
          avgVol >= 200000
        ) {
          map.set(symbol, q);
        }
      }
    }

    const symbols = [...map.keys()];

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        symbols,
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