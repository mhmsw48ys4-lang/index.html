function response(statusCode, body, headers) {
  return {
    statusCode,
    headers,
    body: JSON.stringify(body)
  };
}

const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: HEADERS, body: "" };
  }

  const symbol = String(event.queryStringParameters?.symbol || "").trim().toUpperCase();
  if (!symbol) return response(400, { error: "اكتب رمز السهم" }, HEADERS);

  try {
    const secHeaders = {
      "User-Agent": "khald-pivot-scanner contact@example.com",
      "Accept": "text/html,application/json,text/plain,*/*"
    };

    const tickers = await getJson("https://www.sec.gov/files/company_tickers.json", secHeaders);
    const company = Object.values(tickers || {}).find(
      x => String(x.ticker || "").toUpperCase() === symbol
    );

    if (!company) {
      return response(404, { error: "لم نجد الشركة في سجلات SEC" }, HEADERS);
    }

    const cik = String(company.cik_str).padStart(10, "0");
    const submissions = await getJson(
      "https://data.sec.gov/submissions/CIK" + cik + ".json",
      secHeaders
    );

    const filing = latestFiling(submissions?.filings?.recent || {});
    if (!filing) {
      return response(200, {
        symbol,
        status: "insufficient",
        reason: "لم نجد آخر إفصاح مالي مناسب في SEC",
        source: "SEC EDGAR"
      }, HEADERS);
    }

    const base =
      "https://www.sec.gov/Archives/edgar/data/" +
      String(Number(cik)) + "/" +
      String(filing.accession).replace(/-/g, "") + "/";

    const primaryUrl = filing.primaryDocument
      ? base + filing.primaryDocument
      : base + filing.accession + ".txt";

    let filingHtml;
    try {
      filingHtml = await getText(primaryUrl, secHeaders);
    } catch (_) {
      filingHtml = await getText(
        base + filing.accession + ".txt",
        secHeaders
      );
    }

    const rows = extractRows(filingHtml);
    const text = htmlToText(filingHtml);

    const market = await getMarket(symbol);
    const price = market?.price ?? null;

    let shares = market?.shares ?? null;
    if (!(shares > 0)) shares = extractShares(text);

    let marketCap = market?.marketCap ?? null;
    if (!(marketCap > 0) && price > 0 && shares > 0) {
      marketCap = price * shares;
    }

    const sic = String(submissions.sic || "");
    const sicDescription = String(submissions.sicDescription || "");
    const companyName = String(submissions.name || company.name || "");

    const blockedWords = [
      "bank", "banking", "insurance", "casino", "gambling",
      "tobacco", "cigarette", "cannabis", "marijuana",
      "liquor", "distillery", "brewery", "beer", "wine",
      "pork", "swine", "adult entertainment"
    ];

    const activityBlocked = blockedWords.some(
      w => (companyName + " " + sicDescription).toLowerCase().includes(w)
    );

    if (activityBlocked) {
      return response(200, {
        symbol,
        status: "rejected_activity",
        activity: companyName,
        sic,
        sicDescription,
        filing: publicFiling(filing),
        marketCap,
        currentPrice: price,
        sharesOutstanding: shares,
        marketCapSource: market?.source || null
      }, HEADERS);
    }

    const debt = findDebt(rows, text);
    const deposits = findDeposits(rows, text);
    const interest = findRowValue(rows, /^interest income(?:,?\s+net)?$/i);
    const sales = findRowValue(rows, /^(?:sales|net sales|revenue|revenues)$/i);

    const prohibitedIncome = interest != null
      ? { value: Math.abs(interest), label: "Interest income", source: "SEC Statement of Operations — current quarter" }
      : hasOperationsData(rows, text)
        ? { value: 0, label: "No interest income disclosed", source: "SEC Statement of Operations — no interest income line disclosed" }
        : null;

    const totalIncome = sales != null && sales > 0
      ? { value: Math.abs(sales), source: "SEC Statement of Operations — current-quarter sales/revenue" }
      : null;

    const debtRatio = debt && marketCap > 0
      ? (debt.value / marketCap) * 100
      : null;

    const depositsRatio = deposits && marketCap > 0
      ? (deposits.value / marketCap) * 100
      : null;

    const prohibitedRatio = prohibitedIncome && totalIncome && totalIncome.value > 0
      ? (prohibitedIncome.value / totalIncome.value) * 100
      : null;

    const checks = {
      debt: {
        numerator: debt?.value ?? null,
        denominator: marketCap,
        ratio: debtRatio,
        limit: 30,
        pass: debtRatio == null ? null : debtRatio <= 30,
        source: debt?.source || null
      },
      interestTakingDeposits: {
        numerator: deposits?.value ?? null,
        denominator: marketCap,
        ratio: depositsRatio,
        limit: 30,
        pass: depositsRatio == null ? null : depositsRatio <= 30,
        source: deposits?.source || null
      },
      prohibitedIncome: {
        numerator: prohibitedIncome?.value ?? null,
        denominator: totalIncome?.value ?? null,
        ratio: prohibitedRatio,
        limit: 5,
        pass: prohibitedRatio == null ? null : prohibitedRatio <= 5,
        source: prohibitedIncome?.source || null,
        incomeSource: prohibitedIncome?.label || null
      }
    };

    const complete =
      marketCap > 0 &&
      checks.debt.pass !== null &&
      checks.interestTakingDeposits.pass !== null &&
      checks.prohibitedIncome.pass !== null;

    const status = !complete
      ? "insufficient"
      : Object.values(checks).every(x => x.pass)
        ? "compliant"
        : "rejected_financial";

    return response(200, {
      symbol,
      status,
      activity: companyName,
      sic,
      sicDescription,
      filing: publicFiling(filing),
      marketCap,
      currentPrice: price,
      sharesOutstanding: shares,
      marketCapSource: market?.source || null,
      checks,
      note: complete
        ? "تم استخراج البيانات مباشرة من أحدث إفصاح SEC"
        : "بعض البيانات لم يمكن تحديدها بثقة من أحدث إفصاح"
    }, HEADERS);
  } catch (error) {
    return response(500, {
      error: "تعذر تشغيل الفحص الشرعي",
      details: String(error?.message || error)
    }, HEADERS);
  }
};

