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

    // Prefer the filing's primary financial document for 10-Q/10-K filings.
    // It is much smaller and more reliable on Netlify than downloading the
    // complete SEC submission text. Fall back to the complete submission if
    // the primary document is unavailable.
    const submissionUrl = baseUrl + String(filing.accession) + ".txt";
    const primaryUrl = filing.primaryDocument
      ? baseUrl + String(filing.primaryDocument)
      : null;

    let rawSubmission;
    if (primaryUrl) {
      try {
        rawSubmission = await fetchText(primaryUrl, secHeaders);
      } catch (_) {
        rawSubmission = await fetchText(submissionUrl, secHeaders);
      }
    } else {
      rawSubmission = await fetchText(submissionUrl, secHeaders);
    }

    const filingText = cleanText(rawSubmission);

    // Companyfacts is still used when available, but it is no longer the only
    // source. Many small/foreign issuers use custom XBRL concepts or put the
    // financial statements in 6-K exhibits.
    // Keep the function fast and deterministic: use the selected filing text
    // as the primary source. Companyfacts can be a very large response and
    // was causing Netlify execution failures on small issuers.
    const usgaap = {};
    const dei = {};

    const liveMarket = await getCurrentMarketData(symbol);
    const currentPrice = liveMarket?.price ?? await getCurrentPrice(symbol);

    let shares = liveMarket?.shares ?? null;
    if (!(Number.isFinite(shares) && shares > 0)) {
      shares = findSharesOutstanding(filingText, usgaap, dei, filing);
    }

    // AAOIFI denominator: prefer a live market-cap field. If the quote
    // provider does not return market cap, calculate it from the current
    // price and the latest share-count disclosure in the selected filing.
    let marketCap = liveMarket?.marketCap ?? null;
    if (!(Number.isFinite(marketCap) && marketCap > 0) &&
        Number.isFinite(currentPrice) && currentPrice > 0 &&
        Number.isFinite(shares) && shares > 0) {
      marketCap = currentPrice * shares;
    }

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

  if (candidates.length) {
    candidates.sort((a,b) =>
      String(b.financialPeriod || b.reportDate || b.filingDate || "")
        .localeCompare(String(a.financialPeriod || a.reportDate || a.filingDate || ""))
    );
    return candidates[0];
  }

  // For foreign issuers, many financial 6-Ks identify the reporting period
  // directly in the primary-document filename (for example ntcl-20260331x6k.htm).
  // Use that metadata first so we do not download several 8-10 MB submissions.
  const sixKs = [];
  for (let i = 0; i < forms.length && sixKs.length < 12; i++) {
    if (forms[i] !== "6-K") continue;
    const acc = String(accessions[i] || "");
    const doc = String(primaryDocuments[i] || "");
    if (!acc) continue;

    const m = doc.match(/(20\d{2})(\d{2})(\d{2})/);
    if (m) {
      sixKs.push({
        acc,
        primaryDocument: doc,
        filingDate: filingDates[i],
        reportDate: m[1] + "-" + m[2] + "-" + m[3],
        primaryDescription: primaryDescriptions[i] || "",
        financialPeriod: m[1] + "-" + m[2] + "-" + m[3]
      });
    }
  }

  if (sixKs.length) {
    sixKs.sort((a,b) =>
      String(b.financialPeriod).localeCompare(String(a.financialPeriod)) ||
      String(b.filingDate || "").localeCompare(String(a.filingDate || ""))
    );
    return { ...sixKs[0], form: "6-K" };
  }

  // Last resort for issuers whose 6-K filename does not expose the period.
  const fallback = [];
  for (let i = 0; i < forms.length && fallback.length < 2; i++) {
    if (forms[i] !== "6-K") continue;
    const acc = String(accessions[i] || "");
    if (!acc) continue;
    fallback.push({
      acc,
      primaryDocument: primaryDocuments[i],
      filingDate: filingDates[i],
      reportDate: reportDates[i],
      primaryDescription: primaryDescriptions[i] || ""
    });
  }

  const found = await Promise.all(fallback.map(async item => {
    const url =
      "https://www.sec.gov/Archives/edgar/data/" +
      String(Number(cik)) + "/" + item.acc.replace(/-/g, "") + "/" + item.acc + ".txt";
    try {
      const plain = cleanText(await fetchText(url, secHeaders));
      const financial =
        /condensed consolidated (?:balance sheets|statements of operations)/i.test(plain) ||
        (/financial statements/i.test(plain) && /revenues?/i.test(plain) && /total liabilities/i.test(plain));
      if (!financial) return null;
      const period = extractLatestFinancialPeriod(plain);
      return {
        form: "6-K",
        accession: item.acc,
        primaryDocument: item.primaryDocument,
        filingDate: item.filingDate,
        reportDate: period || item.reportDate || item.filingDate,
        primaryDescription: item.primaryDescription,
        financialPeriod: period || item.reportDate || item.filingDate
      };
    } catch (_) { return null; }
  }));

  for (const item of found) if (item) candidates.push(item);
  candidates.sort((a,b) =>
    String(b.financialPeriod || b.reportDate || b.filingDate || "")
      .localeCompare(String(a.financialPeriod || a.reportDate || a.filingDate || ""))
  );
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
    /as of [A-Z][a-z]+\s+\d{1,2},\s+20\d{2}[^\n]{0,220}?there were\s+([0-9][0-9,]+)\s+shares?[^\n]{0,80}?outstanding/i,
    /as of [A-Z][a-z]+\s+\d{1,2},\s+20\d{2}[^\n]{0,220}?([0-9][0-9,]+)\s+shares?[^\n]{0,80}?outstanding/i,
    /there were\s+([0-9][0-9,]+)\s+(?:shares?|shares? of (?:the )?(?:registrant's|registrant) common stock)[^\n]{0,80}?outstanding/i,
    /([0-9][0-9,]+)\s+Class\s+A[^\n]{0,100}?and\s+([0-9][0-9,]+)\s+Class\s+B[^\n]{0,100}?issued and outstanding/i,
    /as of [A-Z][a-z]+\s+\d{1,2},\s+20\d{2}[^\n]{0,120}?([0-9][0-9,]+)\s+Class\s+A[^\n]{0,100}?([0-9][0-9,]+)\s+Class\s+B/i
  ];

  for (const re of patterns) {
    const m = text.match(re);
    if (!m) continue;
    if (m.length === 2) {
      const n = parseNumber(m[1]);
      if (n > 1000) return n;
    } else {
      const a = parseNumber(m[1]), b = parseNumber(m[2]);
      if (a > 1000 && b >= 0) return a + b;
    }
  }
  return null;
}

