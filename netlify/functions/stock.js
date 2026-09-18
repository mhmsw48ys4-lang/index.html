<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>مراقب استراتيجية الارتكاز</title>

<style>
*{
  box-sizing:border-box;
  -webkit-tap-highlight-color:transparent;
}

body{
  margin:0;
  background:#eef2f3;
  color:#182126;
  font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Tahoma,Arial,sans-serif;
}

.header{
  background:#0c1418;
  color:white;
  padding:34px 20px 38px;
  border-radius:0 0 45px 45px;
  text-align:center;
}

.header h1{
  margin:0;
  font-size:30px;
  font-weight:800;
}

.header p{
  margin:8px 0 0;
  color:#aeb8bc;
  font-size:17px;
}

.container{
  max-width:850px;
  margin:auto;
  padding:22px 16px 50px;
}

.search{
  background:white;
  padding:15px;
  border-radius:24px;
  display:flex;
  gap:10px;
  margin-bottom:20px;
  box-shadow:0 4px 20px rgba(0,0,0,.05);
}

.search input{
  flex:1;
  min-width:0;
  border:1px solid #d4dadd;
  border-radius:18px;
  padding:15px;
  font-size:18px;
  text-align:right;
  outline:none;
}

.search button{
  border:0;
  background:#078b69;
  color:white;
  border-radius:18px;
  padding:0 22px;
  font-size:18px;
  font-weight:700;
}

.loading{
  display:none;
  background:white;
  border-radius:22px;
  padding:20px;
  text-align:center;
  margin-bottom:18px;
}

.empty{
  background:white;
  border-radius:24px;
  padding:45px 20px;
  text-align:center;
  color:#737d81;
}

.card{
  background:white;
  border-radius:30px;
  overflow:hidden;
  margin-bottom:25px;
  box-shadow:0 5px 25px rgba(0,0,0,.06);
}

.cardHead{
  padding:25px;
  border-bottom:1px solid #e5e9ea;
}

.symbol{
  font-size:18px;
  color:#6c767a;
}

.price{
  font-size:38px;
  font-weight:850;
  margin-top:8px;
}

.badge{
  display:inline-block;
  margin-top:10px;
  padding:8px 15px;
  border-radius:20px;
  background:#e5f7f1;
  color:#078b69;
  font-weight:700;
}

.grid{
  display:grid;
  grid-template-columns:1fr 1fr;
  gap:12px;
  padding:20px;
}

.box{
  background:#f3f6f7;
  border-radius:22px;
  padding:18px;
  min-height:105px;
}

.label{
  color:#788286;
  font-size:15px;
  margin-bottom:9px;
}

.value{
  font-size:25px;
  font-weight:800;
  direction:ltr;
  text-align:right;
}

.green{
  color:#078b69;
}

.red{
  color:#dc4141;
}

.stability{
  margin:0 20px 20px;
  background:#e8f8f3;
  border-radius:23px;
  padding:20px;
}

.stabilityTitle{
  font-size:21px;
  font-weight:800;
  margin-bottom:12px;
}

.progress{
  height:12px;
  background:#d3e8e2;
  border-radius:20px;
  overflow:hidden;
}

.progressBar{
  height:100%;
  width:0%;
  background:#078b69;
  border-radius:20px;
  transition:.4s;
}

.conditions{
  border-top:1px solid #e5e9ea;
  padding:20px;
}

.conditions h2{
  margin:0 0 15px;
  font-size:21px;
}

.condition{
  display:flex;
  justify-content:space-between;
  align-items:center;
  padding:13px 4px;
  border-bottom:1px solid #edf0f1;
}

.ok{
  color:#078b69;
  font-weight:800;
}

.no{
  color:#dc4141;
  font-weight:800;
}

.split{
  margin:0 20px 20px;
  padding:18px;
  border-radius:22px;
  background:#f3f6f7;
}

.splitTitle{
  font-weight:800;
  font-size:19px;
  margin-bottom:10px;
}

.note{
  color:#7a8589;
  font-size:13px;
  line-height:1.7;
  padding:0 20px 25px;
}

@media(max-width:500px){
  .header h1{font-size:27px}
  .grid{gap:10px;padding:15px}
  .box{padding:15px}
  .value{font-size:22px}
  .search button{padding:0 16px}
}
</style>
</head>

<body>

<header class="header">
  <h1>مراقب استراتيجية الارتكاز</h1>
  <p>Pivot • Support • Momentum • Stability</p>
