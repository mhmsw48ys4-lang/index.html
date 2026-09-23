exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  try {
    // نأخذ قائمة أوسع من الأسهم الأمريكية من Nasdaq ثم نرشح السعر والحجم.
    // بعد ذلك يطبق index.html شروط الارتكاز الأصلية على كل مرشح.
    const url =
      "https://api.nasdaq.com/api/screener/stocks" +
      "?tableonly=true&limit=5000&offset=0";

    const response = await fetch(url, {
      headers: {
        "Accept": "application/json, text/plain, */*",
        "User-Agent": "Mozilla/5.0",
        "Referer": "https://www.nasdaq.com/"
      }
    });

    if (!response.ok) {
      throw new Error("Nasdaq screener HTTP " + response.status);
    }

    const json = await response.json();
    const rows = json?.data?.rows || [];

    const symbols = rows.map(x => {
      const symbol = String(x.symbol || x.ticker || "").trim().toUpperCase();
      const rawPrice = x.lastsale ?? x.lastSale ?? x.price ?? "";
      const price = Number(String(rawPrice).replace(/[$,]/g, ""));
      const rawVol = x.volume ?? x.avgvol3m ?? x.averageVolume ?? 0;
      const volume = Number(String(rawVol).replace(/[,]/g, ""));
      return { symbol, price, volume };
    }).filter(x =>
      x.symbol &&
      /^[-A-Z0-9.]+$/.test(x.symbol) &&
      Number.isFinite(x.price) &&
      x.price >= 1 &&
      x.price <= 7 &&
      (!x.volume || x.volume >= 100000)
    );

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        symbols: [...new Set(symbols.map(x => x.symbol))],
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