function findInterestBearingDebt(text, usgaap, filing) {
  // AAOIFI 3/4/2: count only explicitly interest-bearing loans/debt.
  // For NTCL and similar filings, the balance-sheet row itself is the
  // authoritative current-period amount.
  const convertible = extractLabeledAmount(
    text,
    /Convertible debt[\s\S]{0,120}?\$?\s*([0-9][0-9,]+(?:\.\d+)?)/i
  );
  const bankLoan = extractLabeledAmount(
    text,
    /Long-term bank loan[\s\S]{0,120}?\$?\s*([0-9][0-9,]+(?:\.\d+)?)/i
  );

  const explicit = [];
  if (convertible != null) explicit.push({ label: "Convertible debt", value: convertible });
  if (bankLoan != null) explicit.push({ label: "Long-term bank loan", value: bankLoan });

  if (explicit.length) {
    return {
      value: explicit.reduce((sum, x) => sum + x.value, 0),
      source: explicit.map(x => x.label + ": $" + x.value.toLocaleString("en-US")).join(" + ")
    };
  }

  // Fallback: parse individual financial-statement rows, but never use
  // total liabilities or generic XBRL debt facts that can represent a
  // different accounting concept.
  const lines = text.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const rowRegex = /^(?:convertible debt|convertible note|long-term bank loan|short[- ]term borrowings|long[- ]term borrowings|loans payable|bank borrowings|bank borrowing|term loan|senior notes?|debt|notes payable)\b/i;
  const matched = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!rowRegex.test(line)) continue;

    // Generic debt labels are counted only when the filing also identifies
    // interest/rate information nearby; this avoids counting other liabilities.
    const nearby = lines.slice(i, Math.min(lines.length, i + 4)).join(" ");
    const explicitlyInterestBearing =
      /interest[- ]bearing|interest rate|interest expense|annual rate|coupon/i.test(nearby);

    if (/^(?:debt|notes payable)\b/i.test(line) && !explicitlyInterestBearing) continue;

    const nums = numbersFromLine(line);
    if (nums.length) {
      matched.push({
        label: line.slice(0, 180),
        value: Math.abs(nums[0]) * inferLineScale(lines, i)
      });
    }
  }

  if (matched.length) {
    return {
      value: matched.reduce((sum, x) => sum + x.value, 0),
      source: matched.map(x => x.label).slice(0, 6).join(" | ")
    };
  }

  // If the balance sheet explicitly lists its liabilities and none of the
  // listed liability classes are interest-bearing debt, the AAOIFI debt
  // numerator is zero. This is different from an undisclosed balance sheet:
  // we only return zero when the statement is sufficiently complete.
  const liabilityStart = lines.findIndex(x => /^(?:liabilities|current liabilities)\b/i.test(x));
  const totalLiabilityIndex = lines.findIndex(x => /^total liabilities\b/i.test(x));
  if (totalLiabilityIndex >= 0) {
    const start = liabilityStart >= 0 ? liabilityStart : Math.max(0, totalLiabilityIndex - 20);
    const liabilityLines = lines.slice(start, totalLiabilityIndex + 1);
    const debtLike = liabilityLines.some(x =>
      /^(?:convertible debt|convertible note|short[- ]term borrowings|long[- ]term borrowings|loans payable|bank borrowings|bank borrowing|term loan|senior notes?|debt|notes payable)\b/i.test(x)
    );
    if (!debtLike) {
      return { value: 0, source: "SEC balance sheet — no interest-bearing debt line disclosed" };
    }
  }

  // Missing or ambiguous disclosure remains insufficient; never guess.
  return null;
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

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!regex.test(line)) continue;
    const value = firstFinancialValueAfterLabel(line, regex);
    if (value != null) {
      return {
        value: Math.abs(value) * inferLineScale(lines, i),
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
    return { value: Math.abs(fact.value), source: "SEC XBRL" };
  }

  // Ordinary cash is NOT treated as an interest-taking deposit merely because
  // it appears on the balance sheet. No explicit disclosure = insufficient.
  return null;
}

