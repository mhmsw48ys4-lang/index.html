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
      "Accept": "application/json,text/plain,*/*"
    };

    const tickerMap = await fetchJson("https://www.sec.gov/files/company_tickers.json", secHeaders);
    let company = null;

    for (const item of Object.values(tickerMap || {})) {
      if (String(item.ticker || "").toUpperCase() === symbol) {
        company = item;
        break;
      }
    }

    if (!company) return send(404, { error: "لم نجد الشركة في سجلات SEC" }, headers);

    const cik = String(company.cik_str).padStart(10, "0");
    const submissions = await fetchJson(
      "https://data.sec.gov/submissions/CIK" + cik + ".json",
      secHeaders
    );

    const recent = submissions?.filings?.recent || {};
    const filing = await chooseLatestFinancialFiling(recent, cik, secHeaders);

    if (!filing) {
      return send(200, {
        symbol,
        status: "insufficient",
        reason: "لم نجد آخر إفصاح مالي مناسب في SEC",
        source: "SEC EDGAR"
      }, headers);
    }

    const accessionNoDash = String(filing.accession).replace(/-/g, "");
    const cikNumber = String(Number(cik));
    const baseUrl =
      "https://www.sec.gov/Archives/edgar/data/" +
      cikNumber + "/" + accessionNoDash + "/";

    // Read the complete SEC submission. This is important for foreign issuers:
    // their financial statements are often attached to a 6-K rather than the
    // primary 6-K document itself.
    const rawSubmission = await fetchText(
      baseUrl + String(filing.accession) + ".txt",
      secHeaders
    );

    const filingText = cleanText(rawSubmission);

    // Companyfacts is still used when available, but it is no longer the only
    // source. Many small/foreign issuers use custom XBRL concepts or put the
    // financial statements in 6-K exhibits.
    let factsJson = null;
    try {
      factsJson = await fetchJson(
        "https://data.sec.gov/api/xbrl/companyfacts/CIK" + cik + ".json",
        secHeaders
      );
    } catch (_) {}

    const usgaap = factsJson?.facts?.["us-gaap"] || {};
    const dei = factsJson?.facts?.dei || {};

    const currentPrice = await getCurrentPrice(symbol);
    const shares = findSharesOutstanding(filingText, usgaap, dei, filing);

    const marketCap = currentPrice != null && shares != null
      ? currentPrice * shares
      : null;

    const sic = String(submissions.sic || "");
    const sicDescription = String(submissions.sicDescription || "");
    const companyName = String(submissions.name || company.name || "");

    // 3/4/1 is an activity/objective screen. SIC is only a conservative
    // first-pass signal; ambiguous cases are not rejected solely by SIC.
    const prohibitedWords = [
      "bank", "banking", "insurance", "casino", "gambling",
      "tobacco", "cigarette", "cannabis", "marijuana",
      "liquor", "distillery", "brewery", "beer", "wine",
      "pork", "swine", "adult entertainment"
    ];

    const activityText = (companyName + " " + sicDescription).toLowerCase();
    const wordBlocked = prohibitedWords.some(w => activityText.includes(w));

    if (wordBlocked) {
      return send(200, {
        symbol,
        status: "rejected_activity",
        activity: companyName,
        sic,
        sicDescription,
        filing: publicFiling(filing),
        marketCap,
        marketCapDate: new Date().toISOString(),
        currentPrice,
        sharesOutstanding: shares,
        reason: "النشاط الأساسي يحتاج رفضاً في الفحص الأولي وفق التصنيف الظاهر في SEC"
      }, headers);
    }

    // AAOIFI 3/4/2: interest-bearing debt, long or short term, <= 30% of
    // market capitalization. We deliberately do NOT count accounts payable,
    // ordinary lease liabilities, or generic total liabilities.
    const debt = findInterestBearingDebt(filingText, usgaap, filing);

    // AAOIFI 3/4/3: interest-taking deposits <= 30% of market capitalization.
    // Ordinary cash is NOT automatically treated as interest-taking deposits.
    const interestDeposits = findInterestTakingDeposits(filingText, usgaap, filing);

    // AAOIFI 3/4/4: prohibited income <= 5% of total income. Interest income
    // is the main explicitly identifiable prohibited component in ordinary
    // operating companies; other prohibited income is also searched by label.
    const prohibitedIncome = findProhibitedIncome(filingText, usgaap, filing);
    const totalIncome = findTotalIncome(filingText, usgaap, filing);

    const debtRatio = debt && marketCap > 0
      ? (debt.value / marketCap) * 100
      : null;

    const depositsRatio = interestDeposits && marketCap > 0
      ? (interestDeposits.value / marketCap) * 100
      : null;

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
        source: debt?.source || null
      },
      interestTakingDeposits: {
        numerator: interestDeposits?.value ?? null,
        denominator: marketCap,
        ratio: depositsRatio,
        limit: 30,
        pass: depositsRatio != null ? depositsRatio <= 30 : null,
        source: interestDeposits?.source || null
      },
      prohibitedIncome: {
        numerator: prohibitedIncome?.value ?? null,
        denominator: totalIncome?.value ?? null,
        ratio: prohibitedRatio,
        limit: 5,
        pass: prohibitedRatio != null ? prohibitedRatio <= 5 : null,
        source: prohibitedIncome?.source || null,
        incomeSource: prohibitedIncome?.label || null
      }
    };

    const complete =
      marketCap != null &&
      shares != null &&
      checks.debt.pass !== null &&
      checks.interestTakingDeposits.pass !== null &&
      checks.prohibitedIncome.pass !== null;

    const status =
      complete && Object.values(checks).every(x => x.pass)
        ? "compliant"
        : complete
          ? "rejected_financial"
          : "insufficient";

    return send(200, {
      symbol,
      status,
      activity: companyName,
      sic,
      sicDescription,
      filing: publicFiling(filing),
      marketCap,
      marketCapDate: new Date().toISOString(),
      currentPrice,
      sharesOutstanding: shares,
      checks,
      note: complete
        ? "تم استخراج البيانات من أحدث إفصاح مالي متاح، مع استخدام XBRL/نص الإفصاح عند الحاجة"
        : "بعض البيانات لم يمكن تحديدها بثقة من أحدث إفصاح؛ لم يتم افتراض قيمة مفقودة"
    }, headers);

  } catch (error) {
    return send(500, {
      error: "تعذر تشغيل الفحص الشرعي",
      details: error.message
    }, headers);
  }
};