</header>

<main class="container">

  <div class="search">
    <input
      id="ticker"
      type="text"
      placeholder="اكتب رمز السهم مثل NTCL"
      autocomplete="off"
      autocapitalize="characters"
    >
    <button onclick="addStock()">إضافة</button>
  </div>

  <div id="loading" class="loading">
    جارٍ جلب بيانات السهم...
  </div>

  <div id="stocks">
    <div class="empty">
      اكتب رمز السهم لإضافته إلى المراقبة
    </div>
  </div>

</main>

<script>

const stocks = {};

async function addStock(){

  const input =
    document.getElementById("ticker");

  const symbol =
    input.value.trim().toUpperCase();

  if(!symbol){
    alert("اكتب رمز السهم أولاً");
    return;
  }

  const loading =
    document.getElementById("loading");

  loading.style.display = "block";

  try{

    const response = await fetch(
      "/.netlify/functions/stock?symbol=" +
      encodeURIComponent(symbol)
    );

    const result =
      await response.json();

    if(!response.ok){

      throw new Error(
        result.error ||
        "تعذر جلب بيانات السهم"
      );
    }

    if(
      !result.data ||
      !result.data["Time Series (Daily)"]
    ){

      throw new Error(
        "لم تصل بيانات الأسعار"
      );
    }

    stocks[symbol] = result;

    renderStocks();

    input.value = "";

  }catch(error){

    alert(
      "تعذر جلب بيانات " +
      symbol +
      "\n\n" +
      error.message
    );

  }finally{

    loading.style.display = "none";
  }
}


function money(value){

  if(
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ){
    return "—";
  }

  return "$" +
    Number(value).toFixed(
      Number(value) < 10 ? 3 : 2
    );
}


function number(value, decimals=2){

  if(
    value === null ||
    value === undefined ||
    !Number.isFinite(Number(value))
  ){
    return "—";
  }

  return Number(value).toFixed(decimals);
}


function volume(value){

  if(
    value === null ||
    value === undefined
  ){
    return "—";
  }

  value = Number(value);

  if(value >= 1000000)
    return (value/1000000).toFixed(2)+"M";

  if(value >= 1000)
    return (value/1000).toFixed(0)+"K";

  return value.toString();
}


function conditionRow(name, ok){

  return `
    <div class="condition">
      <span>${name}</span>
      <span class="${ok ? "ok" : "no"}">
        ${ok ? "✓" : "×"}
      </span>
    </div>
  `;
}


function renderStocks(){

  const container =
    document.getElementById("stocks");

  const symbols =
    Object.keys(stocks);

  if(!symbols.length){

    container.innerHTML = `
      <div class="empty">
        اكتب رمز السهم لإضافته إلى المراقبة
      </div>
    `;

    return;
  }

  container.innerHTML =
    symbols.map(symbol =>
      renderCard(
        symbol,
        stocks[symbol]
      )
    ).join("");
}