function getPrimaryOperationsStatementSection(text) {
  const raw = String(text || "");
  const marker = /(?:condensed (?:consolidated )?)?statements of operations(?: and comprehensive (?:loss|income))?/gi;
  let m;

  // SEC filings often mention the statement first in the table of contents.
  // We must skip that occurrence and select the actual financial table.
  while ((m = marker.exec(raw))) {
    const tail = raw.slice(m.index, m.index + 160000);
    // Do not let "and Comprehensive Loss" inside the statement title itself
    // terminate the section. Search for the end marker only after the title.
    const afterTitle = tail.slice(m[0].length);
    const stop = afterTitle.search(/(?:condensed )?(?:statements of cash flows|statements of comprehensive (?:loss|income)|notes to (?:condensed )?financial statements)/i);
    const section = stop > 0 ? afterTitle.slice(0, stop) : afterTitle;

    const hasPeriodHeader =
      /three months ended|three and six months ended|quarter ended|months ended/i.test(section);
    const hasIncomeRows =
      /(?:^|\n)\s*(?:sales|revenue|net sales|interest income|dividend income)\b/i.test(section);
    const numberCount =
      (section.match(/(?:\$?\s*\(?[0-9][0-9,]*(?:\.\d+)?\)?|—|–)/g) || []).length;

    if (hasPeriodHeader && hasIncomeRows && numberCount >= 8) return section;
  }

  return null;
}

