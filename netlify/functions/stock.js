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

  try {
    const symbol = (
      event.queryStringParameters?.symbol || ""
    ).trim().toUpperCase();

    if (!symbol) {
      return response(400, {
        error: "اكتب رمز السهم"
      });
    }

    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;

    if (!apiKey) {
      return response(500, {
        error: "مفتاح Alpha Vantage غير موجود في Netlify"
      });
    }

    // =========================
    // Alpha Vantage
    // =========================

    async function alphaVantage(params) {
      const url = new URL("https://www.alphavantage.co/query");

      Object.entries({
        ...params,
        apikey: apiKey
      }).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });

      const res = await fetch(url.toString());
      const data = await res.json();

      if (!res.ok) {
        throw new Error("خطأ من Alpha Vantage");
      }

      return data;
    }

    // =========================
    // الأسعار اليومية
    // =========================

    const daily = await alphaVantage({
      function: "TIME_SERIES_DAILY",
      symbol,
      outputsize: "compact"
    });

    if (daily["Error Message"]) {
      return response(404, {
        error: `السهم ${symbol} غير موجود أو الرمز غير صحيح`
      });
    }

    if (daily["Note"] || daily["Information"]) {
      return response(429, {
        error: "تم الوصول إلى حد طلبات Alpha Vantage. حاول بعد قليل."
      });
    }

    const rawSeries = daily["Time Series (Daily)"];

    if (!rawSeries) {
      return response(502, {
        error: "لم تصل بيانات الأسعار من Alpha Vantage",
        details: daily
      });
    }

    // =========================
    // تحويل البيانات
    // =========================

    const rows = Object.entries(rawSeries)
      .map(([date, v]) => ({
        date,
        open: Number(v["1. open"]),
        high: Number(v["2. high"]),
        low: Number(v["3. low"]),
        close: Number(v["4. close"]),
        volume: Number(v["5. volume"])
      }))
      .filter(
        x =>
          Number.isFinite(x.open) &&
          Number.isFinite(x.high) &&
          Number.isFinite(x.low) &&
          Number.isFinite(x.close) &&
          Number.isFinite(x.volume)
      )
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!rows.length) {
      return response(502, {
        error: "وصلت البيانات لكن لم نستطع قراءتها"
      });
    }

    const latest = rows[rows.length - 1];
    const previous = rows.length > 1 ? rows[rows.length - 2] : latest;

    // =========================
    // EMA
    // =========================

    function emaSeries(values, period) {
      if (!values.length) return [];

      const k = 2 / (period + 1);
      const result = [];
      let ema = values[0];

      result.push(ema);

      for (let i = 1; i < values.length; i++) {
        ema = values[i] * k + ema * (1 - k);
        result.push(ema);
      }

      return result;
    }

    const closes = rows.map(x => x.close);

    const ema20Series = emaSeries(closes, 20);
    const ema30Series = emaSeries(closes, 30);
    const ema50Series = emaSeries(closes, 50);

    const ema20 = ema20Series.at(-1);
    const ema30 = ema30Series.at(-1);
    const ema50 = ema50Series.at(-1);

    // =========================
    // RSI 14
    // =========================

    function calculateRSI(values, period = 14) {
      if (values.length <= period) return null;

      let gains = 0;
      let losses = 0;

      for (let i = 1; i <= period; i++) {
        const change = values[i] - values[i - 1];

        if (change >= 0) {
          gains += change;
        } else {
          losses += Math.abs(change);
        }
      }

      let avgGain = gains / period;
      let avgLoss = losses / period;

      for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];

        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? Math.abs(change) : 0;

        avgGain =
          ((avgGain * (period - 1)) + gain) / period;

        avgLoss =
          ((avgLoss * (period - 1)) + loss) / period;
      }

      if (avgLoss === 0) return 100;

      const rs = avgGain / avgLoss;

      return 100 - (100 / (1 + rs));
    }

    const rsi14 = calculateRSI(closes, 14);

    // =========================
    // MACD
    // =========================

    const ema12Series = emaSeries(closes, 12);
    const ema26Series = emaSeries(closes, 26);

    const macdSeries = closes.map(
      (_, i) => ema12Series[i] - ema26Series[i]
    );

    const signalSeries = emaSeries(macdSeries, 9);

    const macd = macdSeries.at(-1);
    const previousMacd = macdSeries.at(-2) ?? macd;
    const macdSignal = signalSeries.at(-1);
    const macdHistogram = macd - macdSignal;

    // =========================
    // Volume / RVOL
    // =========================

    const volume20Rows = rows.slice(-21, -1);

    const averageVolume20 =
      volume20Rows.length
        ? volume20Rows.reduce((sum, x) => sum + x.volume, 0) /
          volume20Rows.length
        : latest.volume;

    const rvol =
      averageVolume20 > 0
        ? latest.volume / averageVolume20
        : null;

    // =========================
    // إيجاد القاع الحالي
    // =========================

    function findPivot(rows) {
      if (rows.length < 3) {
        return {
          price: rows[0].low,
          date: rows[0].date,
          index: 0
        };
      }

      const start = Math.max(1, rows.length - 60);

      let candidates = [];

      for (let i = start; i < rows.length - 1; i++) {
        const current = rows[i];
        const before = rows[i - 1];
        const after = rows[i + 1];

        if (
          current.low <= before.low &&
          current.low <= after.low
        ) {
          candidates.push({
            price: current.low,
            date: current.date,
            index: i
          });
        }
      }

      if (!candidates.length) {
        let min = rows[start];

        for (let i = start + 1; i < rows.length; i++) {
          if (rows[i].low < min.low) {
            min = rows[i];
          }
        }

        return {
          price: min.low,
          date: min.date,
          index: rows.indexOf(min)
        };
      }

      return candidates[candidates.length - 1];
    }

    let pivot = findPivot(rows);

    // =========================
    // ثبات القاع 4 أيام
    // إذا انكسر القاع يبدأ العد من جديد
    // =========================

    let stabilityCount = 1;
    let brokenAndRestarted = false;

    for (let i = pivot.index + 1; i < rows.length; i++) {
      const candle = rows[i];

      if (candle.low < pivot.price) {
        pivot = {
          price: candle.low,
          date: candle.date,
          index: i
        };

        stabilityCount = 1;
        brokenAndRestarted = true;
      } else {
        stabilityCount++;
      }
    }

    const requiredStabilityDays = 4;

    const stabilityComplete =
      stabilityCount >= requiredStabilityDays;

    const stabilityRemaining = Math.max(
      0,
      requiredStabilityDays - stabilityCount
    );

    // =========================
    // الارتداد من القاع
    // =========================

    const bouncePercent =
      pivot.price > 0
        ? ((latest.close - pivot.price) / pivot.price) * 100
        : null;

    // =========================
    // أعلى / أدنى 100 جلسة
    // =========================

    const lowestRow = rows.reduce(
      (min, x) => x.low < min.low ? x : min,
      rows[0]
    );

    const highestRow = rows.reduce(
      (max, x) => x.high > max.high ? x : max,
      rows[0]
    );

    // =========================
    // شروط الارتكاز
    // =========================

    const supportDistance =
      pivot.price > 0
        ? ((latest.close - pivot.price) / pivot.price) * 100
        : null;

    const conditions = {
      rsiLow:
        rsi14 !== null &&
        rsi14 >= 23 &&
        rsi14 <= 27,

      supportNear:
        supportDistance !== null &&
        supportDistance >= 0 &&
        supportDistance <= 10,

      positiveCandle:
        latest.close > latest.open,

      macdImproving:
        macd > previousMacd,

      priceAboveEMA20:
        latest.close > ema20,

      priceAboveEMA30:
        latest.close > ema30,

      priceAboveEMA50:
        latest.close > ema50,

      volumeImproving:
        rvol !== null &&
        rvol >= 1.2,

      stabilityFourDays:
        stabilityComplete
    };

    const pivotScore =
      Object.values(conditions)
        .filter(Boolean)
        .length;

    const pivotTotal =
      Object.keys(conditions).length;

    // =========================
    // التقسيمات
    // =========================

    let splitInfo = {
      found: false,
      date: null,
      ratio: null,
      daysSince: null
    };

    try {
      const splitsResponse = await alphaVantage({
        function: "SPLITS",
        symbol
      });

      let splitArray = [];

      if (Array.isArray(splitsResponse.data)) {
        splitArray = splitsResponse.data;
      } else if (Array.isArray(splitsResponse.splits)) {
        splitArray = splitsResponse.splits;
      }

      const normalizedSplits = splitArray
        .map(item => ({
          date:
            item.date ||
            item.splitDate ||
            null,

          ratio:
            item.splitCoefficient ||
            item.splitRatio ||
            item.ratio ||
            null
        }))
        .filter(x => x.date)
        .sort((a, b) =>
          b.date.localeCompare(a.date)
        );

      if (normalizedSplits.length) {
        const latestSplit = normalizedSplits[0];

        const splitDate =
          new Date(latestSplit.date);

        const today = new Date();

        const daysSince = Math.max(
          0,
          Math.floor(
            (
              Date.UTC(
                today.getFullYear(),
                today.getMonth(),
                today.getDate()
              ) -
              Date.UTC(
                splitDate.getUTCFullYear(),
                splitDate.getUTCMonth(),
                splitDate.getUTCDate()
              )
            ) / 86400000
          )
        );

        splitInfo = {
          found: true,
          date: latestSplit.date,
          ratio: latestSplit.ratio,
          daysSince
        };
      }
    } catch (splitError) {
      // إذا لم تصل بيانات التقسيم لا نوقف بيانات السهم
      splitInfo = {
        found: false,
        date: null,
        ratio: null,
        daysSince: null
      };
    }

    // =========================
    // النتيجة
    // =========================

    return response(200, {
      symbol,

      source: "Alpha Vantage",

      latest: {
        date: latest.date,
        open: latest.open,
        high: latest.high,
        low: latest.low,
        close: latest.close,
        volume: latest.volume
      },

      previous: {
        date: previous.date,
        close: previous.close,
        volume: previous.volume
      },

      lowest: {
        price: lowestRow.low,
        date: lowestRow.date
      },

      highest: {
        price: highestRow.high,
        date: highestRow.date
      },

      pivot: {
        price: pivot.price,
        date: pivot.date,
        bouncePercent,
        score: pivotScore,
        total: pivotTotal,
        conditions
      },

      stability: {
        pivotLow: pivot.price,
        pivotDate: pivot.date,
        count: stabilityCount,
        required: requiredStabilityDays,
        remaining: stabilityRemaining,
        complete: stabilityComplete,
        brokenAndRestarted
      },

      indicators: {
        ema20,
        ema30,
        ema50,

        rsi14,

        macd,
        macdSignal,
        macdHistogram,

        volume: latest.volume,
        averageVolume20,
        rvol
      },

      split: splitInfo,

      // الأخبار سنربطها لاحقاً
      news: {
        items: [],
        status: "لم يتم ربط الأخبار بعد"
      },

      // آخر البيانات للرسوم والتحليل مستقبلاً
      series: rows
    });

  } catch (error) {
    return response(500, {
      error: "حدث خطأ أثناء جلب بيانات السهم",
      details: error.message
    });
  }
};


// =========================
// Response helper
// =========================

function response(statusCode, body) {
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
