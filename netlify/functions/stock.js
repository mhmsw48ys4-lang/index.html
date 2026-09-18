exports.handler = async (event) => {

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") {
    return {
      statusCode: 204,
      headers,
      body: ""
    };
  }

  const symbol = (
    event.queryStringParameters?.symbol || ""
  ).trim().toUpperCase();

  if (!symbol) {
    return send(400, {
      error: "اكتب رمز السهم"
    });
  }

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;

  if (!apiKey) {
    return send(500, {
      error: "مفتاح Alpha Vantage غير موجود في Netlify"
    });
  }

  try {

    /* =========================
       1 — الأسعار اليومية
    ========================= */

    const dailyUrl =
      "https://www.alphavantage.co/query" +
      "?function=TIME_SERIES_DAILY" +
      "&symbol=" + encodeURIComponent(symbol) +
      "&outputsize=compact" +
      "&apikey=" + encodeURIComponent(apiKey);

    const dailyResponse = await fetch(dailyUrl);
    const data = await dailyResponse.json();

    if (data["Error Message"]) {
      return send(404, {
        error: "رمز السهم غير صحيح أو غير متوفر"
      });
    }

    if (data["Note"] || data["Information"]) {
      return send(429, {
        error: "تم الوصول إلى حد طلبات البيانات مؤقتاً",
        details: data["Note"] || data["Information"]
      });
    }

    const series = data["Time Series (Daily)"];

    if (!series) {
      return send(404, {
        error: "لم تصل بيانات السهم"
      });
    }

    const rows = Object.entries(series)
      .map(([date, v]) => ({
        date,
        open: Number(v["1. open"]),
        high: Number(v["2. high"]),
        low: Number(v["3. low"]),
        close: Number(v["4. close"]),
        volume: Number(v["5. volume"])
      }))
      .filter(x =>
        Number.isFinite(x.open) &&
        Number.isFinite(x.high) &&
        Number.isFinite(x.low) &&
        Number.isFinite(x.close)
      )
      .sort((a, b) =>
        a.date.localeCompare(b.date)
      );

    if (rows.length < 30) {
      return send(404, {
        error: "البيانات غير كافية للتحليل"
      });
    }

    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2];


    /* =========================
       2 — أعلى وأدنى سعر عام
    ========================= */

    const lowest = rows.reduce(
      (a, b) => b.low < a.low ? b : a,
      rows[0]
    );

    const highest = rows.reduce(
      (a, b) => b.high > a.high ? b : a,
      rows[0]
    );


    /* =========================
       3 — جلب أحداث التقسيم
       من Yahoo داخل السيرفر
    ========================= */

    let yahooSplits = {};

    try {

      const yahooUrl =
        "https://query1.finance.yahoo.com/v8/finance/chart/" +
        encodeURIComponent(symbol) +
        "?range=1y&interval=1d&events=splits";

      const yahooResponse = await fetch(yahooUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0"
        }
      });

      const yahooData = await yahooResponse.json();

      const result =
        yahooData?.chart?.result?.[0];

      yahooSplits =
        result?.events?.splits || {};

    } catch (error) {

      yahooSplits = {};

    }


    /* =========================
       4 — تحويل التقسيمات
    ========================= */

    const splitList = Object.values(yahooSplits)
      .map(x => {

        const timestamp =
          Number(x.date);

        if (!timestamp) {
          return null;
        }

        const d =
          new Date(timestamp * 1000);

        const year =
          d.getUTCFullYear();

        const month =
          String(d.getUTCMonth() + 1)
            .padStart(2, "0");

        const day =
          String(d.getUTCDate())
            .padStart(2, "0");

        return {

          date:
            `${year}-${month}-${day}`,

          numerator:
            x.numerator ?? null,

          denominator:
            x.denominator ?? null

        };

      })
      .filter(Boolean)
      .sort((a, b) =>
        a.date.localeCompare(b.date)
      );


    /* =========================
       5 — آخر تقسيم
    ========================= */

    let lastSplit = null;

    if (splitList.length) {

      lastSplit =
        splitList[splitList.length - 1];

    }


    /* =========================
       6 — بيانات ما بعد التقسيم
    ========================= */

    let postSplitRows = rows;

    if (lastSplit) {

      postSplitRows =
        rows.filter(
          x => x.date >= lastSplit.date
        );

    }


    /* =========================
       7 — أعلى قمة بعد التقسيم
    ========================= */

    let highestAfterSplit = null;

    if (postSplitRows.length) {

      highestAfterSplit =
        postSplitRows.reduce(
          (a, b) =>
            b.high > a.high ? b : a,
          postSplitRows[0]
        );

    }


    /* =========================
       8 — أقل قاع بعد التقسيم
    ========================= */

    let lowestAfterSplit = null;

    if (postSplitRows.length) {

      lowestAfterSplit =
        postSplitRows.reduce(
          (a, b) =>
            b.low < a.low ? b : a,
          postSplitRows[0]
        );

    }


    /* =========================
       9 — عدد الأيام بعد التقسيم
    ========================= */

    let daysAfterSplit = null;

    if (lastSplit) {

      const splitDate =
        new Date(
          lastSplit.date +
          "T00:00:00"
        );

      const latestDate =
        new Date(
          latest.date +
          "T00:00:00"
        );

      daysAfterSplit =
        Math.max(
          0,
          Math.floor(
            (
              latestDate.getTime() -
              splitDate.getTime()
            ) /
            (1000 * 60 * 60 * 24)
          )
        );

    }


    /* =========================
       10 — نسبة التقسيم
    ========================= */

    let ratio = null;

    if (
      lastSplit &&
      lastSplit.numerator &&
      lastSplit.denominator
    ) {

      ratio =
        lastSplit.numerator +
        ":" +
        lastSplit.denominator;

    }


    /* =========================
       النتيجة النهائية
    ========================= */

    return send(200, {

      symbol,

      data,

      latest,

      previous,

      lowest: {
        price: lowest.low,
        date: lowest.date
      },

      highest: {
        price: highest.high,
        date: highest.date
      },

      split: lastSplit
        ? {

            date:
              lastSplit.date,

            ratio,

            numerator:
              lastSplit.numerator,

            denominator:
              lastSplit.denominator,

            daysAfter:
              daysAfterSplit,

            highestAfter:
              highestAfterSplit
                ? {
                    price:
                      highestAfterSplit.high,

                    date:
                      highestAfterSplit.date
                  }
                : null,

            lowestAfter:
              lowestAfterSplit
                ? {
                    price:
                      lowestAfterSplit.low,

                    date:
                      lowestAfterSplit.date
                  }
                : null

          }
        : null

    });

  } catch (error) {

    return send(500, {

      error:
        "حدث خطأ أثناء جلب بيانات السهم",

      details:
        error.message

    });

  }

};


/* =========================
   إرسال JSON
========================= */

function send(statusCode, body) {

  return {

    statusCode,

    headers: {

      "Access-Control-Allow-Origin": "*",

      "Access-Control-Allow-Headers":
        "Content-Type",

      "Access-Control-Allow-Methods":
        "GET, OPTIONS",

      "Content-Type":
        "application/json; charset=utf-8"

    },

    body:
      JSON.stringify(body)

  };

}
