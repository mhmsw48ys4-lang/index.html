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

    const liveMarket = await getCurrentMarketData(symbol);
    const currentPrice = liveMarket?.price ?? await getCurrentPrice(symbol);
    const shares = liveMarket?.shares ?? null;

    // AAOIFI denominator: use a live market-cap field from the market-data
    // source. Never rebuild today's market cap from an old SEC share count.
    // This is especially important after reverse splits and new share issues.
    const marketCap = liveMarket?.marketCap ?? null;

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
        marketCapSource: liveMarket?.source || null,
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
      marketCapSource: liveMarket?.source || null,
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

async function chooseLatestFinancialFiling(recent, cik, secHeaders) {
  const forms = recent.form || [];
  const accessions = recent.accessionNumber || [];
  const primaryDocuments = recent.primaryDocument || [];
  const filingDates = recent.filingDate || [];
  const reportDates = recent.reportDate || [];
  const primaryDescriptions = recent.primaryDocDescription || [];

  const candidates = [];

  // Regular financial reports.
  for (let i = 0; i < forms.length; i++) {
    if (!["10-Q", "10-K", "20-F", "40-F"].includes(forms[i])) continue;
    candidates.push({
      form: forms[i],
      accession: accessions[i],
      primaryDocument: primaryDocuments[i],
      filingDate: filingDates[i],
      reportDate: reportDates[i],
      primaryDescription: primaryDescriptions[i] || "",
      financialPeriod: reportDates[i] || null
    });
  }

  // Foreign private issuers: inspect recent 6-K submissions and choose the
  // newest one that actually contains financial statements.
  for (let i = 0; i < Math.min(forms.length, 40); i++) {
    if (forms[i] !== "6-K") continue;
    const acc = String(accessions[i] || "");
    if (!acc) continue;

    const url =
      "https://www.sec.gov/Archives/edgar/data/" +
      String(Number(cik)) + "/" + acc.replace(/-/g, "") + "/" + acc + ".txt";

    try {
      const plain = cleanText(await fetchText(url, secHeaders));
      const financial =
        /condensed consolidated (?:balance sheets|statements of operations)/i.test(plain) ||
        /financial statements/i.test(plain) && /revenues?/i.test(plain) && /total liabilities/i.test(plain);

      if (!financial) continue;

      const period = extractLatestFinancialPeriod(plain);
      candidates.push({
        form: "6-K",
        accession: acc,
        primaryDocument: primaryDocuments[i],
        filingDate: filingDates[i],
        reportDate: period || reportDates[i] || filingDates[i],
        primaryDescription: primaryDescriptions[i] || "",
        financialPeriod: period || reportDates[i] || filingDates[i]
      });
    } catch (_) {}
  }

  candidates.sort((a,b) => {
    const da = String(a.financialPeriod || a.reportDate || a.filingDate || "");
    const db = String(b.financialPeriod || b.reportDate || b.filingDate || "");
    if (da !== db) return db.localeCompare(da);
    return String(b.filingDate || "").localeCompare(String(a.filingDate || ""));
  });

  return candidates[0] || null;
}

function extractLatestFinancialPeriod(text) {
  const dates = [];
  const re = /(?:as of|ended|ending|year ended|six months ended|three months ended|nine months ended)\s+(?:the\s+)?([A-Z][a-z]+\s+\d{1,2},\s+20\d{2})/gi;
  let m;
  while ((m = re.exec(text))) {
    const d = Date.parse(m[1]);
    if (!Number.isNaN(d)) dates.push(new Date(d).toISOString().slice(0,10));
  }
  dates.sort();
  return dates.length ? dates[dates.length - 1] : null;
}

