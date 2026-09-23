const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Content-Type": "application/json; charset=utf-8"
};

const SEC_HEADERS = {
  "User-Agent": "ShariahScanner/1.0 contact@example.com",
  "Accept": "application/json,text/plain,*/*"
};

exports.handler = async function (event) {
  if (event.httpMethod === "OPTIONS") {
    return json(204, {});
  }

  const symbol = String(event.queryStringParameters?.symbol || "")
    .trim()
    .toUpperCase();

  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) {
    return json(400, { error: "رمز السهم غير صحيح" });
  }

  try {
    const tickerMap = await getJson("https://www.sec.gov/files/company_tickers.json");
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

    const [submissions, facts] = await Promise.all([
      getJson("https://data.sec.gov/submissions/CIK" + cik + ".json"),
      getJson("https://data.sec.gov/api/xbrl/companyfacts/CIK" + cik + ".json")
    ]);

    const filing = latestFiling(submissions?.filings?.recent || {});
    const activity = String(submissions?.name || company?.title || "");
    const sic = String(submissions?.sic || "");
    const sicDescription = String(submissions?.sicDescription || "");

    const market = await getMarket(symbol);
    const shares = market?.shares || extractShares(facts);
    const marketCap =
      market?.marketCap ||
      (market?.price > 0 && shares > 0 ? market.price * shares : null);

    if (isProhibitedActivity(activity, sicDescription)) {
      return json(200, {
        symbol,
        status: "rejected_activity",
        activity,
        sic,
        sicDescription,
        filing: publicFiling(filing),
        marketCap,
        currentPrice: market?.price || null,
        sharesOutstanding: shares,
        source: "SEC EDGAR + Yahoo Finance"
      });
    }

    let rows = [];
    if (filing?.accession) {
      try {
        rows = await readFilingRows(cik, filing);
      } catch (_) {
        rows = [];
      }
    }

    const debt = findDebt(facts, rows);
    const deposits = findInterestBearingDeposits(facts, rows);
    const interest = findPureInterestIncome(facts, rows);
    const sales = findSales(facts, rows);

    const debtRatio = ratio(debt?.value, marketCap);
    const depositsRatio = ratio(deposits?.value, marketCap);
    const prohibitedRatio = ratio(interest?.value, sales?.value);

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
        numerator: interest?.value ?? null,
        denominator: sales?.value ?? null,
        ratio: prohibitedRatio,
        limit: 5,
        pass: prohibitedRatio == null ? null : prohibitedRatio <= 5,
        source: interest?.source || null,
        incomeSource: interest?.label || null,
        denominatorSource: sales?.label || null,
        dataComplete: !!interest && !!sales
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
      currentPrice: market?.price || null,
      sharesOutstanding: shares,
      marketCapSource: market?.source || null,
      checks,
      dataMethod: "SEC XBRL + latest SEC filing",
      note: complete
        ? "تم الفحص من بيانات SEC دون افتراض القيم غير المفصح عنها"
        : "لا يتم اعتبار البيانات غير المفصح عنها صفراً"
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

    if (!best) {
      best = candidate;
      continue;
    }

    const a = String(candidate.reportDate || "") + "|" + String(candidate.filingDate || "");
    const b = String(best.reportDate || "") + "|" + String(best.filingDate || "");
    if (a > b) best = candidate;
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

function isProhibitedActivity(name, sicDescription) {
  const blocked = [
    "bank", "banking", "insurance",
    "casino", "gambling",
    "tobacco", "cigarette",
    "cannabis", "marijuana",
    "liquor", "distillery", "brewery", "beer", "wine",
    "pork", "swine",
    "adult entertainment",
    "firearm", "firearms", "ammunition", "munitions",
    "weapons", "weapon systems", "ordnance"
  ];

  const text = (String(name || "") + " " + String(sicDescription || "")).toLowerCase();
  return blocked.some(x => text.includes(x));
}

function findDebt(facts, rows) {
  const xbrl = collectDebtFacts(facts);

  if (xbrl) return xbrl;

  return findDebtInRows(rows);
}

function collectDebtFacts(facts) {
  const namespaces = facts?.facts || {};
  const preferred = [];
  const components = [];

  for (const [namespace, tags] of Object.entries(namespaces)) {
    for (const [tagName, tag] of Object.entries(tags || {})) {
      const n = String(tagName).toLowerCase().replace(/[^a-z0-9]/g, "");

      let kind = null;
      if (
        n.includes("convertiblenotespayable") ||
        n.includes("convertibledebt") ||
        n.includes("notespayable") ||
        n.includes("shorttermborrow")
      ) {
        kind = "component";
      } else if (
        n.includes("longtermdebtcurrent") ||
        n.includes("longtermdebtnoncurrent") ||
        n.includes("longtermdebt") ||
        n === "debt" ||
        n === "debtcurrent" ||
        n === "debtnoncurrent"
      ) {
        kind = "debt";
      }

      if (!kind) continue;

      for (const unitValues of Object.values(tag.units || {})) {
        for (const item of unitValues || []) {
          if (!item || item.val == null || item.start) continue;
          const value = Number(item.val);
          if (!Number.isFinite(value) || value <= 0) continue;

          const entry = {
            value: Math.abs(value),
            label: namespace + ":" + tagName,
            end: item.end || "",
            filed: item.filed || ""
          };

          (kind === "component" ? components : preferred).push(entry);
        }
      }
    }
  }

  const latestEnd = latestInstantDate(preferred.concat(components));
  const sameDateComponents = components.filter(x => x.end === latestEnd);
  const sameDatePreferred = preferred.filter(x => x.end === latestEnd);

  if (sameDateComponents.length) {
    const unique = uniqueDebtEntries(sameDateComponents);
    return {
      value: unique.reduce((s, x) => s + x.value, 0),
      label: unique.map(x => x.label).slice(0, 6).join(" + "),
      source: "SEC XBRL — explicit interest-bearing debt components"
    };
  }

  if (sameDatePreferred.length) {
    const unique = uniqueDebtEntries(sameDatePreferred);
    const total = chooseDebtTotal(unique);
    if (total) {
      return {
        value: total.value,
        label: total.label,
        source: "SEC XBRL — debt"
      };
    }
  }

  return null;
}

function latestInstantDate(items) {
  return items
    .map(x => String(x.end || ""))
    .filter(Boolean)
    .sort()
    .pop() || "";
}

function uniqueDebtEntries(items) {
  const seen = new Set();
  return items.filter(x => {
    const key = x.label + "|" + x.value + "|" + x.end;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function chooseDebtTotal(items) {
  if (!items.length) return null;

  const exactTotal = items.find(x => {
    const n = x.label.toLowerCase();
    return n.endsWith(":debt") || n.endsWith(":debtcurrent") || n.endsWith(":debtnoncurrent");
  });

  if (exactTotal) return exactTotal;

  return items.sort((a, b) => b.value - a.value)[0];
}

function findDebtInRows(rows) {
  const re = /(?:convertible\s+(?:notes?|debt)|notes?\s+payable|term\s+loans?|loans?\s+payable|long[- ]term\s+borrowings?|short[- ]term\s+borrowings?|senior\s+notes?|interest[- ]bearing\s+debt)/i;
  const found = [];

  for (const row of rows) {
    if (re.test(row.label) && row.values.length) {
      found.push({
        label: row.label,
        value: Math.abs(row.values[0])
      });
    }
  }

  if (!found.length) return null;

  const unique = [];
  const seen = new Set();
  for (const x of found) {
    const key = x.label + "|" + x.value;
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(x);
    }
  }

  return {
    value: unique.reduce((s, x) => s + x.value, 0),
    label: unique.map(x => x.label).slice(0, 6).join(" | "),
    source: "SEC filing balance sheet — explicit debt lines"
  };
}

function findInterestBearingDeposits(facts, rows) {
  const tags = [
    "InterestBearingDeposits",
    "InterestBearingDepositsAtBanks",
    "InterestBearingDepositsLiability"
  ];

  const xbrl = findInstantFact(facts, tags);
  if (xbrl) return xbrl;

  for (const row of rows) {
    if (
      /(?:interest[- ]bearing\s+deposits?|interest[- ]bearing\s+securities|interest[- ]bearing\s+investments?)/i.test(row.label) &&
      row.values.length
    ) {
      return {
        value: Math.abs(row.values[0]),
        label: row.label,
        source: "SEC filing — explicit interest-bearing deposits/investments"
      };
    }
  }

  return null;
}

function findPureInterestIncome(facts, rows) {
  for (const row of rows) {
    if (/^interest\s+income(?:,\s*net)?$/i.test(row.label) && row.values.length) {
      return {
        value: Math.abs(row.values[0]),
        label: row.label,
        source: "SEC filing Statement of Operations"
      };
    }
  }

  const exact = findFlowFact(
    facts,
    ["InterestIncome", "InterestIncomeNonoperating", "InvestmentIncomeInterest"],
    true
  );

  if (exact) {
    return {
      value: Math.abs(exact.value),
      label: exact.label,
      source: exact.source
    };
  }

  return null;
}

function findSales(facts, rows) {
  const exact = findFlowFact(
    facts,
    [
      "RevenueFromContractWithCustomerExcludingAssessedTax",
      "RevenueFromContractWithCustomerIncludingAssessedTax",
      "SalesRevenueNet",
      "SalesRevenueGoodsNet",
      "Revenue"
    ],
    true
  );

  if (exact) return exact;

  for (const row of rows) {
    if (/^(?:sales|net sales|revenue|revenues|net revenue)$/i.test(row.label) && row.values.length) {
      return {
        value: Math.abs(row.values[0]),
        label: row.label,
        source: "SEC filing Statement of Operations"
      };
    }
  }

  return null;
}

function findFlowFact(facts, names, quarter) {
  const namespaces = facts?.facts || {};
  const candidates = [];

  for (const [namespace, tags] of Object.entries(namespaces)) {
    for (const [tagName, tag] of Object.entries(tags || {})) {
      if (!names.some(x => x.toLowerCase() === tagName.toLowerCase())) continue;

      for (const unitValues of Object.values(tag.units || {})) {
        for (const item of unitValues || []) {
          if (!item || item.val == null) continue;
          if (quarter && !isQuarter(item)) continue;

          const value = Number(item.val);
          if (!Number.isFinite(value)) continue;

          candidates.push({
            value: Math.abs(value),
            label: namespace + ":" + tagName,
            end: item.end || "",
            filed: item.filed || ""
          });
        }
      }
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const end = String(b.end).localeCompare(String(a.end));
    return end || String(b.filed).localeCompare(String(a.filed));
  });

  const x = candidates[0];
  return {
    value: x.value,
    label: x.label,
    source: "SEC XBRL — " + x.label + (x.end ? " through " + x.end : "")
  };
}

function findInstantFact(facts, names) {
  const namespaces = facts?.facts || {};
  const candidates = [];

  for (const [namespace, tags] of Object.entries(namespaces)) {
    for (const [tagName, tag] of Object.entries(tags || {})) {
      if (!names.some(x => x.toLowerCase() === tagName.toLowerCase())) continue;

      for (const unitValues of Object.values(tag.units || {})) {
        for (const item of unitValues || []) {
          if (!item || item.val == null || item.start) continue;

          const value = Number(item.val);
          if (!Number.isFinite(value)) continue;

          candidates.push({
            value: Math.abs(value),
            label: namespace + ":" + tagName,
            end: item.end || "",
            filed: item.filed || ""
          });
        }
      }
    }
  }

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    const end = String(b.end).localeCompare(String(a.end));
    return end || String(b.filed).localeCompare(String(a.filed));
  });

  const x = candidates[0];
  return {
    value: x.value,
    label: x.label,
    source: "SEC XBRL — " + x.label + (x.end ? " through " + x.end : "")
  };
}

function isQuarter(item) {
  if (!item.start || !item.end) return true;

  const start = new Date(item.start + "T00:00:00Z").getTime();
  const end = new Date(item.end + "T00:00:00Z").getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;

  const days = (end - start) / 86400000;
  return days >= 60 && days <= 130;
}

function extractShares(facts) {
  const tag = facts?.facts?.dei?.EntityCommonStockSharesOutstanding;
  if (!tag) return null;

  const values = Object.values(tag.units || {}).flat()
    .filter(x => Number.isFinite(Number(x.val)))
    .sort((a, b) =>
      String(b.end || b.filed || "").localeCompare(String(a.end || a.filed || ""))
    );

  return values.length ? Number(values[0].val) : null;
}

async function readFilingRows(cik, filing) {
  const base =
    "https://www.sec.gov/Archives/edgar/data/" +
    String(Number(cik)) + "/" +
    String(filing.accession).replace(/-/g, "") + "/";

  const primary =
    filing.primaryDocument
      ? base + filing.primaryDocument
      : base + filing.accession + ".txt";

  let html;
  try {
    html = await getText(primary);
  } catch (_) {
    html = await getText(base + filing.accession + ".txt");
  }

  return extractRows(html);
}

function extractRows(html) {
  const rows = [];
  const text = String(html || "");
  const scale =
    /(?:U\.S\.\s*dollars?\s+in\s+thousands|\(\s*in\s+thousands\b|\bin\s+thousands\b)/i.test(text)
      ? 1000
      : 1;

  const re = /<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;

  while ((m = re.exec(text))) {
    const cells = [];
    const cr = /<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    let c;

    while ((c = cr.exec(m[1]))) {
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
        values: cells.slice(1)
          .map(parseMoney)
          .filter(v => v !== null)
          .map(v => v * scale)
      });
    }
  }

  return rows;
}

