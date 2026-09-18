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

    // =====================================
    // الأسعار اليومية
    // =====================================

    const daily = await av({
      function: "TIME_SERIES_DAILY",
      symbol,
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
          "تم الوصول إلى حد Alpha Vantage. حاول بعد قليل."
      });
    }

    const raw = daily["Time Series (Daily)"];

    if (!raw) {
      return send(502, {
        error: "لم تصل بيانات الأسعار",
        details: daily
      });
    }

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

    if (rows.length < 30) {
      return send(502, {
        error: "بيانات تاريخية غير كافية للسهم"
      });
    }

    const latest = rows[rows.length - 1];
    const previous = rows[rows.length - 2];

    const closes = rows.map(x => x.close);

    // =====================================
    // EMA
    // =====================================

    function emaSeries(values, period) {
      const result = [];
      if (!values.length) return result;

      const k = 2 / (period + 1);
      let value = values[0];

      result.push(value);

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

    const EMA20 = ema20.at(-1);
    const EMA30 = ema30.at(-1);
    const EMA50 = ema50.at(-1);

    // =====================================
    // RSI 14
    // =====================================

    function calculateRSI(values, period = 14) {
      if (values.length <= period) return null;

      let gains = 0;
      let losses = 0;

      for (let i = 1; i <= period; i++) {
        const change =
          values[i] - values[i - 1];

        if (change >= 0) {
          gains += change;
        } else {
          losses += Math.abs(change);
        }
      }

      let avgGain = gains / period;
      let avgLoss = losses / period;

      for (
        let i = period + 1;
        i < values.length;
        i++
      ) {
        const change =
          values[i] - values[i - 1];

        const gain =
          change > 0 ? change : 0;

        const loss =
          change < 0 ? Math.abs(change) : 0;

        avgGain =
          ((avgGain * (period - 1)) + gain) /
          period;

        avgLoss =
          ((avgLoss * (period - 1)) + loss) /
          period;
      }

      if (avgLoss === 0) return 100;

      const rs = avgGain / avgLoss;

      return 100 - (100 / (1 + rs));
    }

    const rsi14 =
      calculateRSI(closes, 14);

    // =====================================
    // MACD
    // =====================================

    const macdSeries = closes.map(
      (_, i) =>
        ema12[i] - ema26[i]
    );

    const signalSeries =
      emaSeries(macdSeries, 9);

    const macd = macdSeries.at(-1);
    const previousMacd =
      macdSeries.at(-2) ?? macd;

    const macdSignal =
      signalSeries.at(-1);

    const macdHistogram =
      macd - macdSignal;

    // =====================================
    // Volume / RVOL
    // =====================================

    const previous20 =
      rows.slice(-21, -1);

    const averageVolume20 =
      previous20.length
        ? previous20.reduce(
            (sum, x) => sum + x.volume,
            0
          ) / previous20.length
        : latest.volume;

    const rvol =
      averageVolume20 > 0
        ? latest.volume / averageVolume20
        : 0;

    // =====================================
    // البحث عن آخر قاع ارتكاز
    // =====================================

    function findLastPivotLow(data) {
      const start =
        Math.max(1, data.length - 60);

      let candidate = null;

      for (
        let i = start;
        i < data.length - 1;
        i++
      ) {
        const left = data[i - 1].low;
        const current = data[i].low;
        const right = data[i + 1].low;

        if (
          current <= left &&
          current <= right
        ) {
          candidate = {
            price: current,
            date: data[i].date,
            index: i
          };
        }
      }

      if (candidate) {
        return candidate;
      }

      // إذا لم توجد قمة/قاع محلي واضح
      let minIndex = start;

      for (
        let i = start + 1;
        i < data.length;
        i++
      ) {
        if (
          data[i].low <
          data[minIndex].low
        ) {
          minIndex = i;
        }
      }

      return {
        price: data[minIndex].low,
        date: data[minIndex].date,
        index: minIndex
      };
    }

    let pivot =
      findLastPivotLow(rows);

    // =====================================
    // ثبات الارتكاز
    //
    // يوم القاع = بداية الارتكاز
    // الأيام التي بعده ولا تكسر Low = ثبات
    // كسر Low = قاع جديد وإعادة العد
    // المطلوب = 4 أيام
    // =====================================

    let stabilityDays = 0;
    let restarted = false;

    for (
      let i = pivot.index + 1;
      i < rows.length;
      i++
    ) {
      const candle = rows[i];

      // كسر القاع الحقيقي باستخدام Low
      if (candle.low < pivot.price) {

        pivot = {
          price: candle.low,
          date: candle.date,
          index: i
        };

        stabilityDays = 0;
        restarted = true;

      } else {

        stabilityDays++;
      }
    }

    const requiredStabilityDays = 4;

    const complete =
      stabilityDays >=
      requiredStabilityDays;

    const remaining =
      Math.max(
        0,
        requiredStabilityDays -
        stabilityDays
      );

    // =====================================
    // الارتداد من آخر قاع
    // =====================================

    const bouncePercent =
      pivot.price > 0
        ? (
            (latest.close - pivot.price) /
            pivot.price
          ) * 100
        : 0;

    // =====================================
    // أعلى وأدنى سعر في آخر 100 جلسة
    // =====================================

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

    // =====================================
    // شروط منهج الارتكاز
    // =====================================

    const distanceFromPivot =
      pivot.price > 0
        ? (
            (latest.close - pivot.price) /
            pivot.price
          ) * 100
        : 0;

    const conditions = {

      // RSI قريب من منطقة 23 - 27
      rsiLow:
        rsi14 !== null &&
        rsi14 >= 23 &&
        rsi14 <= 27,

      // السعر قريب من الدعم
      supportNear:
        distanceFromPivot >= 0 &&
        distanceFromPivot <= 10,

      // شمعة إيجابية
      positiveCandle:
        latest.close > latest.open,

      // MACD يتحسن
      macdImproving:
        macd > previousMacd,

      // السعر فوق EMA20
      aboveEMA20:
        latest.close > EMA20,

      // السعر فوق EMA30
      aboveEMA30:
        latest.close > EMA30,

      // السعر فوق EMA50
      aboveEMA50:
        latest.close > EMA50,

      // تحسن الفوليوم
      volumeImproving:
        rvol >= 1.2,

      // اكتمال الثبات
      stabilityFourDays:
        complete
    };

    const pivotScore =
      Object.values(conditions)
        .filter(Boolean)
        .length;

    const pivotTotal =
      Object.keys(conditions).length;

    // =====================================
    // التقسيمات
    // =====================================

    let split = {
      found: false,
      date: null,
      ratio: null,
      daysSince: null
    };

    try {

      const splitResponse =
        await av({
          function: "SPLITS",
          symbol
        });

      let splitList = [];

      if (
        Array.isArray(
          splitResponse.data
        )
      ) {
        splitList =
          splitResponse.data;
      }

      if (
        Array.isArray(
          splitResponse.splits
        )
      ) {
        splitList =
          splitResponse.splits;
      }

      const normalized =
        splitList
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

        const s =
          normalized[0];

        const splitDate =
          new Date(s.date);

        const now =
          new Date();

        const todayUTC =
          Date.UTC(
            now.getUTCFullYear(),
            now.getUTCMonth(),
            now.getUTCDate()
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
      // عدم وجود بيانات التقسيم
      // لا يمنع ظهور بيانات السهم
    }

    // =====================================
    // النتيجة
    // =====================================

    return send(200, {

      // مهم للواجهة الحالية
      data: daily,

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
          Number(
            bouncePercent.toFixed(2)
          ),

        score: pivotScore,
        total: pivotTotal,

        conditions
      },

      // الثبات الصحيح: 4 أيام
      stability: {
        pivotLow: pivot.price,
        pivotDate: pivot.date,

        count:
          Math.min(
            stabilityDays,
            requiredStabilityDays
          ),

        actualCount:
          stabilityDays,

        required:
          requiredStabilityDays,

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

        macdHistogram,

        volume:
          latest.volume,

        averageVolume20,

        rvol
      },

      split,

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


// =====================================
// إرسال JSON
// =====================================

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