async function findCurrentSharesOutstanding(text, usgaap, dei, filing, recent, cik, secHeaders) {
  const direct = findSharesOutstanding(text, usgaap, dei, filing);
  let best = direct || null;
  const forms = recent?.form || [];
  const accessions = recent?.accessionNumber || [];

  for (let i = 0; i < Math.min(forms.length, 40); i++) {
    if (forms[i] !== "6-K") continue;
    const acc = String(accessions[i] || "");
    if (!acc) continue;

    const url =
      "https://www.sec.gov/Archives/edgar/data/" +
      String(Number(cik)) + "/" +
      acc.replace(/-/g, "") + "/" + acc + ".txt";

    let plain;
    try { plain = cleanText(await fetchText(url, secHeaders)); }
    catch (_) { continue; }

    const post = extractShareAmount(
      plain,
      /Class A[^.\n]{0,180}?approximately\s+([0-9.]+)\s+million[^.\n]{0,120}?Class B[^.\n]{0,100}?approximately\s+([0-9.]+)\s+(million|thousand|shares?|ordinary shares?)/i
    );

    if (post) {
      const total = post.a + post.b;
      if (total > 1000) { best = total; break; }
    }

    const exact = extractExactClassShares(plain);
    if (exact && exact > 1000 && /reverse stock split|reverse split|share consolidation|post[- ]reverse[- ]split/i.test(plain)) {
      best = exact;
      break;
    }
  }

  return best;
}

function extractShareAmount(text, regex) {
  const m = String(text || "").match(regex);
  if (!m) return null;
  const a = Number(m[1]) * 1000000;
  const bRaw = Number(m[2]);
  const unit = String(m[3] || "").toLowerCase();
  const multiplier = unit.includes("million") ? 1000000 : unit.includes("thousand") ? 1000 : 1;
  const b = bRaw * multiplier;
  return Number.isFinite(a) && Number.isFinite(b) ? {a,b} : null;
}

function extractExactClassShares(text) {
  const a = String(text || "").match(/Class A[^.\n]{0,180}?([0-9][0-9,]+)\s+(?:ordinary )?shares?[^.\n]{0,80}?issued and outstanding/i);
  const b = String(text || "").match(/Class B[^.\n]{0,180}?([0-9][0-9,]+)\s+(?:ordinary )?shares?[^.\n]{0,80}?issued and outstanding/i);
  if (!a || !b) return null;
  const av = parseNumber(a[1]), bv = parseNumber(b[1]);
  return av > 1000 && bv >= 0 ? av + bv : null;
}

function findSharesOutstanding(text, usgaap, dei, filing) {
  const fact = latestFactFromFacts(
    ["EntityCommonStockSharesOutstanding", "CommonStockSharesOutstanding"],
    dei, usgaap, filing
  );
  if (fact?.value > 1000) return fact.value;

  const patterns = [
    /([0-9][0-9,]+)\s+Class\s+A[^\n]{0,100}?and\s+([0-9][0-9,]+)\s+Class\s+B[^\n]{0,100}?issued and outstanding/i,
    /as of [A-Z][a-z]+\s+\d{1,2},\s+20\d{2}[^\n]{0,120}?([0-9][0-9,]+)\s+Class\s+A[^\n]{0,100}?([0-9][0-9,]+)\s+Class\s+B/i
  ];
  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    const a = parseNumber(m[1]), b = parseNumber(m[2]);
    if (a > 1000 && b >= 0) return a + b;
  }
  return null;
}

function findInterestBearingDebt(text, usgaap, filing) {
  const currentConvertible = extractLabeledAmount(text, /(?:^|\n)\s*Convertible debt\s+\$?\s*([0-9][0-9,]*(?:\.\d+)?)/i);
  const bankLoan = extractLabeledAmount(text, /(?:^|\n)\s*Long-term bank loan\s+\$?\s*([0-9][0-9,]*(?:\.\d+)?)/i);

  const explicit = [];
  if (currentConvertible != null) explicit.push({ label: "Convertible debt", value: currentConvertible });
  if (bankLoan != null) explicit.push({ label: "Long-term bank loan", value: bankLoan });

  if (explicit.length) {
    return {
      value: explicit.reduce((sum, x) => sum + x.value, 0),
      source: explicit.map(x => x.label + ": $" + x.value.toLocaleString("en-US")).join(" + ")
    };
  }

  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const debtRegex = /(?:convertible debt|convertible note|bank borrowings|bank borrowing|short[- ]term borrowings|long[- ]term borrowings|long[- ]term bank loan|borrowings[- ]current|borrowings[- ]non[- ]current|interest[- ]bearing (?:debt|loans|borrowings)|loans payable)/i;
  const matched = [];
  for (const line of lines) {
    if (!debtRegex.test(line)) continue;
    const nums = numbersFromLine(line);
    if (nums.length) matched.push({ label: line.slice(0, 180), value: nums[0] });
  }
  if (matched.length) {
    const unique = [];
    for (const item of matched) {
      if (!unique.some(x => Math.abs(x.value - item.value) < 0.01 && x.label === item.label)) unique.push(item);
    }
    const sum = unique.reduce((a, x) => a + x.value, 0);
    if (sum > 0) return { value: sum, source: unique.map(x => x.label).slice(0, 6).join(" | ") };
  }

  const fact = latestFactFromFacts([
    "LongTermDebtCurrent","LongTermDebtNoncurrent","LongTermDebt","ShortTermBorrowings",
    "ShortTermDebt","LongTermBorrowingsCurrent","LongTermBorrowingsNoncurrent"
  ], usgaap, {}, filing);
  return fact?.value != null ? { value: fact.value, source: "SEC XBRL" } : null;
}

