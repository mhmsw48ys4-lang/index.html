const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};

const SEC_HEADERS = {
  "User-Agent": "khald-pivot-scanner contact@example.com",
  "Accept": "application/json,text/plain,*/*"
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: CORS, body: "" };
  }

  const symbol = String(event.queryStringParameters?.symbol || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9.\-]{1,12}$/.test(symbol)) {
    return json(400, { error: "رمز السهم غير صحيح" });
  }

  try {
    // 1) Resolve ticker -> CIK.
    const tickerMap = await getJson(
      "https://www.sec.gov/files/company_tickers.json"
    );

    const company = Object.values(tickerMap || {}).find(
      x => String(x.ticker || "").toUpperCase() === symbol
    );

    if (!company) {
      return json(404, {
        symbol,
        status: "insufficient",
        reason: "لم نجد رمز السهم في SEC EDGAR"
      });
    }

    const cik = String(company.cik_str).padStart(10, "0");

    // 2) Get filing metadata and XBRL facts.
    const [submissions, facts] = await Promise.all([
      getJson("https://data.sec.gov/submissions/CIK" + cik + ".json"),
      getJson("https://data.sec.gov/api/xbrl/companyfacts/CIK" + cik + ".json")
    ]);

    const filing = latestFiling(submissions?.filings?.recent || {});
    const activity = String(
      submissions?.name || company?.title || ""
    );
    const sic = String(submissions?.sic || "");
    const sicDescription = String(submissions?.sicDescription || "");

    const market = await getMarket(symbol);
    const price = market?.price ?? null;
    const shares = market?.shares ?? extractSharesFromFacts(facts);
    const marketCap =
      market?.marketCap ??
      (price > 0 && shares > 0 ? price * shares : null);

    // 3) Activity screen first.
    const blocked = [
      "bank", "banking", "insurance", "casino", "gambling",
      "tobacco", "cigarette", "cannabis", "marijuana",
      "liquor", "distillery", "brewery", "beer", "wine",
      "pork", "swine", "adult entertainment"
    ];

    const activityText = (activity + " " + sicDescription).toLowerCase();
    if (blocked.some(word => activityText.includes(word))) {
      return json(200, {
        symbol,
        status: "rejected_activity",
        activity,
        sic,
        sicDescription,
        filing: publicFiling(filing),
        marketCap,
        currentPrice: price,
        sharesOutstanding: shares,
        source: "SEC EDGAR + Yahoo Finance"
      });
    }

    // 4) Read XBRL facts. No environment variables and no HTML-table guessing.
    let filingRows = [];
    if (filing?.accession) {
      try {
        const base = "https://www.sec.gov/Archives/edgar/data/" + String(Number(cik)) + "/" + String(filing.accession).replace(/-/g, "") + "/";
        const primary = filing.primaryDocument ? base + filing.primaryDocument : base + filing.accession + ".txt";
        let html;
        try { html = await getText(primary); } catch (_) { html = await getText(base + filing.accession + ".txt"); }
        filingRows = extractRows(html);
      } catch (_) {}
    }

    const debt = findFact(facts, [
      "ConvertibleNotesPayable","ConvertibleDebt","LongTermDebtCurrent",
      "LongTermDebtNoncurrent","LongTermDebt","ShortTermBorrowings",
      "NotesPayable","DebtCurrent","DebtNoncurrent","Debt"
    ], { balance: true }) || findDebtFactByKeywords(facts) || findDebtInRows(filingRows);

    const depositsFact = findFact(facts, [
      "InterestBearingDeposits","InterestBearingDepositsAtBanks",
      "InterestBearingDepositsLiability"
    ], { balance: true });

    const deposits = depositsFact || {
      value: 0,
      label: "لا يوجد بند ودائع تأخذ فائدة مفصح عنه",
      source: "SEC XBRL + latest SEC filing — no interest-bearing deposits line found"
    };

    // Prefer the actual filing table. This prevents a generic "financing income, net"
    // XBRL tag from being mistaken for pure interest income.
    const interest = findInterestInRows(filingRows);

    const sales = findFact(facts, [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
      "SalesRevenueNet","SalesRevenueGoodsNet","Revenue"
    ], { flow: true, quarter: true }) || findSalesInRows(filingRows);

    const debtRatio = debt?.value != null && marketCap > 0
      ? debt.value / marketCap * 100
      : null;

    const depositsRatio = deposits?.value != null && marketCap > 0
      ? deposits.value / marketCap * 100
      : null;

    // AAOIFI SS21: prohibited-component income must be compared with
    // TOTAL income, and if the source is not properly disclosed we must
    // exercise due care rather than assume the missing amount is zero.
    // For the 5% mixed/prohibited-income screen, never use net income,
    // operating loss, or pre-tax loss as the denominator. The denominator is
    // the company's reported operating revenue/sales for the same period.
    const totalIncome = sales;

    const prohibitedComponents = findProhibitedIncomeComponents(
      facts,
      filingRows,
      interest
    );

    const prohibitedNumerator =
      prohibitedComponents.length
        ? prohibitedComponents.reduce((sum, x) => sum + x.value, 0)
        : null;

    const prohibitedRatio =
      prohibitedNumerator != null &&
      totalIncome?.value > 0
        ? prohibitedNumerator / totalIncome.value * 100
        : null;

    // We only allow a definitive pass/fail when the filing explicitly
    // provides enough information to identify the prohibited-income
    // components. Missing disclosure is NOT treated as zero.
    const prohibitedIncomeComplete =
      prohibitedComponents.length > 0 &&
      !!totalIncome &&
      prohibitedComponents.every(x => x.explicit === true);

    const interestCheck = prohibitedComponents.length
      ? {
          value: prohibitedNumerator,
          label: prohibitedComponents.map(x => x.label).join(" + "),
          source: prohibitedComponents.map(x => x.source).join(" | ")
        }
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
        numerator: deposits?.value ?? 0,
        denominator: marketCap,
        ratio: depositsRatio,
        limit: 30,
        pass: depositsRatio == null ? null : depositsRatio <= 30,
        source: deposits?.source || "SEC XBRL — no interest-bearing deposits fact found"
      },
      prohibitedIncome: {
        numerator: interestCheck?.value ?? null,
        denominator: sales?.value ?? null,
        ratio: prohibitedRatio,
        limit: 5,
        pass: !prohibitedIncomeComplete
          ? null
          : (prohibitedRatio == null ? null : prohibitedRatio <= 5),
        source: interestCheck?.source || null,
        incomeSource: interestCheck?.label || null,
        denominatorSource: totalIncome?.label || null,
        dataComplete: prohibitedIncomeComplete
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

    return json(200, {
      symbol,
      status,
      activity,
      sic,
      sicDescription,
      filing: publicFiling(filing),
      marketCap,
      currentPrice: price,
      sharesOutstanding: shares,
      marketCapSource: market?.source || null,
      checks,
      dataMethod: "SEC XBRL companyfacts",
      note: complete
        ? "تم الفحص من بيانات SEC XBRL دون الحاجة إلى متغيرات بيئية"
        : "بعض بيانات XBRL غير متوفرة بما يكفي للحسم"
    });
  } catch (error) {
    return json(500, {
      error: "تعذر تشغيل الفحص الشرعي",
      details: String(error?.message || error),
      source: "SEC EDGAR"
    });
  }
};