function chooseLatestFinancialFiling(recent) {
  const forms = recent.form || [];
  const accessions = recent.accessionNumber || [];
  const primaryDocuments = recent.primaryDocument || [];
  const filingDates = recent.filingDate || [];
  const reportDates = recent.reportDate || [];
  const primaryDescriptions = recent.primaryDocDescription || [];

  const preferred = ["10-Q", "10-K", "20-F", "40-F"];

  for (const wanted of preferred) {
    for (let i = 0; i < forms.length; i++) {
      if (forms[i] === wanted) {
        return {
          form: forms[i],
          accession: accessions[i],
          primaryDocument: primaryDocuments[i],
          filingDate: filingDates[i],
          reportDate: reportDates[i],
          primaryDescription: primaryDescriptions[i] || ""
        };
      }
    }
  }

  // Foreign private issuers frequently publish interim financial statements
  // through 6-K exhibits. Accept a 6-K only when its filing metadata indicates
  // financial results/statements.
  for (let i = 0; i < forms.length; i++) {
    if (forms[i] !== "6-K") continue;
    const desc = String(primaryDescriptions[i] || "").toLowerCase();
    const doc = String(primaryDocuments[i] || "").toLowerCase();

    if (
      /financial|statement|result|earnings|quarter|interim|report/.test(desc + " " + doc)
    ) {
      return {
        form: forms[i],
        accession: accessions[i],
        primaryDocument: primaryDocuments[i],
        filingDate: filingDates[i],
        reportDate: reportDates[i],
        primaryDescription: primaryDescriptions[i] || ""
      };
    }
  }

  return null;
}