function extractStatementRowValues(text, labelRegex) {
  const section = getPrimaryOperationsStatementSection(text);
  if (!section) return [];

  const lines = section.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const out = [];

  for (const line of lines) {
    if (!labelRegex.test(line)) continue;

    const after = line.replace(labelRegex, " ");
    const matches = after.match(/(?:\$?\(?[0-9][0-9,]*(?:\.\d+)?\)?|—|–)/g) || [];

    for (const token of matches) {
      if (token === "—" || token === "–") {
        out.push(0);
        break;
      }
      const n = parseNumber(token);
      if (Number.isFinite(n)) {
        out.push(Math.abs(n));
        break;
      }
    }
  }
  return out;
}

function getOperationsSection(text) {
  const raw = String(text || "");
  const marker = /(?:condensed consolidated )?(?:statements of operations|statements of income|statements of earnings)/gi;
  const matches = [];
  let m;
  while ((m = marker.exec(raw))) matches.push(m.index);

  // SEC filings often mention the statement in the Table of Contents first.
  // Choose the occurrence that actually contains statement rows, not the TOC.
  for (let i = matches.length - 1; i >= 0; i--) {
    const start = matches[i];
    const tail = raw.slice(start);
    const stop = tail.search(/see accompanying notes to condensed consolidated financial statements|statements of comprehensive (?:loss|income)|item 2\./i);
    const section = stop > 0 ? tail.slice(0, stop) : tail.slice(0, 120000);

    if (/interest income|dividend income|revenue|net loss|operating expenses/i.test(section)) {
      return section;
    }
  }

  return null;
}

function extractStatementAmount(text, labelPattern) {
  const raw = String(text || "");
  const re = new RegExp(labelPattern + "[^\\n]{0,180}?(?:—|–|-|\\$?\\s*\\(?([0-9][0-9,]*(?:\\.\\d+)?)\\)?)", "i");
  const m = raw.match(re);
  if (!m) return null;
  const n = parseNumber(m[1]);
  return Number.isFinite(n) ? Math.abs(n) : null;
}