function renderCard(symbol, result){

  const latest =
    result.latest || {};

  const pivot =
    result.pivot || {};

  const stability =
    result.stability || {};

  const indicators =
    result.indicators || {};

  const split =
    result.split || {};

  const conditions =
    pivot.conditions || {};

  const count =
    Number(stability.count || 0);

  const required = 4;

  const progress =
    Math.min(
      100,
      (count / required) * 100
    );

  const complete =
    stability.complete ||
    count >= required;

  const macdValue =
    indicators.macd;

  const macdText =
    macdValue === null ||
    macdValue === undefined
      ? "—"
      : Number(macdValue) >= 0
        ? "إيجابي"
        : "سلبي";

  const macdClass =
    Number(macdValue) >= 0
      ? "green"
      : "red";

  let splitText = "—";

  if(split.found){

    splitText =
      (split.ratio || "تقسيم") +
      " — منذ " +
      (split.daysSince ?? "—") +
      " يوم";
  }

  return `

  <article class="card">

    <div class="cardHead">

      <div class="symbol">
        ${symbol}
      </div>

      <div class="price">
        ${money(latest.close)}
      </div>

      <div class="badge">
        مراقبة
      </div>

    </div>


    <div class="grid">

      <div class="box">
        <div class="label">
          آخر قمة
        </div>
        <div class="value">
          ${money(result.highest?.price)}
        </div>
      </div>


      <div class="box">
        <div class="label">
          آخر قاع / Pivot
        </div>
        <div class="value">
          ${money(pivot.price)}
        </div>
      </div>


      <div class="box">
        <div class="label">
          الارتداد من القاع
        </div>
        <div class="value green">
          ${number(pivot.bouncePercent)}%
        </div>
      </div>


      <div class="box">
        <div class="label">
          RSI 14
        </div>
        <div class="value">
          ${number(indicators.rsi14)}
        </div>
      </div>


      <div class="box">
        <div class="label">
          سعر الافتتاح
        </div>
        <div class="value">
          ${money(latest.open)}
        </div>
      </div>


      <div class="box">
        <div class="label">
          آخر إغلاق
        </div>
        <div class="value">
          ${money(latest.close)}
        </div>
      </div>


      <div class="box">
        <div class="label">
          أدنى قاع
        </div>
        <div class="value">
          ${money(result.lowest?.price)}
        </div>
      </div>


      <div class="box">
        <div class="label">
          Volume
        </div>
        <div class="value">
          ${volume(indicators.volume)}
        </div>
      </div>


      <div class="box">
        <div class="label">
          RVOL
        </div>
        <div class="value">
          ${
            indicators.rvol
              ? number(indicators.rvol,2)+"x"
              : "—"
          }
        </div>
      </div>


      <div class="box">
        <div class="label">
          MACD
        </div>
        <div class="value ${macdClass}">
          ${macdText}
        </div>
      </div>


      <div class="box">
        <div class="label">
          EMA 20
        </div>
        <div class="value">
          ${money(indicators.ema20)}
        </div>
      </div>


      <div class="box">
        <div class="label">
          EMA 30
        </div>
        <div class="value">
          ${money(indicators.ema30)}
        </div>
      </div>


      <div class="box">
        <div class="label">
          EMA 50
        </div>
        <div class="value">
          ${money(indicators.ema50)}
        </div>
      </div>


      <div class="box">
        <div class="label">
          تاريخ التقسيم
        </div>
        <div class="value">
          ${split.date || "—"}
        </div>
      </div>

    </div>


    <div class="split">

      <div class="splitTitle">
        التقسيم
      </div>

      <div>
        ${splitText}
      </div>

    </div>


    <div class="stability">

      <div class="stabilityTitle">

        ثبات الارتكاز:
        ${count} / ${required}

        ${
          complete
            ? " — مكتمل ✓"
            : " — باقي " +
              Math.max(
                0,
                required-count
              ) +
              " أيام"
        }

      </div>

      <div class="progress">

        <div
          class="progressBar"
          style="width:${progress}%"
        ></div>

      </div>

      <div style="
        margin-top:12px;
        color:#647276;
        font-size:14px;
      ">

        القاع:
        ${money(stability.pivotLow || pivot.price)}

        &nbsp; • &nbsp;

        تاريخ القاع:
        ${stability.pivotDate || pivot.date || "—"}

      </div>

    </div>


    <div class="conditions">

      <h2>
        شروط متابعة الارتكاز
      </h2>

      ${conditionRow(
        "RSI قريب من 23–27",
        conditions.rsiLow
      )}

      ${conditionRow(
        "الدعم قريب",
        conditions.supportNear
      )}

      ${conditionRow(
        "شمعة إيجابية",
        conditions.positiveCandle
      )}

      ${conditionRow(
        "MACD يتحسن",
        conditions.macdImproving
      )}

      ${conditionRow(
        "السعر فوق EMA20",
        conditions.aboveEMA20
      )}

      ${conditionRow(
        "السعر فوق EMA30",
        conditions.aboveEMA30
      )}

      ${conditionRow(
        "السعر فوق EMA50",
        conditions.aboveEMA50
      )}

      ${conditionRow(
        "الفوليوم يتحسن",
        conditions.volumeImproving
      )}

      ${conditionRow(
        "ثبات القاع 4 أيام",
        conditions.stabilityFourDays
      )}

    </div>


    <div class="note">

      قاعدة الثبات:
      يوم القاع هو نقطة البداية،
      وكل جلسة لا تكسر القاع تُحسب يوم ثبات.
      إذا نزل Low تحت القاع يبدأ العد من القاع الجديد.

      <br><br>

      البيانات مأخوذة من مصدر الأسعار المرتبط بالموقع.

    </div>

  </article>

  `;
}


document
  .getElementById("ticker")
  .addEventListener(
    "keydown",
    function(e){

      if(e.key === "Enter"){
        addStock();
      }

    }
  );

</script>

</body>
</html>
