exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers, body: "" };
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
    // جلب الأسعار اليومية
    // =========================

    const url =
      "https://www.alphavantage.co/query" +
      "?function=TIME_SERIES_DAILY" +
      "&symbol=" + encodeURIComponent(symbol) +
      "&outputsize=compact" +
      "&apikey=" + encodeURIComponent(apiKey);

    const res = await fetch(url);
    const data = await res.json();

    if (data["Error Message"]) {
      return send(404, {
        error: "رمز السهم غير صحيح أو غير موجود"
      });
    }

    if (data["Note"] || data["Information"]) {
      return send(429, {
        error:
          "تم الوصول إلى حد طلبات Alpha Vantage. حاول بعد قليل."
      });
    }

    const raw = data["Time Series (Daily)"];

    if (!raw) {
      return send(502, {
        error: "لم تصل بيانات الأسعار من Alpha Vantage",
        details: data
      });
    }

    // =========================
    // تحويل البيانات
    // =========================

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
        Number.isFinite(x.close) &&
        Number.isFinite(x.low) &&
        Number.isFinite(x.high)
      )
      .sort((a, b) =>
        a.date.localeCompare(b.date)
      );

    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2] || latest;

    const closes = rows.map(x => x.close);

    // =========================
    // EMA
    // =========================

    function ema(values, period) {
      if (!values.length) return null;

      const k = 2 / (period + 1);
      let e = values[0];

      for (let i = 1; i < values.length; i++) {
        e =
          values[i] * k +
          e * (1 - k);
      }

      return e;
    }

    const EMA20 = ema(closes, 20);
    const EMA30 = ema(closes, 30);
    const EMA50 = ema(closes, 50);

    // =========================
    // RSI 14
    // =========================

    function RSI(values, period = 14) {
      if (values.length <= period) return null;

      let gain = 0;
      let loss = 0;

      for (let i = 1; i <= period; i++) {
        const change =
          values[i] - values[i - 1];

        if (change > 0) {
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

        const g =
          change > 0 ? change : 0;

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

    const rsi14 = RSI(closes);

    // =========================
    // MACD
    // =========================

    function emaSeries(values, period) {
      if (!values.length) return [];

      const k = 2 / (period + 1);
      let e = values[0];
      const result = [e];

      for (let i = 1; i < values.length; i++) {
        e =
          values[i] * k +
          e * (1 - k);

        result.push(e);
      }

      return result;
    }

    const e12 = emaSeries(closes, 12);
    const e26 = emaSeries(closes, 26);

    const macdSeries = closes.map(
      (_, i) => e12[i] - e26[i]
    );

    const signalSeries =
      emaSeries(macdSeries, 9);

    const macd = macdSeries.at(-1);
    const previousMacd =
      macdSeries.at(-2) ?? macd;

    const macdSignal =
      signalSeries.at(-1);

    // =========================
    // Volume / RVOL
    // =========================

    const oldVolumes =
      rows.slice(-21, -1);

    const averageVolume20 =
      oldVolumes.length
        ? oldVolumes.reduce(
            (s, x) => s + x.volume,
            0
          ) / oldVolumes.length
        : latest.volume;

    const rvol =
      averageVolume20 > 0
        ? latest.volume / averageVolume20
        : 0;

    // =========================
    // أعلى قمة / أدنى قاع
    // =========================

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

    // =========================
    // آخر Pivot Low
    // =========================

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

    // =========================
    // ثبات القاع
    // المطلوب 4 أيام
    //
    // يوم القاع = البداية
    // اليوم الذي بعده = أول يوم ثبات
    // إذا Low كسر القاع = إعادة العد
    // =========================

    let stabilityDays = 0;
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

        stabilityDays = 0;
        restarted = true;

      } else {

        stabilityDays++;
      }
    }

    const required = 4;

    const complete =
      stabilityDays >= required;

    const remaining =
      Math.max(
        0,
        required - stabilityDays
      );

    // =========================
    // الارتداد
    // =========================

    const bounce =
      pivot.price > 0
        ? (
            (latest.close - pivot.price) /
            pivot.price
          ) * 100
        : 0;

    // =========================
    // شروط الارتكاز
    // =========================

    const distance =
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
        distance >= 0 &&
        distance <= 10,

      positiveCandle:
        latest.close > latest.open,

      macdImproving:
        macd > previousMacd,

      aboveEMA20:
        latest.close > EMA20,

      aboveEMA30:
        latest.close > EMA30,

      aboveEMA50:
        latest.close > EMA50,

      volumeImproving:
        rvol >= 1.2,

      stabilityFourDays:
        complete
    };

    const score =
      Object.values(conditions)
        .filter(Boolean).length;

    // =========================
    // النتيجة
    // =========================

    return send(200, {

      // مهم جدًا للواجهة الحالية
      data: data,

      symbol,

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

      pivot: {
        price: pivot.price,
        date: pivot.date,
        bouncePercent:
          Number(bounce.toFixed(2)),
        score,
        total:
          Object.keys(conditions).length,
        conditions
      },

      stability: {
        pivotLow: pivot.price,
        pivotDate: pivot.date,

        // الواجهة تعرض 4 كحد أقصى
        count:
          Math.min(
            stabilityDays,
            4
          ),

        actualCount:
          stabilityDays,

        required: 4,

        remaining,

        complete,

        brokenAndRestarted:
          restarted
      },

      indicators: {
        ema20: EMA20,
        ema30: EMA30,
        ema50: EMA50,

        rsi14,

        macd,

        macdSignal,

        macdHistogram:
          macd - macdSignal,

        volume:
          latest.volume,

        averageVolume20,

        rvol
      },

      // التقسيمات والأخبار نضيفها
      // بعد التأكد أن السعر والثبات يعملان
      split: {
        found: false,
        date: null,
        ratio: null,
        daysSince: null
      },

      news: {
        items: [],
        status:
          "سيتم ربط الأخبار لاحقًا"
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


// =========================
// JSON Response
// =========================

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