function json(statusCode, body) {
  return {
    statusCode,
    headers: CORS,
    body: JSON.stringify(body)
  };
}

function latestFiling(recent) {
  const forms = recent.form || [];
  const accessions = recent.accessionNumber || [];
  const docs = recent.primaryDocument || [];
  const filingDates = recent.filingDate || [];
  const reportDates = recent.reportDate || [];

  let best = null;

  for (let i = 0; i < forms.length; i++) {
    if (!["10-Q", "10-K", "20-F", "40-F"].includes(forms[i])) continue;

    const candidate = {
      form: forms[i],
      accession: accessions[i] || null,
      primaryDocument: docs[i] || null,
      filingDate: filingDates[i] || null,
      reportDate: reportDates[i] || null
    };

    const key = String(candidate.reportDate || candidate.filingDate || "");
    const bestKey = String(best?.reportDate || best?.filingDate || "");

    if (!best || key > bestKey) best = candidate;
  }

  return best;
}

function publicFiling(filing) {
  if (!filing) return null;
  return {
    form: filing.form,
    filingDate: filing.filingDate,
    reportDate: filing.reportDate,
    accession: filing.accession,
    primaryDocument: filing.primaryDocument
  };
}

function findFact(facts, names, options) {
  const namespaces = facts?.facts || {};
  const candidates = [];

  for (const [namespace, tags] of Object.entries(namespaces)) {
    for (const [tagName, tag] of Object.entries(tags || {})) {
      if (!names.some(name => tagName.toLowerCase() === name.toLowerCase())) {
        continue;
      }

      for (const unitValues of Object.values(tag.units || {})) {
        for (const item of unitValues || []) {
          if (!item || item.val == null) continue;
          if (options?.quarter && !isQuarterFact(item)) continue;

          const value = Number(item.val);
          if (!Number.isFinite(value)) continue;

          candidates.push({
            value: Math.abs(value),
            tag: namespace + ":" + tagName,
            form: item.form || "",
            filed: item.filed || "",
            end: item.end || "",
            start: item.start || "",
            fp: item.fp || "",
            frame: item.frame || ""
          });
        }
      }
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const end = String(b.end).localeCompare(String(a.end));
    if (end) return end;
    return String(b.filed).localeCompare(String(a.filed));
  });

  const chosen = candidates[0];

  return {
    value: chosen.value,
    label: chosen.tag,
    source:
      "SEC XBRL — " +
      chosen.tag +
      (chosen.end ? " through " + chosen.end : "")
  };
}