function extractSecCurrentQuarterIncomeComponents(text) {
  const raw = String(text || "");

  // First parse the cleaned SEC table globally by exact first-cell labels.
  // This is independent of statement-title formatting and works even when
  // SEC HTML inserts empty cells between the label, "$", and amount.
  {
    const lines = raw.split(/\r?\n/).map(x => String(x || "").trim()).filter(Boolean);
    const wanted = [
      { key: "sales", re: /^Sales\s*\|/i },
      { key: "interest", re: /^Interest income(?:,\s*net)?\s*\|/i },
      { key: "dividend", re: /^Dividend income\s*\|/i },
      { key: "conversion", re: /^Change in fair value of conversion option liability\s*\|/i },
      { key: "warrants", re: /^Change in fair value of warrants liabilities?\s*\|/i }
    ];
    const components = [];
    const seen = new Set();

    for (const line of lines) {
      const cells = line.split("|").map(x => x.trim()).filter(Boolean);
      if (!cells.length) continue;
      const label = cells[0].replace(/^FEMASYS INC\.\s+/i, "").trim();

      for (const item of wanted) {
        if (!item.re.test(label + " |")) continue;
        for (const cell of cells.slice(1)) {
          const token = cell.match(/^\$?\s*\(?[0-9][0-9,]*(?:\.\d+)?\)?$/);
          if (!token) continue;
          const value = Math.abs(parseNumber(token[0]));
          if (Number.isFinite(value) && value > 0 && !seen.has(value)) {
            seen.add(value);
            components.push({ key: item.key, value });
          }
          break;
        }
        break;
      }
    }

    const interest = components.find(x => x.key === "interest")?.value ?? null;
    if (components.some(x => x.key === "sales") && interest != null) {
      return {
        total: components.reduce((sum, x) => sum + x.value, 0),
        interest,
        components
      };
    }
  }

  // The SEC cleaner preserves table cells with "|" and rows with newlines.
  // Parse the actual Statement of Operations cell-by-cell so the first
  // numeric cell is always the current-quarter value.
  const titleRe = /(?:Condensed\s+(?:Consolidated\s+)?)?Statements\s+of\s+Operations(?:\s+and\s+Comprehensive\s+(?:Loss|Income))?/gi;
  let m;
  let statement = null;

  while ((m = titleRe.exec(raw))) {
    const tail = raw.slice(m.index, m.index + 60000);
    if (!/Three\s+Months\s+Ended/i.test(tail)) continue;
    if (!/(?:^|\n)\s*Sales\s*\|/im.test(tail)) continue;

    const stop = tail.search(/Condensed\s+Statements\s+of\s+Stockholders|Condensed\s+Statements\s+of\s+Cash\s+Flows|Statements\s+of\s+Cash\s+Flows|Notes\s+to\s+(?:Condensed\s+)?Financial\s+Statements/i);
    statement = stop > 0 ? tail.slice(0, stop) : tail;
    break;
  }

  if (!statement) return null;

  const wanted = [
    { key: "sales", re: /^Sales$/i },
    { key: "interest", re: /^Interest income(?:,\s*net)?$/i },
    { key: "dividend", re: /^Dividend income$/i },
    { key: "conversion", re: /^Change in fair value of conversion option liability$/i },
    { key: "warrants", re: /^Change in fair value of warrants liabilities?$/i },
    { key: "fairValue", re: /^Change in fair value of .* liability$/i },
    { key: "gain", re: /^Gain (?:on|from)\b/i }
  ];

  const components = [];
  const seen = new Set();
  const lines = statement.split(/\r?\n/).map(x => String(x || "").trim()).filter(Boolean);

  for (const line of lines) {
    const cells = line.split("|").map(x => x.trim()).filter(Boolean);
    if (!cells.length) continue;

    const label = cells[0].replace(/^FEMASYS INC\.\s+/i, "").trim();

    for (const item of wanted) {
      if (!item.re.test(label)) continue;

      let value = null;
      for (const cell of cells.slice(1)) {
        const token = cell.match(/^\$?\s*\(?[0-9][0-9,]*(?:\.\d+)?\)?$/);
        if (!token) continue;
        const n = parseNumber(token[0]);
        if (Number.isFinite(n)) {
          value = Math.abs(n);
          break;
        }
      }

      if (value != null && value > 0 && !seen.has(value)) {
        seen.add(value);
        components.push({ key: item.key, value });
      }
      break;
    }
  }

  // Final table-cell fallback. Some SEC HTML is flattened without
  // reliable newline boundaries, but the "|" cell separators remain.
  const cellPatterns = [
    { key: "sales", re: /Sales\s*(?:\|\s*){1,6}\$?\s*(?:\|\s*)*([0-9][0-9,]*(?:\.\d+)?)/i },
    { key: "interest", re: /Interest income(?:,\s*net)?\s*(?:\|\s*){1,6}\$?\s*(?:\|\s*)*([0-9][0-9,]*(?:\.\d+)?)/i },
    { key: "conversion", re: /Change in fair value of conversion option liability\s*(?:\|\s*){1,6}\$?\s*(?:\|\s*)*([0-9][0-9,]*(?:\.\d+)?)/i },
    { key: "warrants", re: /Change in fair value of warrants liabilities?\s*(?:\|\s*){1,6}\$?\s*(?:\|\s*)*([0-9][0-9,]*(?:\.\d+)?)/i },
    { key: "dividend", re: /Dividend income\s*(?:\|\s*){1,6}\$?\s*(?:\|\s*)*([0-9][0-9,]*(?:\.\d+)?)/i }
  ];

  for (const item of cellPatterns) {
    if (components.some(x => x.key === item.key)) continue;
    const hit = statement.match(item.re);
    if (!hit) continue;
    const value = parseNumber(hit[1]);
    if (Number.isFinite(value) && value > 0 && !seen.has(value)) {
      seen.add(value);
      components.push({ key: item.key, value });
    }
  }

  if (!components.length) return null;

  return {
    total: components.reduce((sum, x) => sum + x.value, 0),
    interest: components.find(x => x.key === "interest")?.value ?? null,
    components
  };
}

