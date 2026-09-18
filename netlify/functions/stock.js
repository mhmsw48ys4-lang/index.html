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
      return send(400, { error: "اكتب رمز السهم" });
    }

    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;

    if (!apiKey) {
      return send(500, {
        error: "مفتاح Alpha Vantage غير موجود"
      });
    }

    async function av(params) {
      const url = new URL(
        "https://www.alphavantage.co/query"
      );

      Object.entries({
        ...params,
        apikey: apiKey
      }).forEach(([key, value]) => {
        url.searchParams.set(key, value);
      });

      const r = await fetch(url.toString());
      return await r.json();
    }

    // ==========================================
    // الأسعار اليومية - مجاني
    // ==========================================

    const daily = await av({
      function: "TIME_SERIES_DAILY",
      symbol: symbol,
      outputsize: "compact"
    });

    if (daily["Error Message"]) {
      return send(404, {
        error: "رمز السهم غير صحيح أو غير موجود"
      });
    }

    if (daily["Note"] || daily["Information"]) {
      return send(429, {
        error:
          "Alpha Vantage وصل إلى حد الطلبات. حاول بعد قليل."
      });
    }

    const raw = daily["Time Series (Daily)"];

    if (!raw) {
      return send(502, {
        error: "لم تصل بيانات الأسعار",
        details: daily
      });
    }

    // ==========================================
    // تحويل الأسعار
    // ==========================================

    const rows = Object.entries(raw)
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
        Number.isFinite(x.close) &&
        Number.isFinite(x.volume)
      )
      .sort((a, b) =>
        a.date.localeCompare(b.date)
      );

    if (!rows.length) {
      return send(502, {
        error: "بيانات السهم فارغة"
      });
    }

    const latest = rows[rows.length - 1];
    const previous =
      rows.length > 1
        ? rows[rows.length - 2]
        : latest;

    const closes = rows.map(x => x.close);

    // ==========================================
    // EMA
    // ==========================================

    function emaSeries(values, period) {
      if (!values.length) return [];

      const k = 2 / (period + 1);
      let value = values[0];
      const result = [value];

      for (let i = 1; i < values.length; i++) {
        value =
          values[i] * k +
          value * (1 - k);

        result.push(value);
      }

      return result;
    }

    const ema12 = emaSeries(closes, 12);
    const ema20 = emaSeries(closes, 20);
    const ema30 = emaSeries(closes, 30);
    const ema50 = emaSeries(closes, 50);
    const ema26 = emaSeries(closes, 26);

    // ==========================================
    // RSI 14
    // ==========================================

    function calculateRSI(values, period = 14) {
      if (values.length <= period) return null;

      let gain = 0;
      let loss = 0;

      for (let i = 1; i <= period; i++) {
        const change =
          values[i] - values[i - 1];

        if (change >= 0) {
          gain += change;
        } else {
          loss += Math.abs(change);
        }
      }

      let avgGain = gain / period;
      let avgLoss = loss / period;

      for (
        let i = period + 1;
        i < values.length;
        i++
      ) {
        const change =
          values[i] - values[i - 1];

        const g = change > 0 ? change : 0;
        const l =
          change < 0 ? Math.abs(change) : 0;

        avgGain =
          ((avgGain * (period - 1)) + g) /
          period;

        avgLoss =
          ((avgLoss * (period - 1)) + l) /
          period;
      }

      if (avgLoss === 0) return 100;

      const rs = avgGain / avgLoss;

      return 100 - 100 / (1 + rs);
    }

    const rsi14 =
      calculateRSI(closes, 14);

    // ==========================================
    // MACD
    // ==========================================

    const macdSeries = closes.map(
      (_, i) =>
        ema12[i] - ema26[i]
    );

    const signalSeries =
      emaSeries(macdSeries, 9);

    const macd =
      macdSeries[macdSeries.length - 1];

    const previousMacd =
      macdSeries.length > 1
        ? macdSeries[macdSeries.length - 2]
        : macd;

    const macdSignal =
      signalSeries[signalSeries.length - 1];

    const macdHistogram =
      macd - macdSignal;

    // ==========================================
    // Volume + RVOL
    // ==========================================

    const last20 =
      rows.slice(-21, -1);

    const averageVolume20 =
      last20.length
        ? last20.reduce(
            (sum, x) => sum + x.volume,
            0
          ) / last20.length
        : latest.volume;

    const rvol =
      averageVolume20 > 0
        ? latest.volume /
          averageVolume20
        : 0;

    // ==========================================
    // أعلى وأدنى سعر
    // ==========================================

    const lowest =
      rows.reduce(
        (a, b) =>
          b.low < a.low ? b : a,
        rows[0]
      );

    const highest =
      rows.reduce(
        (a, b) =>
          b.high > a.high ? b : a,
        rows[0]
      );

    // ==========================================
    // البحث عن آخر ارتكاز
    // ==========================================

    let pivot = null;

    const start =
      Math.max(1, rows.length - 60);

    for (
      let i = start;
      i < rows.length - 1;
      i++
    ) {
      if (
        rows[i].low <= rows[i - 1].low &&
        rows[i].low <= rows[i + 1].low
      ) {
        pivot = {
          price: rows[i].low,
          date: rows[i].date,
          index: i
        };
      }
    }

    if (!pivot) {
      pivot = {
        price: lowest.low,
        date: lowest.date,
        index: rows.indexOf(lowest)
      };
    }

    // ==========================================
    // ثبات القاع 4 أيام
    // إذا انكسر القاع يبدأ العد من جديد
    // ==========================================

    let stabilityCount = 1;
    let restarted = false;

    for (
      let i = pivot.index + 1;
      i < rows.length;
      i++
    ) {
      if (rows[i].low < pivot.price) {
        pivot = {
          price: rows[i].low,
          date: rows[i].date,
          index: i
        };

        stabilityCount = 1;
        restarted = true;
      } else {
        stabilityCount++;
      }
    }

    const required = 4;

    const stabilityComplete =
      stabilityCount >= required;

    const remaining =
      Math.max(
        0,
        required - stabilityCount
      );

    // ==========================================
    // نسبة الارتداد من القاع
    // ==========================================

    const bouncePercent =
      pivot.price > 0
        ? (
            (latest.close - pivot.price) /
            pivot.price
          ) * 100
        : 0;

    // ==========================================
    // شروط الارتكاز
    // ==========================================

    const distanceFromPivot =
      pivot.price > 0
        ? (
            (latest.close - pivot.price) /
            pivot.price
          ) * 100
        : 0;

    const conditions = {
      rsiLow:
        rsi14 !== null &&
        rsi14 >= 23 &&
        rsi14 <= 27,

      supportNear:
        distanceFromPivot >= 0 &&
        distanceFromPivot <= 10,

      positiveCandle:
        latest.close > latest.open,

      macdImproving:
        macd > previousMacd,

      aboveEMA20:
        latest.close > ema20[ema20.length - 1],

      aboveEMA30:
        latest.close > ema30[ema30.length - 1],

      aboveEMA50:
        latest.close > ema50[ema50.length - 1],

      volumeImproving:
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

    // ==========================================
    // التقسيمات
    // ==========================================

    let split = {
      found: false,
      date: null,
      ratio: null,
      daysSince: null
    };

    try {
      const splitData = await av({
        function: "SPLITS",
        symbol: symbol
      });

      let list = [];

      if (Array.isArray(splitData.data)) {
        list = splitData.data;
      }

      if (Array.isArray(splitData.splits)) {
        list = splitData.splits;
      }

      const normalized =
        list
          .map(x => ({
            date:
              x.date ||
              x.splitDate ||
              null,

            ratio:
              x.splitCoefficient ||
              x.splitRatio ||
              x.ratio ||
              null
          }))
          .filter(x => x.date)
          .sort((a, b) =>
            b.date.localeCompare(a.date)
          );

      if (normalized.length) {
        const s = normalized[0];

        const splitDate =
          new Date(s.date);

        const today =
          new Date();

        const todayUTC =
          Date.UTC(
            today.getUTCFullYear(),
            today.getUTCMonth(),
            today.getUTCDate()
          );

        const splitUTC =
          Date.UTC(
            splitDate.getUTCFullYear(),
            splitDate.getUTCMonth(),
            splitDate.getUTCDate()
          );

        const daysSince =
          Math.max(
            0,
            Math.floor(
              (todayUTC - splitUTC) /
              86400000
            )
          );

        split = {
          found: true,
          date: s.date,
          ratio: s.ratio,
          daysSince
        };
      }
    } catch (e) {
      split = {
        found: false,
        date: null,
        ratio: null,
        daysSince: null
      };
    }

    // ==========================================
    // النتيجة
    // ==========================================

    return send(200, {

      // مهم للواجهة الحالية
      data: daily,

      symbol: symbol,

      latest: latest,

      previous: previous,

      lowest: {
        price: lowest.low,
        date: lowest.date
      },

      highest: {
        price: highest.high,
        date: highest.date
      },

      pivot: {
        price: pivot.price,
        date: pivot.date,
        bouncePercent:
          Number(bouncePercent.toFixed(2)),
        score: pivotScore,
        total: pivotTotal,
        conditions: conditions
      },

      stability: {
        pivotLow: pivot.price,
        pivotDate: pivot.date,
        count: stabilityCount,
        required: required,
        remaining: remaining,
        complete: stabilityComplete,
        brokenAndRestarted: restarted
      },

      indicators: {
        ema20:
          ema20[ema20.length - 1],

        ema30:
          ema30[ema30.length - 1],

        ema50:
          ema50[ema50.length - 1],

        rsi14: rsi14,

        macd: macd,

        macdSignal: macdSignal,

        macdHistogram:
          macdHistogram,

        volume:
          latest.volume,

        averageVolume20:
          averageVolume20,

        rvol:
          rvol
      },

      split: split,

      news: {
        items: [],
        status:
          "الأخبار سيتم ربطها لاحقاً"
      },

      series: rows
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


// ==========================================
// إرسال النتيجة
// ==========================================

function send(statusCode, body) {
  return {
    statusCode: statusCode,

    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Headers":
        "Content-Type",
      "Access-Control-Allow-Methods":
        "GET, OPTIONS",
      "Content-Type":
        "application/json; charset=utf-8"
    },

    body: JSON.stringify(body)
  };
}