function findDebtFactByKeywords(facts) {
  const namespaces = facts?.facts || {};
  const candidates = [];

  for (const [namespace, tags] of Object.entries(namespaces)) {
    for (const [tagName, tag] of Object.entries(tags || {})) {
      const n = String(tagName).toLowerCase().replace(/[^a-z0-9]/g, "");
      const strong =
        n.includes("convertiblenotespayable") ||
        n.includes("convertibledebt") ||
        n.includes("notespayable") ||
        n.includes("shorttermborrow") ||
        n.includes("longtermdebt") ||
        n === "debt" ||
        n.includes("debtcurrent") ||
        n.includes("debtnoncurrent");

      if (!strong) continue;

      for (const unitValues of Object.values(tag.units || {})) {
        for (const item of unitValues || []) {
          if (!item || item.val == null || item.start) continue;
          const value = Number(item.val);
          if (!Number.isFinite(value) || value === 0) continue;
          candidates.push({
            value: Math.abs(value),
            tag: namespace + ":" + tagName,
            filed: item.filed || "",
            end: item.end || ""
          });
        }
      }
    }
  }

  if (!candidates.length) return null;
  candidates.sort((a,b) => {
    const end = String(b.end).localeCompare(String(a.end));
    return end || String(b.filed).localeCompare(String(a.filed));
  });

  const chosen = candidates[0];
  return {
    value: chosen.value,
    label: chosen.tag,
    source: "SEC XBRL keyword fallback — " + chosen.tag +
      (chosen.end ? " through " + chosen.end : "")
  };
}

function isQuarterFact(item) {
  if (!item.start || !item.end) return true;

  const start = new Date(item.start + "T00:00:00Z").getTime();
  const end = new Date(item.end + "T00:00:00Z").getTime();

  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;

  const days = (end - start) / 86400000;

  // Quarterly facts are normally about 70–110 days.
  return days >= 60 && days <= 130;
}