function findProhibitedIncome(text, usgaap, filing) {
  const parsed = extractSecCurrentQuarterIncomeComponents(text);
  if (parsed?.interest != null) {
    return {
      value: Math.abs(parsed.interest),
      label: "Interest income",
      source: "SEC Statement of Operations — current quarter"
    };
  }

  const raw = String(text || "");
  const attributable = raw.match(
    /Other income \(expenses\), net,[\s\S]{0,900}?is attributable to[\s\S]{0,500}?interest income(?: of)?\s*\$?\s*([0-9][0-9,]*(?:\.\d+)?)/i
  );

  if (attributable) {
    const value = parseNumber(attributable[1]);
    if (Number.isFinite(value)) {
      return {
        value: Math.abs(value),
        label: "Interest income",
        source: "SEC MD&A — current-quarter interest income"
      };
    }
  }

  const section = getOperationsSection(raw);
  const value = section
    ? findLabeledFinancialValue(section, /interest income(?:,?\s+net)?/i)
    : null;

  return value != null
    ? {
        value: Math.abs(value),
        label: "Interest income",
        source: "SEC Statement of Operations"
      }
    : null;
}

function extractFlattenedIncomeComponents(text) {
  const raw = String(text || "");
  const labels = [
    { key: "sales", re: /(?:^|\s)(?:sales|revenue|revenues|net sales)\b/i },
    { key: "interest", re: /(?:^|\s)interest income(?:,?\s+net)?\b/i },
    { key: "dividend", re: /(?:^|\s)dividend income\b/i },
    { key: "conversion", re: /(?:^|\s)change in fair value of conversion option liability\b/i },
    { key: "warrants", re: /(?:^|\s)change in fair value of warrants? liabilities?\b/i },
    { key: "fairValue", re: /(?:^|\s)change in fair value of [^\n]{0,100} liability\b/i },
    { key: "gain", re: /(?:^|\s)gain (?:on|from)\b/i }
  ];

  const result = {};
  for (const item of labels) {
    const m = raw.match(item.re);
    if (!m) continue;

    const tail = raw.slice(m.index + m[0].length, m.index + m[0].length + 700);
    const nums = tail.match(/(?:\$\s*)?\(?[0-9][0-9,]*(?:\.\d+)?\)?/g) || [];

    for (const token of nums) {
      const n = parseNumber(token);
      if (Number.isFinite(n) && n >= 0) {
        result[item.key] = Math.abs(n);
        break;
      }
    }
  }
  return Object.values(result).filter(v => v > 0);
}

