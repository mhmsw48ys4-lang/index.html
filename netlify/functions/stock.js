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
    return send(400, { error: "اكتب رمز السهم" });
  }

  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;

  if (!apiKey) {
    return send(500, {
      error: "مفتاح Alpha Vantage غير موجود في Netlify"
    });
  }

  try {

    // =========================
    // الأسعار اليومية
    // =========================

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
      .sort((a, b) => a.date.localeCompare(b.date));

    if (rows.length < 30) {
      return send(404, {
        error: "البيانات غير كافية للتحليل"
      });
    }

    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2];

    // =========================
    // أعلى وأدنى سعر
    // =========================

    const lowest = rows.reduce(
      (a, b) => b.low < a.low ? b : a,
      rows[0]
    );

    const highest = rows.reduce(
      (a, b) => b.high > a.high ? b : a,
      rows[0]
    );

    // =========================
    // جلب التقسيمات
    // =========================

    let splits = [];

    try {

      const splitUrl =
        "https://www.alphavantage.co/query" +
        "?function=SPLITS" +
        "&symbol=" + encodeURIComponent(symbol) +
        "&apikey=" + encodeURIComponent(apiKey);

      const splitResponse = await fetch(splitUrl);
      const splitData = await splitResponse.json();

      if (Array.isArray(splitData)) {
        splits = splitData;
      } else if (Array.isArray(splitData.data)) {
        splits = splitData.data;
      }

    } catch (error) {
      splits = [];
    }

    // =========================
    // ترتيب التقسيمات
    // =========================

    const normalizedSplits = splits
      .map(x => {

        const date =
          x.date ||
          x["date"] ||
          x["ex-date"] ||
          x["ex_date"];

        const ratio =
          x.split ||
          x["split"] ||
          x["split ratio"] ||
          x["split_ratio"];

        return {
          date,
          ratio
        };

      })
      .filter(x => x.date)
      .sort((a, b) => a.date.localeCompare(b.date));

    // =========================
    // آخر تقسيم
    // =========================

    let lastSplit = null;

    if (normalizedSplits.length > 0) {
      lastSplit =
        normalizedSplits[
          normalizedSplits.length - 1
        ];
    }

    // =========================
    // أعلى قمة بعد التقسيم
    // =========================

    let highestAfterSplit = null;

    if (lastSplit) {

      const afterSplitRows = rows.filter(
        x => x.date >= lastSplit.date
      );

      if (afterSplitRows.length > 0) {

        highestAfterSplit =
          afterSplitRows.reduce(
            (a, b) =>
              b.high > a.high ? b : a,
            afterSplitRows[0]
          );

      }
    }

    // =========================
    // كم يوم بعد التقسيم
    // =========================

    let daysAfterSplit = null;

    if (lastSplit) {

      const splitDate =
        new Date(lastSplit.date + "T00:00:00");

      const latestDate =
        new Date(latest.date + "T00:00:00");

      const milliseconds =
        latestDate.getTime() -
        splitDate.getTime();

      daysAfterSplit =
        Math.max(
          0,
          Math.floor(
            milliseconds /
            (1000 * 60 * 60 * 24)
          )
        );
    }

    // =========================
    // إرسال النتيجة
    // =========================

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
            date: lastSplit.date,
            ratio: lastSplit.ratio || null,
            daysAfter: daysAfterSplit,

            highestAfter:
              highestAfterSplit
                ? {
                    price: highestAfterSplit.high,
                    date: highestAfterSplit.date
                  }
                : null
          }
        : null

    });

  } catch (error) {

    return send(500, {
      error: "حدث خطأ أثناء جلب بيانات السهم",
      details: error.message
    });

  }
};


// =========================
// إرسال JSON
// =========================

function send(statusCode, body) {

  return {
    statusCode,

    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Content-Type": "application/json; charset=utf-8"
    },

    body: JSON.stringify(body)
  };
}
