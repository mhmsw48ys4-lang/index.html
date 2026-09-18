exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Content-Type": "application/json"
  };

  try {
    if (event.httpMethod === "OPTIONS") {
      return {
        statusCode: 204,
        headers,
        body: ""
      };
    }

    const symbol = event.queryStringParameters?.symbol
      ?.trim()
      .toUpperCase();

    if (!symbol) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({
          error: "رمز السهم مطلوب"
        })
      };
    }

    const apiKey = process.env.ALPHA_VANTAGE_API_KEY;

    if (!apiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({
          error: "مفتاح Alpha Vantage غير موجود في Netlify"
        })
      };
    }

    const url =
      "https://www.alphavantage.co/query" +
      "?function=TIME_SERIES_DAILY_ADJUSTED" +
      "&symbol=" + encodeURIComponent(symbol) +
      "&outputsize=full" +
      "&apikey=" + encodeURIComponent(apiKey);

    const response = await fetch(url);

    if (!response.ok) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "تعذر الاتصال بمصدر البيانات",
          status: response.status
        })
      };
    }

    const data = await response.json();

    if (data["Error Message"]) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: "السهم غير موجود",
          symbol
        })
      };
    }

    if (data["Note"]) {
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({
          error: "تم تجاوز حد طلبات Alpha Vantage",
          message: data["Note"]
        })
      };
    }

    const series = data["Time Series (Daily)"];

    if (!series) {
      return {
        statusCode: 502,
        headers,
        body: JSON.stringify({
          error: "لم تصل بيانات الأسعار",
          symbol,
          data
        })
      };
    }

    // تحويل البيانات إلى مصفوفة مرتبة من الأقدم إلى الأحدث
    const rows = Object.entries(series)
      .map(([date, v]) => ({
        date,
        open: Number(v["1. open"]),
        high: Number(v["2. high"]),
        low: Number(v["3. low"]),
        close: Number(v["4. close"]),
        adjustedClose: Number(v["5. adjusted close"]),
        volume: Number(v["6. volume"]),
        dividend: Number(v["7. dividend amount"]),
        splitCoefficient: Number(v["8. split coefficient"])
      }))
      .sort((a, b) => a.date.localeCompare(b.date));

    if (!rows.length) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({
          error: "لا توجد بيانات للسهم",
          symbol
        })
      };
    }

    // --------------------------------------------------
    // آخر جلسة
    // --------------------------------------------------

    const latest = rows[rows.length - 1];

    // --------------------------------------------------
    // آخر تقسيم
    // split coefficient != 1 يعني وجود حركة تقسيم
    // --------------------------------------------------

    let splitIndex = -1;

    for (let i = rows.length - 1; i >= 0; i--) {
      if (
        Number.isFinite(rows[i].splitCoefficient) &&
        rows[i].splitCoefficient !== 1
      ) {
        splitIndex = i;
        break;
      }
    }

    let splitDate = null;
    let daysAfterSplit = null;
    let postSplitRows = rows;

    if (splitIndex >= 0) {
      splitDate = rows[splitIndex].date;
      postSplitRows = rows.slice(splitIndex);
      daysAfterSplit = postSplitRows.length - 1;
    }

    // --------------------------------------------------
    // بيانات ما بعد التقسيم
    // --------------------------------------------------

    const postSplitLowRow = postSplitRows.reduce(
      (lowest, row) =>
        row.low < lowest.low ? row : lowest,
      postSplitRows[0]
    );

    const postSplitHighRow = postSplitRows.reduce(
      (highest, row) =>
        row.high > highest.high ? row : highest,
      postSplitRows[0]
    );

    const lowestLow = postSplitLowRow.low;
    const lowestLowDate = postSplitLowRow.date;

    const highestHigh = postSplitHighRow.high;
    const highestHighDate = postSplitHighRow.date;

    // --------------------------------------------------
    // نسبة الارتداد من أدنى قاع
    // --------------------------------------------------

    const bouncePercent =
      lowestLow > 0
        ? ((latest.close - lowestLow) / lowestLow) * 100
        : null;

    // --------------------------------------------------
    // متوسط حجم التداول
    // --------------------------------------------------

    function averageVolume(arr, count) {
      const part = arr.slice(-count);

      if (!part.length) return 0;

      return (
        part.reduce((sum, row) => sum + row.volume, 0) /
        part.length
      );
    }

    const average20Volume = averageVolume(rows, 20);

    const rvol =
      average20Volume > 0
        ? latest.volume / average20Volume
        : null;

    // --------------------------------------------------
    // EMA
    // --------------------------------------------------

    function calculateEMA(values, period) {
      if (!values.length) return null;

      const multiplier = 2 / (period + 1);

      let ema = values[0];

      for (let i = 1; i < values.length; i++) {
        ema =
          (values[i] - ema) * multiplier +
          ema;
      }

      return ema;
    }

    const closes = rows.map(r => r.close);

    const ema20 = calculateEMA(closes, 20);
    const ema30 = calculateEMA(closes, 30);
    const ema50 = calculateEMA(closes, 50);

    // --------------------------------------------------
    // RSI 14
    // --------------------------------------------------

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

      let averageGain = gains / period;
      let averageLoss = losses / period;

      for (let i = period + 1; i < values.length; i++) {
        const change = values[i] - values[i - 1];

        const gain = change > 0 ? change : 0;
        const loss = change < 0 ? Math.abs(change) : 0;

        averageGain =
          ((averageGain * (period - 1)) + gain) /
          period;

        averageLoss =
          ((averageLoss * (period - 1)) + loss) /
          period;
      }

      if (averageLoss === 0) return 100;

      const rs = averageGain / averageLoss;

      return 100 - (100 / (1 + rs));
    }

    const rsi14 = calculateRSI(closes, 14);

    // --------------------------------------------------
    // MACD
    // EMA12 - EMA26
    // --------------------------------------------------

    const ema12 = calculateEMA(closes, 12);
    const ema26 = calculateEMA(closes, 26);

    const macd =
      ema12 !== null && ema26 !== null
        ? ema12 - ema26
        : null;

    // MACD قبل آخر جلسة للمقارنة
    const previousCloses = closes.slice(0, -1);

    const previousEMA12 =
      calculateEMA(previousCloses, 12);

    const previousEMA26 =
      calculateEMA(previousCloses, 26);

    const previousMacd =
      previousEMA12 !== null &&
      previousEMA26 !== null
        ? previousEMA12 - previousEMA26
        : null;

    const macdImproving =
      macd !== null &&
      previousMacd !== null &&
      macd > previousMacd;

    // --------------------------------------------------
    // الثبات 4 أيام
    //
    // نبدأ من آخر قاع منخفض.
    // كل يوم لا يكسر قاع شمعة الثبات = يوم ثابت.
    // إذا ظهر قاع أقل = يبدأ عداد جديد من ذلك القاع.
    // --------------------------------------------------

    let stabilityLow = null;
    let stabilityDate = null;
    let stabilityDays = 0;

    if (postSplitRows.length > 0) {

      let candidateIndex = postSplitRows.length - 1;

      // نرجع للخلف ونبحث عن آخر قاع مهم
      for (
        let i = postSplitRows.length - 2;
        i >= 1;
        i--
      ) {
        const prev = postSplitRows[i - 1];
        const current = postSplitRows[i];
        const next = postSplitRows[i + 1];

        if (
          current.low <= prev.low &&
          current.low <= next.low
        ) {
          candidateIndex = i;
          break;
        }
      }

      stabilityLow =
        postSplitRows[candidateIndex].low;

      stabilityDate =
        postSplitRows[candidateIndex].date;

      stabilityDays = 1;

      // نعد الأيام بعد شمعة الثبات
      for (
        let i = candidateIndex + 1;
        i < postSplitRows.length;
        i++
      ) {
        const row = postSplitRows[i];

        // كسر قاع شمعة الثبات
        if (row.low < stabilityLow) {

          // يبدأ ثبات جديد من القاع الجديد
          stabilityLow = row.low;
          stabilityDate = row.date;
          stabilityDays = 1;

        } else {

          stabilityDays++;
        }
      }
    }

    // لا نسمح للعداد أن يتجاوز 4
    const stabilityCount =
      Math.min(stabilityDays, 4);

    const stabilityComplete =
      stabilityCount >= 4;

    // --------------------------------------------------
    // هل السعر قريب من الدعم؟
    // --------------------------------------------------

    const distanceFromSupport =
      stabilityLow > 0
        ? ((latest.close - stabilityLow) /
            stabilityLow) * 100
        : null;

    // --------------------------------------------------
    // شمعة إيجابية
    // --------------------------------------------------

    const positiveCandle =
      latest.close > latest.open;

    // --------------------------------------------------
    // استرداد الدعم
    // --------------------------------------------------

    const previous =
      rows.length >= 2
        ? rows[rows.length - 2]
        : null;

    const supportRecovered =
      previous &&
      stabilityLow !== null
        ? previous.close < stabilityLow &&
          latest.close >= stabilityLow
        : false;

    // --------------------------------------------------
    // السعر بالنسبة للمتوسطات
    // --------------------------------------------------

    const aboveEMA20 =
      ema20 !== null && latest.close >= ema20;

    const aboveEMA30 =
      ema30 !== null && latest.close >= ema30;

    const aboveEMA50 =
      ema50 !== null && latest.close >= ema50;

    // --------------------------------------------------
    // نتيجة الارتكاز
    // --------------------------------------------------

    const pivotConditions = {
      rsiLow:
        rsi14 !== null &&
        rsi14 >= 23 &&
        rsi14 <= 27,

      supportNear:
        distanceFromSupport !== null &&
        distanceFromSupport >= 0 &&
        distanceFromSupport <= 10,

      supportRecovered,

      positiveCandle,

      macdImproving,

      aboveEMA20,

      aboveEMA30,

      aboveEMA50,

      volumeImproving:
        rvol !== null && rvol >= 1
    };

    const pivotScore =
      Object.values(pivotConditions)
        .filter(Boolean)
        .length;

    // --------------------------------------------------
    // النتيجة النهائية
    // --------------------------------------------------

    return {
      statusCode: 200,
      headers,

      body: JSON.stringify({

        symbol,

        source: "Alpha Vantage",

        // -----------------------------
        // التقسيم
        // -----------------------------

        split: {
          date: splitDate,
          tradingDaysAfterSplit: daysAfterSplit
        },

        // -----------------------------
        // آخر جلسة
        // -----------------------------

        latest: {
          date: latest.date,
          open: latest.open,
          close: latest.close,
          high: latest.high,
          low: latest.low,
          volume: latest.volume
        },

        // -----------------------------
        // بعد التقسيم
        // -----------------------------

        postSplit: {
          lowestLow,
          lowestLowDate,
          highestHigh,
          highestHighDate,

          bouncePercent,

          distanceToHighPercent:
            latest.close > 0
              ? ((highestHigh - latest.close) /
                  latest.close) * 100
              : null
        },

        // -----------------------------
        // المتوسطات
        // -----------------------------

        averages: {
          ema20,
          ema30,
          ema50,

          aboveEMA20,
          aboveEMA30,
          aboveEMA50
        },

        // -----------------------------
        // المؤشرات
        // -----------------------------

        indicators: {
          rsi14,
          macd,
          previousMacd,
          macdImproving
        },

        // -----------------------------
        // الفوليوم
        // -----------------------------

        volume: {
          latest: latest.volume,
          average20: average20Volume,
          rvol
        },

        // -----------------------------
        // الثبات
        // -----------------------------

        stability: {
          low: stabilityLow,
          date: stabilityDate,
          days: stabilityCount,
          required: 4,
          complete: stabilityComplete,
          brokenAndRestarted:
            stabilityCount < 4
        },

        // -----------------------------
        // الارتكاز
        // -----------------------------

        pivot: {
          score: pivotScore,
          total: Object.keys(pivotConditions).length,
          conditions: pivotConditions
        }

      })
    };

  } catch (error) {

    return {
      statusCode: 500,
      headers,

      body: JSON.stringify({
        error: "حدث خطأ في معالجة بيانات السهم",
        details: error.message
      })
    };
  }
};