function extractCurrentQuarterGrossPositiveIncome(text) {
  const raw = String(text || "");

  // Work from the actual operations statement when possible. If the SEC
  // markup is flattened differently, fall back to a bounded text window
  // around the first real statement.
  let source = getPrimaryOperationsStatementSection(raw);

  if (!source) {
    const m = raw.match(/Statements of Operations(?: and Comprehensive (?:Loss|Income))?/i);
    if (m) {
      const tail = raw.slice(m.index);
      const stop = tail.search(/Net loss attributable to common stockholders|Net income attributable to common stockholders/i);
      source = stop > 0 ? tail.slice(0, stop) : tail.slice(0, 60000);
    }
  }

  if (!source) return null;

  const lines = source.split(/\r?\n/).map(normalizeLine).filter(Boolean);
  const values = [];
  const labels = [
    /^Sales(?!\s+and\s+marketing)\b/i,
    /^(?:Revenue(?:s)?|Net Sales)\b/i,
    /^Interest Income(?:,?\s+Net)?\b/i,
    /^Dividend Income\b/i,
    /^Change in Fair Value of Conversion Option Liability\b/i,
    /^Change in Fair Value of Warrants? Liabilities?\b/i,
    /^Change in Fair Value of .* Liability\b/i,
    /^Gain (?:on|from)\b/i
  ];

  for (const line of lines) {
    for (const label of labels) {
      if (!label.test(line)) continue;

      const after = line.replace(label, " ");
      const nums = after.match(/\(?[0-9][0-9,]*(?:\.\d+)?\)?/g) || [];
      if (!nums.length) break;

      const value = Math.abs(parseNumber(nums[0]));
      if (Number.isFinite(value) && value > 0 && !values.includes(value)) {
        values.push(value);
      }
      break;
    }
  }

  // FEMY and similar SEC tables should contain sales + positive other-income
  // rows. Do not fall back to interest income alone when these rows exist.
  const total = values.reduce((sum, v) => sum + v, 0);
  return total > 0 ? total : null;
}
function extractCurrentQuarterPositiveIncome(text) {
  const raw = String(text || "");
  const startMatch = raw.match(/Condensed (?:Consolidated )?Statements of Operations(?: and Comprehensive (?:Loss|Income))?/i);
  if (!startMatch) return null;

  const tail = raw.slice(startMatch.index);
  const endMatch = tail.match(/(?:Net loss attributable to common stockholders|Net income attributable to common stockholders)/i);
  const statement = endMatch ? tail.slice(0, endMatch.index) : tail.slice(0, 50000);
  const lines = statement.split(/\r?\n/).map(normalizeLine).filter(Boolean);

  const labels = [
    /^Sales\b/i,
    /^Revenue(?:s)?\b/i,
    /^Net sales\b/i,
    /^Interest income(?:,?\s+net)?\b/i,
    /^Dividend income\b/i,
    /^Change in fair value of conversion option liability\b/i,
    /^Change in fair value of warrants? liabilities?\b/i,
    /^Change in fair value of .* liability\b/i,
    /^Gain on\b/i,
    /^Gain from\b/i
  ];

  const values = [];
  for (const line of lines) {
    for (const label of labels) {
      if (!label.test(line)) continue;
      const v = firstFinancialValueAfterLabel(line, label);
      if (v != null && v > 0 && !values.includes(v)) values.push(v);
      break;
    }
  }

  const total = values.reduce((sum, v) => sum + v, 0);
  return total > 0 ? total : null;
}

function findTotalIncome(text, usgaap, filing) {
  const parsed = extractSecCurrentQuarterIncomeComponents(text);

  // Authoritative path: once the current-quarter SEC statement is parsed,
  // never allow a later generic fallback to replace its denominator.
  if (parsed?.total > 0) {
    return {
      value: parsed.total,
      source: "SEC Statement of Operations — current-quarter gross positive income components",
      components: parsed.components
    };
  }

  // Fallback for filings whose SEC format does not expose a parseable
  // Statement of Operations table.
  const raw = String(text || "");
  const ops = getOperationsSection(raw);

  if (ops && /Interest income, net/i.test(ops) && /Total other income, net/i.test(ops)) {
    const interest = findLabeledFinancialValue(ops, /Interest income, net/i);
    if (interest != null && Math.abs(interest) > 0) {
      return {
        value: Math.abs(interest),
        source: "SEC Statement of Operations — current-quarter gross positive income"
      };
    }
  }

  const statementGross = extractCurrentQuarterPositiveIncome(raw);
  if (statementGross != null) {
    return {
      value: statementGross,
      source: "SEC current-quarter Statement of Operations"
    };
  }

  return null;
}

function findLabeledFinancialValue(text, labelRegex) {
  const raw = String(text || "");
  // Preserve all regex flags (especially m) so row labels anchored with ^
  // can be found after the SEC HTML has been flattened into one section.
  const flags = labelRegex.flags.includes("i") ? labelRegex.flags : labelRegex.flags + "i";
  const re = new RegExp(labelRegex.source + "[\\s\\S]{0,260}", flags);
  const m = raw.match(re);
  if (!m) return null;

  const labelMatch = m[0].match(labelRegex);
  if (!labelMatch) return null;

  const tail = m[0].slice(labelMatch.index + labelMatch[0].length);
  const tokens = tail.match(/(?:—|–|\$?\s*\(?[0-9][0-9,]*(?:\.\d+)?\)?)/g) || [];

  for (const token of tokens) {
    const t = String(token).trim();
    if (t === "—" || t === "–") return 0;
    const n = parseNumber(t);
    if (Number.isFinite(n)) return Math.abs(n);
  }
  return null;
}