function parseMoney(text) {
  const s = String(text || "")
    .replace(/\u00a0/g, " ")
    .replace(/,/g, "")
    .replace(/\$/g, "")
    .replace(/\s+/g, " ")
    .trim();

  if (!s) return null;

  const paren = /^\(\s*([-+]?\d+(?:\.\d+)?)\s*\)$/.exec(s);
  if (paren) return -Math.abs(Number(paren[1]));

  const m = s.match(/[-+]?\d+(?:\.\d+)?/);
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
    .replace(/&quot;/gi, "\"")
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

function ratio(numerator, denominator) {
  return numerator != null && denominator > 0
    ? numerator / denominator * 100
    : null;
}

async function getMarket(symbol) {
  try {
    const quoteUrl =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
      encodeURIComponent(symbol);

    const res = await fetch(quoteUrl, {
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

        return {
          price: Number.isFinite(price) && price > 0 ? price : null,
          marketCap: Number.isFinite(marketCap) && marketCap > 0 ? marketCap : null,
          shares: Number.isFinite(shares) && shares > 0 ? shares : null,
          source: "Yahoo Finance"
        };
      }
    }
  } catch (_) {}

  try {
    const chart = await fetch(
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) +
      "?range=5d&interval=1d",
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
      const lastClose = closes
        .filter(x => Number.isFinite(Number(x)))
        .slice(-1)[0];

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

  return null;
}

async function getText(url) {
  const res = await fetch(url, { headers: SEC_HEADERS });
  if (!res.ok) throw new Error("SEC filing HTTP " + res.status);
  return res.text();
}

async function getJson(url) {
  const res = await fetch(url, { headers: SEC_HEADERS });
  if (!res.ok) throw new Error("SEC HTTP " + res.status);
  return res.json();
}