function extractSharesFromFacts(facts) {
  const usgaap = facts?.facts?.["dei"] || {};
  const tag =
    usgaap.EntityCommonStockSharesOutstanding ||
    usgaap.EntityCommonStockSharesOutstandingMember;

  if (!tag) return null;

  const values = Object.values(tag.units || {}).flat();
  const valid = values
    .filter(x => Number.isFinite(Number(x.val)))
    .sort((a, b) => String(b.end || b.filed || "").localeCompare(String(a.end || a.filed || "")));

  return valid.length ? Number(valid[0].val) : null;
}



function extractRows(html) {
  const rows = [];
  const documentText = String(html || "");
  const scale = /(?:U\.S\.\s*dollars?\s+in\s+thousands|\(\s*in\s+thousands\b|\bin\s+thousands\b)/i.test(documentText)
    ? 1000
    : 1;
  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while ((m = re.exec(String(html || "")))) {
    const cells = [];
    const cr = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    let c;
    while ((c = cr.exec(m[1]))) {
      const v = decodeHtml(c[1].replace(/<br\s*\/?>/gi, " ").replace(/<[^>]+>/g, " "))
        .replace(/\u00a0/g, " ").replace(/\s+/g, " ").trim();
      if (v) cells.push(v);
    }
    if (cells.length >= 2) rows.push({
      label: cells[0],
      values: cells.slice(1)
      .map(parseMoney)
      .filter(v => v !== null)
      .map(v => v * scale)
    });
  }
  return rows;
}

function findDebtInRows(rows) {
  const re = /(?:convertible\s+(?:notes?|debt)|notes?\s+payable|term\s+loans?|loans?\s+payable|long[- ]term\s+borrowings?|short[- ]term\s+borrowings?|senior\s+notes?|interest[- ]bearing\s+debt)/i;
  const found = [];
  for (const row of rows) {
    if (re.test(row.label) && row.values.length) found.push({label: row.label, value: Math.abs(row.values[0])});
  }
  if (!found.length) return null;
  const seen = new Set();
  const unique = found.filter(x => {
    const k = x.label + "|" + x.value;
    if (seen.has(k)) return false;
    seen.add(k); return true;
  });
  return {
    value: unique.reduce((sum,x) => sum + x.value, 0),
    source: "SEC filing balance sheet — " + unique.map(x => x.label).slice(0,6).join(" | ")
  };
}

function findInterestInRows(rows) {
  for (const row of rows) {
    if (/^interest\s+income(?:,?\s+net)?$/i.test(row.label) && row.values.length)
      return {value: Math.abs(row.values[0]), label: row.label, source: "SEC filing Statement of Operations"};
  }
  return null;
}

function findTotalIncomeInRows(rows) {
  const patterns = [
    /^total\s+income$/i,
    /^total\s+revenues?$/i,
    /^total\s+revenue$/i
  ];
  for (const row of rows) {
    if (patterns.some(re => re.test(row.label)) && row.values.length) {
      return {
        value: Math.abs(row.values[0]),
        label: row.label,
        source: "SEC filing Statement of Operations"
      };
    }
  }
  return null;
}

function findProhibitedIncomeComponents(facts, rows, interestFact) {
  const found = [];

  if (interestFact?.value != null) {
    found.push({
      value: Math.abs(interestFact.value),
      label: interestFact.label || "Interest income",
      source: interestFact.source || "SEC XBRL",
      explicit: true
    });
  } else {
    for (const row of rows) {
      if (/^interest\s+income(?:,?\s+net)?$/i.test(row.label) && row.values.length) {
        found.push({
          value: Math.abs(row.values[0]),
          label: row.label,
          source: "SEC filing Statement of Operations",
          explicit: true
        });
        break;
      }
    }
  }

  // Only add other income when the filing explicitly identifies it as
  // prohibited. Do not classify generic gains, derivatives or fair-value
  // changes as prohibited without an explicit disclosure.
  for (const row of rows) {
    if (!row.values.length) continue;
    if (/(?:prohibited|haram|alcohol|gambling|tobacco|pork|adult\s+entertainment)/i.test(row.label)) {
      found.push({
        value: Math.abs(row.values[0]),
        label: row.label,
        source: "SEC filing Statement of Operations",
        explicit: true
      });
    }
  }

  return found;
}

function findSalesInRows(rows) {
  for (const row of rows) {
    if (/^(?:sales|net sales|revenue|revenues)$/i.test(row.label) && row.values.length)
      return {value: Math.abs(row.values[0]), label: row.label, source: "SEC filing Statement of Operations"};
  }
  return null;
}

function parseMoney(text) {
  const s = String(text || "").trim();
  if (!s) return null;

  // Keep the first accounting-style amount in the cell.
  const cleaned = s
    .replace(/\u00a0/g, " ")
    .replace(/,/g, "")
    .replace(/\$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  const paren = /^\(\s*([-+]?\d+(?:\.\d+)?)\s*\)$/.exec(cleaned);
  if (paren) return -Math.abs(Number(paren[1]));

  const m = cleaned.match(/[-+]?\d+(?:\.\d+)?/);
  if (!m) return null;

  const n = Number(m[0]);
  return Number.isFinite(n) ? n : null;
}

function decodeHtml(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x27;/gi, "'")
    .replace(/&#(\d+);/g, (_, n) => {
      const code = Number(n);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    })
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => {
      const code = parseInt(h, 16);
      return Number.isFinite(code) ? String.fromCharCode(code) : _;
    });
}