function extractLabeledAmount(text, regex) {
  const m = String(text || "").match(regex);
  if (!m) return null;
  const n = parseNumber(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
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

  // No explicit interest-taking deposit disclosed. Ordinary cash is not counted,
  // but absence of disclosure is not the same as proving the amount is zero.
  return null;
}

function findProhibitedIncome(text, usgaap, filing) {
  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const regex = /(?:interest income|interest revenue|income from interest)/i;

  for (const line of lines) {
    // Do not treat "interest expense", "interest expenses, net", or
    // "net interest income (expense)" as prohibited income. We need an
    // explicitly reported positive interest-income component.
    if (!regex.test(line) || /interest expense|interest expenses|net interest income \(expense\)/i.test(line)) continue;
    const nums = numbersFromLine(line);
    if (nums.length) {
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

async function getCurrentMarketData(symbol) {
  // Nasdaq screener provides a current last-sale price and market-cap field.
  // Prefer it over SEC share counts because SEC shares can be stale after
  // reverse splits or later share issuances.
  const headers = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/146.0.0.0 Safari/537.36",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.nasdaq.com",
    "Referer": "https://www.nasdaq.com/market-activity/stocks/screener"
  };

  for (const exchange of ["NASDAQ", "NYSE", "AMEX"]) {
    try {
      const url =
        "https://api.nasdaq.com/api/screener/stocks" +
        "?tableonly=true&limit=5000&offset=0&exchange=" +
        encodeURIComponent(exchange) + "&download=true";

      const response = await fetch(url, { headers });
      if (!response.ok) continue;

      const json = await response.json();
      const rows = Array.isArray(json?.data?.rows) ? json.data.rows : [];
      const q = rows.find(x => String(x.symbol || "").trim().toUpperCase() === symbol);
      if (!q) continue;

      const price = parseMarketNumber(q.lastsale);
      const marketCap = parseMarketNumber(q.marketCap);
      const shares = parseMarketNumber(q.sharesOutstanding ?? q.sharesoutstanding);

      return {
        price: Number.isFinite(price) && price > 0 ? price : null,
        marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null,
        shares: Number.isFinite(shares) && shares > 0 ? shares : null,
        source: "Nasdaq Screener"
      };
    } catch (_) {}
  }

  // Yahoo is only a secondary live source. We do not fall back to SEC share
  // counts for market capitalization.
  try {
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
      encodeURIComponent(symbol);

    const response = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });
    if (!response.ok) return null;

    const json = await response.json();
    const q = json?.quoteResponse?.result?.[0];
    if (!q) return null;

    const price = Number(q.regularMarketPrice ?? q.postMarketPrice);
    const marketCap = Number(q.marketCap);
    const shares = Number(q.sharesOutstanding);

    return {
      price: Number.isFinite(price) && price > 0 ? price : null,
      marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null,
      shares: Number.isFinite(shares) && shares > 0 ? shares : null,
      source: "Yahoo Finance"
    };
  } catch (_) {
    return null;
  }
}

function parseMarketNumber(value) {
  if (value == null) return NaN;
  let s = String(value).trim().replace(/[$,\s]/g, "");
  if (!s) return NaN;

  const suffix = s.slice(-1).toUpperCase();
  const multipliers = { K: 1e3, M: 1e6, B: 1e9, T: 1e12 };
  if (multipliers[suffix]) {
    const n = Number(s.slice(0, -1));
    return Number.isFinite(n) ? n * multipliers[suffix] : NaN;
  }

  const n = Number(s);
  return Number.isFinite(n) ? n : NaN;
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
