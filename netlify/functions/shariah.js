exports.handler = async (event) => {
  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json; charset=utf-8"
  };

  if (event.httpMethod === "OPTIONS") return { statusCode: 204, headers, body: "" };

  const symbol = String(event.queryStringParameters?.symbol || "").trim().toUpperCase();
  if (!symbol) return send(400, { error: "اكتب رمز السهم" }, headers);

  try {
    const secHeaders = {
      "User-Agent": "khald-pivot-scanner contact@example.com",
      "Accept": "application/json"
    };

    const tickerMapResponse = await fetch("https://www.sec.gov/files/company_tickers.json", {
      headers: secHeaders
    });
    if (!tickerMapResponse.ok) throw new Error("تعذر جلب قائمة الشركات من SEC");
    const tickerMap = await tickerMapResponse.json();

    let company = null;
    for (const item of Object.values(tickerMap || {})) {
      if (String(item.ticker || "").toUpperCase() === symbol) {
        company = item;
        break;
      }
    }
    if (!company) return send(404, { error: "لم نجد الشركة في سجلات SEC" }, headers);

    const cik = String(company.cik_str).padStart(10, "0");

    const submissionsResponse = await fetch(
      "https://data.sec.gov/submissions/CIK" + cik + ".json",
      { headers: secHeaders }
    );
    if (!submissionsResponse.ok) throw new Error("تعذر جلب إفصاحات SEC");
    const submissions = await submissionsResponse.json();

    const recent = submissions?.filings?.recent || {};
    const forms = recent.form || [];
    const accessionNumbers = recent.accessionNumber || [];
    const primaryDocuments = recent.primaryDocument || [];
    const filingDates = recent.filingDate || [];
    const reportDates = recent.reportDate || [];

    let filingIndex = -1;
    for (let i = 0; i < forms.length; i++) {
      if (["10-Q", "10-K", "20-F", "40-F"].includes(forms[i])) {
        filingIndex = i;
        break;
      }
    }
    if (filingIndex < 0) {
      return send(200, {
        symbol,
        status: "insufficient",
        reason: "لا يوجد آخر تقرير مالي مناسب يمكن فحصه",
        source: "SEC EDGAR"
      }, headers);
    }

    const form = forms[filingIndex];
    const filingDate = filingDates[filingIndex];
    const reportDate = reportDates[filingIndex];
    const accession = accessionNumbers[filingIndex];
    const accessionNoDash = String(accession).replace(/-/g, "");
    const primaryDocument = primaryDocuments[filingIndex];

    const factsResponse = await fetch(
      "https://data.sec.gov/api/xbrl/companyfacts/CIK" + cik + ".json",
      { headers: secHeaders }
    );
    if (!factsResponse.ok) throw new Error("تعذر جلب بيانات XBRL من SEC");
    const factsJson = await factsResponse.json();

    const facts = factsJson?.facts || {};
    const usgaap = facts["us-gaap"] || {};
    const dei = facts["dei"] || {};

    const latestFact = (names, options = {}) => {
      const wanted = Array.isArray(names) ? names : [names];
      const end = options.end;
      const accessionWanted = options.accession;
      const formWanted = options.form;
      const unitWanted = options.unit || "USD";

      for (const name of wanted) {
        const fact = usgaap[name] || dei[name];
        if (!fact?.units) continue;

        const unitKeys = Object.keys(fact.units);
        const unit = fact.units[unitWanted] || fact.units[unitKeys[0]];
        if (!Array.isArray(unit)) continue;

        const candidates = unit
          .filter(x =>
            (!end || x.end === end) &&
            (!accessionWanted || String(x.accn || "") === String(accessionWanted)) &&
            (!formWanted || x.form === formWanted)
          )
          .sort((a,b) => String(b.filed || "").localeCompare(String(a.filed || "")));

        if (candidates.length) {
          const v = Number(candidates[0].val);
          if (Number.isFinite(v)) return { value: v, tag: name, filed: candidates[0].filed, form: candidates[0].form };
        }
      }
      return null;
    };

    const currentPrice = await getCurrentPrice(symbol);

    const sharesFact = latestFact(
      ["EntityCommonStockSharesOutstanding"],
      { unit: "shares" }
    );

    const shares = sharesFact?.value || null;
    const marketCap = currentPrice != null && shares != null ? currentPrice * shares : null;

    // Activity: SEC SIC is used as a first-pass classification. Prohibited activity is
    // rejected conservatively; ambiguous activities are not marked compliant.
    const sic = String(submissions.sic || "");
    const sicDescription = String(submissions.sicDescription || "");
    const companyName = String(submissions.name || company.name || "");

    const prohibitedSic = [
      /^60/, /^61/, /^62/, /^63/, /^64/, /^67/
    ];
    const activityText = (companyName + " " + sicDescription).toLowerCase();

    const prohibitedWords = [
      "bank", "banking", "insurance", "casino", "gambling",
      "tobacco", "cigarette", "cannabis", "marijuana",
      "liquor", "distillery", "brewery", "beer", "wine",
      "pork", "swine", "adult entertainment"
    ];

    const sicBlocked = prohibitedSic.some(re => re.test(sic));
    const wordBlocked = prohibitedWords.some(w => activityText.includes(w));

    if (sicBlocked || wordBlocked) {
      return send(200, {
        symbol,
        status: "rejected_activity",
        activity: companyName,
        sic,
        sicDescription,
        filing: { form, filingDate, reportDate },
        marketCap,
        marketCapDate: new Date().toISOString(),
        reason: "النشاط الأساسي مصنف ضمن نشاط غير جائز في الفحص الأولي"
      }, headers);
    }

    // Debt: use only clearly identified interest-bearing debt concepts and avoid
    // counting generic liabilities such as accounts payable.
    const debt = sumFirstAvailable([
      ["LongTermDebtCurrent", "LongTermDebtNoncurrent"],
      ["LongTermDebtAndFinanceLeaseObligationsCurrent", "LongTermDebtAndFinanceLeaseObligationsNoncurrent"],
      ["LongTermDebtCurrent", "LongTermDebtNoncurrent", "ShortTermBorrowings"],
      ["LongTermDebt"]
    ], usgaap, reportDate, form, accession);

    // AAOIFI 3/4/3 is specifically interest-taking deposits, not ordinary cash.
    // We only accept an explicit XBRL fact for such deposits. If it is not disclosed
    // in a machine-readable form, the result is conservative: insufficient data.
    const interestDeposits = latestFact(
      [
        "InterestBearingDeposits",
        "InterestBearingDepositsInBanks",
        "InterestBearingDepositsAtOtherBanks"
      ],
      { end: reportDate, form, accession }
    );

    // Prohibited income: use explicitly disclosed interest income facts. If no explicit
    // fact exists, do not silently assume zero.
    const prohibitedIncome = latestFact(
      [
        "InterestIncomeNonOperating",
        "InterestIncomeExpenseNonOperatingNet",
        "InvestmentIncomeInterest",
        "InterestIncomeExpenseNonOperating"
      ],
      { form, accession }
    );

    const totalIncome = latestFact(
      [
        "RevenueFromContractWithCustomerExcludingAssessedTax",
        "Revenues",
        "SalesRevenueNet",
        "SalesRevenueGoodsNet",
        "SalesRevenueServicesNet"
      ],
      { form, accession }
    );

    const debtRatio = debt && marketCap ? (debt.value / marketCap) * 100 : null;
    const depositsRatio = interestDeposits && marketCap ? (interestDeposits.value / marketCap) * 100 : null;
    const prohibitedRatio =
      prohibitedIncome && totalIncome && totalIncome.value !== 0
        ? (Math.abs(prohibitedIncome.value) / Math.abs(totalIncome.value)) * 100
        : null;

    const checks = {
      debt: {
        numerator: debt?.value ?? null,
        denominator: marketCap,
        ratio: debtRatio,
        limit: 30,
        pass: debtRatio != null ? debtRatio <= 30 : null,
        sourceTag: debt?.tags || debt?.tag || null
      },
      interestTakingDeposits: {
        numerator: interestDeposits?.value ?? null,
        denominator: marketCap,
        ratio: depositsRatio,
        limit: 30,
        pass: depositsRatio != null ? depositsRatio <= 30 : null,
        sourceTag: interestDeposits?.tag || null
      },
      prohibitedIncome: {
        numerator: prohibitedIncome?.value ?? null,
        denominator: totalIncome?.value ?? null,
        ratio: prohibitedRatio,
        limit: 5,
        pass: prohibitedRatio != null ? prohibitedRatio <= 5 : null,
        sourceTag: prohibitedIncome?.tag || null
      }
    };

    const complete =
      marketCap != null &&
      checks.debt.pass !== null &&
      checks.interestTakingDeposits.pass !== null &&
      checks.prohibitedIncome.pass !== null;

    return send(200, {
      symbol,
      status: complete && Object.values(checks).every(x => x.pass) ? "compliant" :
              complete ? "rejected_financial" : "insufficient",
      activity: companyName,
      sic,
      sicDescription,
      filing: { form, filingDate, reportDate, accession },
      marketCap,
      marketCapDate: new Date().toISOString(),
      currentPrice,
      sharesOutstanding: shares,
      checks,
      note: complete
        ? "تم تطبيق حدود AAOIFI الثلاثة على البيانات المتاحة"
        : "لا توجد بيانات كافية للحسم؛ لا يتم افتراض القيم المفقودة"
    }, headers);

  } catch (error) {
    return send(500, {
      error: "تعذر تشغيل الفحص الشرعي",
      details: error.message
    }, headers);
  }
};