function findSharesOutstanding(text, usgaap, dei, filing) {
  const patterns = [
    /(?:shares?|ordinary shares?|common shares?)[^\n]{0,100}(?:outstanding|issued and outstanding)[^\n]{0,120}?([0-9][0-9,]*(?:\.\d+)?)/i,
    /([0-9][0-9,]*(?:\.\d+)?)\s+(?:shares?|ordinary shares?|common shares?)\s+(?:issued and )?outstanding/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (m) {
      const n = parseNumber(m[1]);
      if (n > 0) return n;
    }
  }

  const fact = latestFactFromFacts(
    ["EntityCommonStockSharesOutstanding", "CommonStockSharesOutstanding"],
    dei,
    usgaap,
    filing
  );

  return fact?.value || null;
}

function findInterestBearingDebt(text, usgaap, filing) {
  // Prefer explicit interest-bearing/bank borrowing concepts.
  const fact = latestFactFromFacts([
    "LongTermDebtCurrent",
    "LongTermDebtNoncurrent",
    "LongTermDebt",
    "ShortTermBorrowings",
    "ShortTermDebt",
    "LongTermBorrowingsCurrent",
    "LongTermBorrowingsNoncurrent"
  ], usgaap, {}, filing);

  // Text extraction is necessary for custom concepts/6-K financial statements.
  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const matched = [];
  const debtRegex = /(?:bank borrowings|bank borrowing|short[- ]term borrowings|long[- ]term borrowings|borrowings[- ]current|borrowings[- ]non[- ]current|interest[- ]bearing (?:debt|loans|borrowings)|loans payable)/i;

  for (const line of lines) {
    if (!debtRegex.test(line)) continue;
    const nums = numbersFromLine(line);
    if (nums.length) {
      matched.push({ label: line.slice(0, 180), value: nums[0] });
    }
  }

  if (matched.length) {
    // Remove duplicate comparative/table echoes by keeping the largest unique
    // current-period line items. We intentionally exclude accounts payable.
    const unique = [];
    for (const item of matched) {
      if (!unique.some(x => Math.abs(x.value - item.value) < 0.01 && x.label === item.label)) {
        unique.push(item);
      }
    }
    const sum = unique.reduce((a, x) => a + x.value, 0);
    if (sum > 0) {
      return {
        value: sum,
        source: unique.map(x => x.label).slice(0, 6).join(" | ")
      };
    }
  }

  if (fact?.value != null) {
    return { value: fact.value, source: "SEC XBRL" };
  }

  return null;
}

function findInterestTakingDeposits(text, usgaap, filing) {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const regex = /interest[- ]bearing deposits?|interest[- ]taking deposits?|deposits? (?:that|which) (?:earn|take) interest/i;

  for (const line of lines) {
    if (!regex.test(line)) continue;
    const nums = numbersFromLine(line);
    if (nums.length) {
      return {
        value: nums[0],
        source: line.slice(0, 220)
      };
    }
  }

  const fact = latestFactFromFacts([
    "InterestBearingDeposits",
    "InterestBearingDepositsInBanks",
    "InterestBearingDepositsAtOtherBanks"
  ], usgaap, {}, filing);

  if (fact?.value != null) {
    return { value: fact.value, source: "SEC XBRL" };
  }

  // No explicit interest-taking deposit disclosed. Ordinary cash is not counted.
  return { value: 0, source: "لم يُفصح الإفصاح المالي عن ودائع موصوفة بأنها تأخذ فائدة؛ لم يُحتسب النقد العادي" };
}