function latestFiling(recent) {
  const forms = recent.form || [];
  const accessions = recent.accessionNumber || [];
  const docs = recent.primaryDocument || [];
  const filingDates = recent.filingDate || [];
  const reportDates = recent.reportDate || [];

  const candidates = [];
  for (let i = 0; i < forms.length; i++) {
    if (!["10-Q", "10-K", "20-F", "40-F"].includes(forms[i])) continue;
    candidates.push({
      form: forms[i],
      accession: accessions[i],
      primaryDocument: docs[i],
      filingDate: filingDates[i],
      reportDate: reportDates[i]
    });
  }

  candidates.sort((a, b) =>
    String(b.reportDate || b.filingDate || "").localeCompare(
      String(a.reportDate || a.filingDate || "")
    )
  );

  return candidates[0] || null;
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

function extractRows(html) {
  const source = String(html || "");
  const rows = [];
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;

  while ((m = re.exec(source))) {
    const cells = [];
    const cellRe = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    let c;

    while ((c = cellRe.exec(m[1]))) {
      const value = decodeHtml(
        c[1]
          .replace(/<br\s*\/?>/gi, " ")
          .replace(/<[^>]+>/g, " ")
      )
        .replace(/\u00a0/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      if (value) cells.push(value);
    }

    if (cells.length >= 2) {
      rows.push({
        label: cells[0],
        cells,
        values: cells.slice(1).map(parseMoney).filter(v => v !== null)
      });
    }
  }

  return rows;
}

function findRowValue(rows, labelRegex) {
  for (const row of rows) {
    if (labelRegex.test(row.label) && row.values.length) {
      return row.values[0];
    }
  }
  return null;
}

function findDebt(rows, text) {
  const labels = [
    /^(?:current portion of\s+)?convertible notes? payable(?:,?\s+net)?$/i,
    /^(?:current portion of\s+)?convertible debt$/i,
    /^(?:current portion of\s+)?notes payable(?:,?\s+net)?$/i,
    /^(?:current portion of\s+)?bank borrowings?$/i,
    /^(?:current portion of\s+)?term loans?$/i,
    /^(?:current portion of\s+)?loans payable$/i,
    /^(?:current portion of\s+)?long[- ]term borrowings?$/i,
    /^(?:current portion of\s+)?short[- ]term borrowings?$/i,
    /^senior notes?(?:,?\s+net)?$/i,
    /^interest[- ]bearing debt$/i
  ];

  const found = [];
  for (const row of rows) {
    if (!labels.some(re => re.test(row.label))) continue;
    if (!row.values.length) continue;
    found.push({ value: Math.abs(row.values[0]), label: row.label });
  }

  if (found.length) {
    const seen = new Set();
    const unique = found.filter(x => {
      const key = x.label + "|" + x.value;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    return {
      value: unique.reduce((s, x) => s + x.value, 0),
      source: unique.map(x => x.label).slice(0, 6).join(" | ")
    };
  }

  if (/\btotal assets\b/i.test(text) && /\btotal liabilities\b/i.test(text)) {
    return {
      value: 0,
      source: "SEC balance sheet — no interest-bearing debt disclosed"
    };
  }

  return null;
}

function findDeposits(rows, text) {
  const re = /interest[- ]bearing deposits?|interest[- ]taking deposits?/i;

  for (const row of rows) {
    if (!re.test(row.label) || !row.values.length) continue;
    return {
      value: Math.abs(row.values[0]),
      source: row.label
    };
  }

  if (/\btotal assets\b/i.test(text) && /\btotal liabilities\b/i.test(text)) {
    return {
      value: 0,
      source: "SEC balance sheet — no interest-bearing deposits disclosed"
    };
  }

  return null;
}

function hasOperationsData(rows, text) {
  const hasSales = rows.some(r => /^(?:sales|net sales|revenue|revenues)$/i.test(r.label));
  const hasLoss = rows.some(r => /^net loss(?: attributable.*)?$/i.test(r.label));
  return hasSales && hasLoss || (
    /\b(?:sales|revenue|revenues)\b/i.test(text) &&
    /\bnet loss\b/i.test(text)
  );
}

function extractShares(text) {
  const patterns = [
    /([0-9][0-9,]+)\s+(?:common\s+)?shares?\s+(?:issued\s+and\s+)?outstanding\s+as\s+of\s+[A-Z][a-z]+\s+\d{1,2},\s+20\d{2}/i,
    /([0-9][0-9,]+)\s+shares?[^\n]{0,120}?outstanding\s+as\s+of\s+[A-Z][a-z]+\s+\d{1,2},\s+20\d{2}/i
  ];

  for (const re of patterns) {
    const m = String(text || "").match(re);
    if (!m) continue;
    const n = parseMoney(m[1]);
    if (n > 1000) return n;
  }

  return null;
}

async function getMarket(symbol) {
  try {
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
      encodeURIComponent(symbol);

    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0",
        "Accept": "application/json"
      }
    });

    if (!res.ok) return null;

    const q = (await res.json())?.quoteResponse?.result?.[0];
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

async function getJson(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error("تعذر جلب بيانات SEC");
  return res.json();
}

async function getText(url, headers) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error("تعذر جلب ملف الإفصاح المالي من SEC");
  return res.text();
}

function htmlToText(html) {
  return decodeHtml(
    String(html || "")
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/\u00a0/g, " ")
      .replace(/\s+/g, " ")
  );
}

function parseMoney(value) {
  let s = String(value ?? "").trim();
  if (!s || s === "-" || s === "—" || s === "–") return null;

  const negative = /^\(.*\)$/.test(s);
  s = s.replace(/[$,%(),\s]/g, "").replace(/,/g, "");

  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

function decodeHtml(value) {
  return String(value || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">");
}