async function getCurrentPrice(symbol) {
  const url =
    "https://query1.finance.yahoo.com/v8/finance/chart/" +
    encodeURIComponent(symbol) +
    "?range=1d&interval=1m";

  const response = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
  });
  if (!response.ok) throw new Error("تعذر جلب السعر الحالي");
  const json = await response.json();
  return Number(json?.chart?.result?.[0]?.meta?.regularMarketPrice) || null;
}

function sumFirstAvailable(groups, usgaap, end, form, accession) {
  for (const group of groups) {
    const values = [];
    let complete = true;

    for (const tag of group) {
      const fact = usgaap[tag];
      if (!fact?.units) { complete = false; break; }

      const units = fact.units.USD || Object.values(fact.units)[0];
      const candidates = (units || [])
        .filter(x =>
          x.end === end &&
          x.form === form &&
          String(x.accn || "") === String(accession)
        )
        .sort((a,b) => String(b.filed || "").localeCompare(String(a.filed || "")));

      if (!candidates.length) { complete = false; break; }
      values.push(Number(candidates[0].val));
    }

    if (complete && values.every(Number.isFinite)) {
      return { value: values.reduce((a,b) => a+b, 0), tags: group };
    }
  }
  return null;
}

function send(statusCode, body, headers) {
  return { statusCode, headers, body: JSON.stringify(body) };
}
