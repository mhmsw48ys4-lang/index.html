exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  try {
    const body = {
      query: {
        operator: "AND",
        operands: [
          { operator: "EQ", operands: ["region", "us"] },
          { operator: "GTE", operands: ["intradayprice", 1] },
          { operator: "LTE", operands: ["intradayprice", 10] },
          { operator: "GT", operands: ["avgdailyvol3m", 200000] },
          { operator: "IS-IN", operands: ["exchange", ["NMS", "NYQ", "ASE", "BTS"]] }
        ]
      },
      sortField: "dayvolume",
      sortType: "DESC",
      quoteType: "EQUITY",
      offset: 0,
      size: 250,
      userId: "",
      userIdType: "guid"
    };

    // Yahoo's custom screener endpoint can require a crumb/cookie pair.
    // Get them first, then submit the screener request server-side.
    const crumbResponse = await fetch(
      "https://query1.finance.yahoo.com/v1/test/getcrumb",
      {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "text/plain,*/*"
        }
      }
    );

    if (!crumbResponse.ok) {
      throw new Error("Yahoo crumb HTTP " + crumbResponse.status);
    }

    const crumb = (await crumbResponse.text()).trim();
    const setCookie = crumbResponse.headers.get("set-cookie") || "";
    const cookie = setCookie
      .split(",")
      .map(x => x.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");

    if (!crumb) throw new Error("Yahoo لم يرجع مفتاح الجلسة");

    const url =
      "https://query1.finance.yahoo.com/v1/finance/screener" +
      "?crumb=" + encodeURIComponent(crumb) +
      "&formatted=false&lang=en-US&region=US&corsDomain=finance.yahoo.com";

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json,text/plain,*/*",
        "Content-Type": "application/json",
        ...(cookie ? { "Cookie": cookie } : {})
      },
      body: JSON.stringify(body)
    });

    if (!response.ok) {
      const detail = await response.text();
      throw new Error("Yahoo Screener HTTP " + response.status + " — " + detail.slice(0,180));
    }

    const json = await response.json();
    const quotes = json?.finance?.result?.[0]?.quotes || [];

    const symbols = quotes
      .map(x => String(x.symbol || "").trim().toUpperCase())
      .filter(x => /^[-A-Z0-9.]+$/.test(x));

    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({ symbols: [...new Set(symbols)], count: symbols.length })
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