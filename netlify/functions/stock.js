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

    /* =========================
       الأسعار اليومية
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
      .sort((a, b) => a.date.localeCompare(b.date));

    if (rows.length < 30) {
      return send(404, {
        error: "البيانات غير كافية للتحليل"
      });
    }

    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2];


    /* =========================
       أعلى وأدنى سعر
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
       التقسيمات
    ========================= */

    let splitData = null;

    try {

      const splitUrl =
        "https://www.alphavantage.co/query" +
        "?function=SPLITS" +
        "&symbol=" + encodeURIComponent(symbol) +
        "&apikey=" + encodeURIComponent(apiKey);

      const splitResponse = await fetch(splitUrl);
      splitData = await splitResponse.json();

    } catch (error) {
      splitData = null;
    }


    /* =========================
       استخراج التقسيمات
       يدعم أكثر من صيغة
    ========================= */

    function extractSplits(obj) {

      const result = [];

      if (!obj || typeof obj !== "object") {
        return result;
      }

      const possibleArrays = [];

      if (Array.isArray(obj)) {
        possibleArrays.push(obj);
      }

      if (Array.isArray(obj.data)) {
        possibleArrays.push(obj.data);
      }

      if (Array.isArray(obj.splits)) {
        possibleArrays.push(obj.splits);
      }

      for (const arr of possibleArrays) {

        for (const item of arr) {

          if (!item || typeof item !== "object") {
            continue;
          }

          const date =
            item.date ||
            item["effective_date"] ||
            item["effective date"] ||
            item["ex_date"] ||
            item["ex-date"];

          const ratio =
            item.split_factor ||
            item["split_factor"] ||
            item.split ||
            item["split ratio"] ||
            item["split_ratio"] ||
            item.ratio;

          if (date) {

            result.push({
              date: String(date),
              ratio: ratio
                ? String(ratio)
                : null
            });

          }
        }
      }

      return result;
    }


    let splits = extractSplits(splitData);


    /* =========================
       محاولة قراءة أي شكل متداخل
    ========================= */

    if (!splits.length && splitData && typeof splitData === "object") {

      function scanObject(obj) {

        if (!obj || typeof obj !== "object") {
          return;
        }

        if (Array.isArray(obj)) {

          for (const item of obj) {
            scanObject(item);
          }

          return;
        }

        const date =
          obj.date ||
          obj.effective_date ||
          obj["effective_date"] ||
          obj.ex_date ||
          obj["ex_date"];

        const ratio =
          obj.split_factor ||
          obj["split_factor"] ||
          obj.split ||
          obj.ratio;

        if (date) {

          splits.push({
            date: String(date),
            ratio: ratio
              ? String(ratio)
              : null
          });
        }

        for (const key of Object.keys(obj)) {

          if (
            typeof obj[key] === "object" &&
            obj[key] !== null
          ) {
            scanObject(obj[key]);
          }

        }
      }

      scanObject(splitData);
    }


    /* =========================
       تنظيف وترتيب التقسيمات
    ========================= */

    splits = splits
      .filter(x =>
        x.date &&
        /^\d{4}-\d{2}-\d{2}$/.test(x.date)
      )
      .sort((a, b) =>
        a.date.localeCompare(b.date)
      );


    /* إزالة التكرار */

    splits = splits.filter(
      (item, index, arr) =>
        index ===
        arr.findIndex(
          x =>
            x.date === item.date &&
            x.ratio === item.ratio
        )
    );


    /* =========================
       آخر تقسيم
    ========================= */

    let lastSplit = null;

    if (splits.length > 0) {

      lastSplit =
        splits[splits.length - 1];

    }


    /* =========================
       بيانات ما بعد التقسيم
    ========================= */

    let postSplitRows = rows;

    if (lastSplit) {

      postSplitRows = rows.filter(
        x => x.date >= lastSplit.date
      );

    }


    /* =========================
       أعلى قمة بعد التقسيم
    ========================= */

    let highestAfterSplit = null;

    if (postSplitRows.length > 0) {

      highestAfterSplit =
        postSplitRows.reduce(
          (a, b) =>
            b.high > a.high ? b : a,
          postSplitRows[0]
        );

    }


    /* =========================
       أقل قاع بعد التقسيم
    ========================= */

    let lowestAfterSplit = null;

    if (postSplitRows.length > 0) {

      lowestAfterSplit =
        postSplitRows.reduce(
          (a, b) =>
            b.low < a.low ? b : a,
          postSplitRows[0]
        );

    }


    /* =========================
       عدد الأيام بعد التقسيم
    ========================= */

    let daysAfterSplit = null;

    if (lastSplit) {

      const splitDate =
        new Date(
          lastSplit.date + "T00:00:00"
        );

      const latestDate =
        new Date(
          latest.date + "T00:00:00"
        );

      const difference =
        latestDate.getTime() -
        splitDate.getTime();

      daysAfterSplit =
        Math.max(
          0,
          Math.floor(
            difference /
            (1000 * 60 * 60 * 24)
          )
        );

    }


    /* =========================
       النتيجة
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
            date: lastSplit.date,
            ratio: lastSplit.ratio,
            daysAfter: daysAfterSplit,

            highestAfter:
              highestAfterSplit
                ? {
                    price: highestAfterSplit.high,
                    date: highestAfterSplit.date
                  }
                : null,

            lowestAfter:
              lowestAfterSplit
                ? {
                    price: lowestAfterSplit.low,
                    date: lowestAfterSplit.date
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


/* =========================
   إرسال JSON
========================= */

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