function firstFinancialValueAfterLabel(line, labelRegex) {
  const rest = String(line || "").replace(labelRegex, " ");
  // Preserve em-dash as zero. Ignore dates/years that can appear later.
  const tokenRe = /(?:—|–|\$?\s*\(?[0-9][0-9,]*(?:\.\d+)?\)?)/g;
  const tokens = rest.match(tokenRe) || [];
  for (const raw of tokens) {
    const t = String(raw).trim();
    if (t === "—" || t === "–" || t === "-") return 0;
    const n = parseNumber(t);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function inferLineScale(lines, index) {
  const start = Math.max(0, index - 40);
  for (let i = index; i >= start; i--) {
    if (/\bin thousands\b|\bin thousands,|\(in thousands\b/i.test(lines[i])) return 1000;
    if (/\bin millions\b|\(in millions\b/i.test(lines[i])) return 1000000;
  }
  return 1;
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
  const headers = {
    "User-Agent": "Mozilla/5.0",
    "Accept": "application/json,text/plain,*/*",
    "Accept-Language": "en-US,en;q=0.9",
    "Origin": "https://www.nasdaq.com",
    "Referer": "https://www.nasdaq.com/market-activity/stocks/screener"
  };

  // NTCL and CRIS are Nasdaq-listed, so avoid downloading three full
  // exchange screeners on every request.
  try {
    const url =
      "https://api.nasdaq.com/api/screener/stocks" +
      "?tableonly=true&limit=5000&offset=0&exchange=NASDAQ&download=true";

    const response = await fetch(url, { headers });
    if (response.ok) {
      const json = await response.json();
      const rows = Array.isArray(json?.data?.rows) ? json.data.rows : [];
      const q = rows.find(x => String(x.symbol || "").trim().toUpperCase() === symbol);
      if (q) {
        const price = parseMarketNumber(q.lastsale);
        const marketCap = parseMarketNumber(q.marketCap);
        const shares = parseMarketNumber(q.sharesOutstanding ?? q.sharesoutstanding);
        return {
          price: Number.isFinite(price) && price > 0 ? price : null,
          marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null,
          shares: Number.isFinite(shares) && shares > 0 ? shares : null,
          source: "Nasdaq Screener"
        };
      }
    }
  } catch (_) {}

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

    const safePrice = Number.isFinite(price) && price > 0 ? price : null;
    const safeShares = Number.isFinite(shares) && shares > 0 ? shares : null;
    const safeMarketCap =
      Number.isFinite(marketCap) && marketCap > 0
        ? marketCap
        : (safePrice && safeShares ? safePrice * safeShares : null);

    return {
      price: safePrice,
      marketCap: safeMarketCap,
      shares: safeShares,
      source: "Yahoo Finance"
    };
  } catch (_) {
    return null;
  }
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
      // Preserve SEC table cell and row boundaries. This is important because
      // the first numeric cell is the current-quarter value.
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/td>/gi, " | ")
      .replace(/<\/th>/gi, " | ")
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

function parseMarketNumber(raw) {
  if (raw == null) return null;
  if (typeof raw === "number") return Number.isFinite(raw) ? raw : null;

  let s = String(raw).trim().replace(/[$,\s]/g, "");
  if (!s || s === "-" || s === "—" || s.toLowerCase() === "n/a") return null;

  let multiplier = 1;
  const suffix = s.slice(-1).toUpperCase();
  if (suffix === "K") multiplier = 1e3;
  else if (suffix === "M") multiplier = 1e6;
  else if (suffix === "B") multiplier = 1e9;
  else if (suffix === "T") multiplier = 1e12;

  if (multiplier !== 1) s = s.slice(0, -1);
  const n = Number(s.replace(/\((.*)\)/, "-$1"));
  return Number.isFinite(n) ? n * multiplier : null;
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