function findProhibitedIncome(text, usgaap, filing) {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const regex = /(?:interest income|interest revenue|income from interest|gambling income|alcohol|tobacco|pork|swine)/i;

  for (const line of lines) {
    if (!regex.test(line)) continue;
    const nums = numbersFromLine(line);
    if (nums.length && /interest income|interest revenue|income from interest/i.test(line)) {
      return {
        value: Math.abs(nums[0]),
        label: "Interest income",
        source: line.slice(0, 220)
      };
    }
  }

  const fact = latestFactFromFacts([
    "InterestIncomeNonOperating",
    "InterestIncomeExpenseNonOperatingNet",
    "InvestmentIncomeInterest",
    "InterestIncomeExpenseNonOperating"
  ], usgaap, {}, filing);

  if (fact?.value != null) {
    return {
      value: Math.abs(fact.value),
      label: fact.tag,
      source: "SEC XBRL"
    };
  }

  return null;
}

function findTotalIncome(text, usgaap, filing) {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);

  // Prefer a reported revenue/total income line from the latest financial
  // statement. The first number is the current-period amount.
  const regex = /^(?:revenue|revenues|total revenue|net sales|sales revenue|total income|operating revenue)\b/i;

  for (const line of lines) {
    if (!regex.test(line)) continue;
    const nums = numbersFromLine(line);
    if (nums.length && nums[0] > 0) {
      return {
        value: nums[0],
        source: line.slice(0, 220)
      };
    }
  }

  const fact = latestFactFromFacts([
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "Revenues",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
    "SalesRevenueServicesNet"
  ], usgaap, {}, filing);

  return fact?.value != null
    ? { value: Math.abs(fact.value), source: "SEC XBRL" }
    : null;
}

function latestFactFromFacts(names, primaryFacts, secondaryFacts, filing) {
  const all = { ...(secondaryFacts || {}), ...(primaryFacts || {}) };

  for (const name of names) {
    const fact = all[name];
    if (!fact?.units) continue;

    for (const unit of Object.values(fact.units)) {
      if (!Array.isArray(unit)) continue;

      const candidates = unit
        .filter(x =>
          (!filing.accession || String(x.accn || "") === String(filing.accession)) &&
          Number.isFinite(Number(x.val))
        )
        .sort((a, b) => String(b.filed || "").localeCompare(String(a.filed || "")));

      if (candidates.length) {
        return {
          value: Number(candidates[0].val),
          tag: name
        };
      }
    }
  }

  return null;
}

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

async function fetchJson(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("تعذر جلب بيانات SEC");
  return response.json();
}

async function fetchText(url, headers) {
  const response = await fetch(url, { headers });
  if (!response.ok) throw new Error("تعذر جلب ملف الإفصاح المالي من SEC");
  return response.text();
}

function cleanText(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/tr>/gi, "\n")
      .replace(/<\/p>/gi, "\n")
      .replace(/<\/div>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/[\u00a0\t]+/g, " ")
      .replace(/[ ]{2,}/g, " ")
  );
}

function normalizeLine(s) {
  return String(s || "")
    .replace(/\s+/g, " ")
    .replace(/[|]+/g, " ")
    .trim();
}

function numbersFromLine(line) {
  const matches = String(line || "").match(/\(?-?\$?\s*[0-9][0-9,]*(?:\.\d+)?\)?/g) || [];
  return matches
    .map(parseNumber)
    .filter(Number.isFinite)
    .filter(n => Math.abs(n) > 0);
}

function parseNumber(raw) {
  let s = String(raw || "").replace(/[$,%\s]/g, "");
  let negative = /^\(.*\)$/.test(s);
  s = s.replace(/[()]/g, "").replace(/,/g, "");
  const n = Number(s);
  return negative ? -n : n;
}

function decodeHtml(s) {
  return String(s || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}

function publicFiling(filing) {
  return {
    form: filing.form,
    filingDate: filing.filingDate,
    reportDate: filing.reportDate,
    accession: filing.accession,
    primaryDocument: filing.primaryDocument
  };
}

function send(statusCode, body, headers) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
}