async function getText(url) {
  const res = await fetch(url, {headers: SEC_HEADERS});
  if (!res.ok) throw new Error("SEC filing HTTP " + res.status);
  return res.text();
}

async function getMarket(symbol) {
  // Quote can be blocked from some serverless regions; always try chart as fallback.
  try {
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
      encodeURIComponent(symbol);

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0",
          "Accept": "application/json"
        }
      });

      if (res.ok) {
        const q = (await res.json())?.quoteResponse?.result?.[0];
        if (q) {
          const price = Number(q.regularMarketPrice ?? q.postMarketPrice);
          const marketCap = Number(q.marketCap);
          const shares = Number(q.sharesOutstanding);

          if (price > 0 || marketCap > 0 || shares > 0) {
            return {
              price: Number.isFinite(price) && price > 0 ? price : null,
              marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null,
              shares: Number.isFinite(shares) && shares > 0 ? shares : null,
              source: "Yahoo Finance"
            };
          }
        }
      }
    } catch (_) {}

    try {
      const chart = await fetch(
        "https://query1.finance.yahoo.com/v8/finance/chart/" +
          encodeURIComponent(symbol) + "?range=5d&interval=1d",
        {
          headers: {
            "User-Agent": "Mozilla/5.0",
            "Accept": "application/json"
          }
        }
      );

      if (chart.ok) {
        const result = (await chart.json())?.chart?.result?.[0];
        const meta = result?.meta;
        const closes = result?.indicators?.quote?.[0]?.close || [];
        const lastClose = closes.filter(x => Number.isFinite(Number(x))).slice(-1)[0];
        const price = Number(
          meta?.regularMarketPrice ??
          meta?.postMarketPrice ??
          meta?.previousClose ??
          lastClose
        );

        if (Number.isFinite(price) && price > 0) {
          return {
            price,
            marketCap: null,
            shares: null,
            source: "Yahoo Finance chart"
          };
        }
      }
    } catch (_) {}
  } catch (_) {}

  return null;
}

async function getJson(url) {
  const res = await fetch(url, { headers: SEC_HEADERS });

  if (!res.ok) {
    throw new Error(
      "SEC HTTP " + res.status + " عند جلب " + url
    );
  }

  return res.json();
}
