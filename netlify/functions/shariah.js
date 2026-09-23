const HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json; charset=utf-8"
};

const SEC_HEADERS = {
  "User-Agent": "ShariahScanner/1.0 contact@example.com",
  "Accept": "application/json"
};

exports.handler = async (event) => {
  if (event.httpMethod === "OPTIONS") return response(204, {});

  const symbol = String(
    event.queryStringParameters && event.queryStringParameters.symbol || ""
  ).trim().toUpperCase();

  if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) {
    return response(400, { error: "رمز السهم غير صحيح" });
  }

  try {
    const companies = await getJson("https://www.sec.gov/files/company_tickers.json");
    const company = Object.values(companies || {}).find(
      x => String(x.ticker || "").toUpperCase() === symbol
    );

    if (!company) {
      return response(404, {
        symbol,
        status: "insufficient",
        reason: "رمز السهم غير موجود في SEC"
      });
    }

    const cik = String(company.cik_str).padStart(10, "0");

    const submissions = await getJson(
      "https://data.sec.gov/submissions/CIK" + cik + ".json"
    );
    const facts = await getJson(
      "https://data.sec.gov/api/xbrl/companyfacts/CIK" + cik + ".json"
    );

    const filing = latestFiling(submissions.filings && submissions.filings.recent);
    const name = String(submissions.name || company.title || "");
    const sic = String(submissions.sic || "");
    const sicDescription = String(submissions.sicDescription || "");

    const market = await yahoo(symbol);
    const shares = market && market.shares || sharesFromSEC(facts);
    const marketCap =
      market && market.marketCap ||
      market && market.price && shares ? market.price * shares : null;

    if (blockedActivity(name, sicDescription)) {
      return response(200, {
        symbol,
        status: "rejected_activity",
        activity: name,
        sic,
        sicDescription,
        marketCap,
        currentPrice: market && market.price || null,
        filing: publicFiling(filing),
        source: "SEC EDGAR + Yahoo Finance"
      });
    }

    let rows = [];
    if (filing && filing.accession) {
      try {
        rows = await filingRows(cik, filing);
      } catch (_) {
        rows = [];
      }
    }

    const debt = getDebt(facts, rows);
    const deposits = getDeposits(facts, rows);
    const interest = getInterest(facts, rows);
    const sales = getSales(facts, rows);

    const checks = {
      debt: makeCheck(debt, marketCap, 30),
      interestTakingDeposits: makeCheck(deposits, marketCap, 30),
      prohibitedIncome: makeCheck(interest, sales && sales.value, 5)
    };

    const complete =
      marketCap > 0 &&
      checks.debt.pass !== null &&
      checks.interestTakingDeposits.pass !== null &&
      checks.prohibitedIncome.pass !== null;

    let status = "insufficient";
    if (complete) {
      status = Object.values(checks).every(x => x.pass)
        ? "compliant"
        : "rejected_financial";
    }

    return response(200, {
      symbol,
      status,
      activity: name,
      sic,
      sicDescription,
      filing: publicFiling(filing),
      marketCap,
      currentPrice: market && market.price || null,
      sharesOutstanding: shares || null,
      marketCapSource: market && market.source || null,
      checks,
      note: complete
        ? "تم الفحص من بيانات SEC دون تحويل البيانات غير المفصح عنها إلى صفر"
        : "لا يمكن الحسم عند نقص الإفصاح"
    });
  } catch (error) {
    return response(500, {
      error: "تعذر تشغيل الفحص الشرعي",
      details: String(error && error.message || error)
    });
  }
};

function response(statusCode, body) {
  return {
    statusCode,
    headers: HEADERS,
    body: JSON.stringify(body)
  };
}

function latestFiling(recent) {
  if (!recent) return null;

  const forms = recent.form || [];
  let best = null;

  for (let i = 0; i < forms.length; i++) {
    if (!["10-Q", "10-K", "20-F", "40-F"].includes(forms[i])) continue;

    const x = {
      form: forms[i],
      accession: (recent.accessionNumber || [])[i] || null,
      primaryDocument: (recent.primaryDocument || [])[i] || null,
      filingDate: (recent.filingDate || [])[i] || null,
      reportDate: (recent.reportDate || [])[i] || null
    };

    if (!best) {
      best = x;
      continue;
    }

    const a = String(x.reportDate || "") + String(x.filingDate || "");
    const b = String(best.reportDate || "") + String(best.filingDate || "");
    if (a > b) best = x;
  }

  return best;
}

function publicFiling(x) {
  if (!x) return null;
  return {
    form: x.form,
    filingDate: x.filingDate,
    reportDate: x.reportDate
  };
}

function blockedActivity(name, sicDescription) {
  const words = [
    "bank", "banking", "insurance",
    "casino", "gambling",
    "tobacco", "cigarette",
    "cannabis", "marijuana",
    "liquor", "distillery", "brewery", "beer", "wine",
    "pork", "swine",
    "adult entertainment",
    "firearm", "firearms", "ammunition", "munitions",
    "weapon", "weapons", "ordnance"
  ];

  const text = (String(name) + " " + String(sicDescription)).toLowerCase();
  return words.some(word => text.indexOf(word) !== -1);
}

function makeCheck(item, denominator, limit) {
  const ratio = item && denominator > 0
    ? Math.abs(item.value) / denominator * 100
    : null;

  return {
    numerator: item ? Math.abs(item.value) : null,
    denominator: denominator > 0 ? denominator : null,
    ratio,
    limit,
    pass: ratio === null ? null : ratio <= limit,
    source: item && item.source || null,
    label: item && item.label || null
  };
}

function getDebt(facts, rows) {
  const names = [
    "ConvertibleNotesPayable",
    "ConvertibleDebt",
    "LongTermDebtCurrent",
    "LongTermDebtNoncurrent",
    "LongTermDebt",
    "ShortTermBorrowings",
    "NotesPayable",
    "DebtCurrent",
    "DebtNoncurrent",
    "Debt"
  ];

  const x = instantFacts(facts, names);
  if (x) return x;

  const re = /(convertible\\s+(notes?|debt)|notes?\\s+payable|term\\s+loans?|loans?\\s+payable|long[- ]term\\s+(debt|borrowings?)|short[- ]term\\s+(borrowings?|debt)|senior\\s+notes?|interest[- ]bearing\\s+debt)/i;
  const found = rows.filter(r => re.test(r.label) && r.values.length);

  if (!found.length) return null;

  const unique = [];
  const seen = {};
  found.forEach(r => {
    const key = r.label + "|" + r.values[0];
    if (!seen[key]) {
      seen[key] = true;
      unique.push(r);
    }
  });

  return {
    value: unique.reduce((s, r) => s + Math.abs(r.values[0]), 0),
    label: unique.map(r => r.label).slice(0, 5).join(" | "),
    source: "SEC filing — explicit debt lines"
  };
}

function getDeposits(facts, rows) {
  const names = [
    "InterestBearingDeposits",
    "InterestBearingDepositsAtBanks"
  ];

  const x = instantFacts(facts, names);
  if (x) return x;

  const re = /interest[- ]bearing\\s+(deposits?|securities|investments?)/i;
  for (const r of rows) {
    if (re.test(r.label) && r.values.length) {
      return {
        value: Math.abs(r.values[0]),
        label: r.label,
        source: "SEC filing — explicit interest-bearing deposits/investments"
      };
    }
  }

  return null;
}

function getInterest(facts, rows) {
  for (const r of rows) {
    if (/^interest\\s+income(?:,\\s*net)?$/i.test(r.label) && r.values.length) {
      return {
        value: Math.abs(r.values[0]),
        label: r.label,
        source: "SEC filing — explicit Interest income"
      };
    }
  }

  const x = flowFacts(facts, [
    "InterestIncome",
    "InterestIncomeNonoperating",
    "InvestmentIncomeInterest"
  ]);

  return x || null;
}

function getSales(facts, rows) {
  const x = flowFacts(facts, [
    "RevenueFromContractWithCustomerExcludingAssessedTax",
    "RevenueFromContractWithCustomerIncludingAssessedTax",
    "SalesRevenueNet",
    "SalesRevenueGoodsNet",
    "Revenue"
  ]);

  if (x) return x;

  for (const r of rows) {
    if (/^(sales|net sales|revenue|revenues|net revenue)$/i.test(r.label) && r.values.length) {
      return {
        value: Math.abs(r.values[0]),
        label: r.label,
        source: "SEC filing — revenue/sales"
      };
    }
  }

  return null;
}

function instantFacts(facts, names) {
  const all = [];
  const namespaces = facts && facts.facts || {};

  for (const ns of Object.keys(namespaces)) {
    const tags = namespaces[ns] || {};

    for (const tagName of Object.keys(tags)) {
      if (!names.some(n => n.toLowerCase() === tagName.toLowerCase())) continue;

      const tag = tags[tagName];
      for (const unit of Object.keys(tag.units || {})) {
        for (const item of tag.units[unit] || []) {
          if (item.start || item.val == null) continue;

          const value = Number(item.val);
          if (!Number.isFinite(value) || value <= 0) continue;

          all.push({
            value,
            label: ns + ":" + tagName,
            end: item.end || "",
            filed: item.filed || ""
          });
        }
      }
    }
  }

  if (!all.length) return null;

  all.sort((a, b) => {
    const d = String(b.end).localeCompare(String(a.end));
    return d || String(b.filed).localeCompare(String(a.filed));
  });

  return {
    value: all[0].value,
    label: all[0].label,
    source: "SEC XBRL — " + all[0].label
  };
}

function flowFacts(facts, names) {
  const all = [];
  const namespaces = facts && facts.facts || {};

  for (const ns of Object.keys(namespaces)) {
    const tags = namespaces[ns] || {};

    for (const tagName of Object.keys(tags)) {
      if (!names.some(n => n.toLowerCase() === tagName.toLowerCase())) continue;

      const tag = tags[tagName];
      for (const unit of Object.keys(tag.units || {})) {
        for (const item of tag.units[unit] || []) {
          if (item.val == null) continue;
          if (!isQuarter(item)) continue;

          const value = Number(item.val);
          if (!Number.isFinite(value)) continue;

          all.push({
            value,
            label: ns + ":" + tagName,
            end: item.end || "",
            filed: item.filed || ""
          });
        }
      }
    }
  }

  if (!all.length) return null;

  all.sort((a, b) => {
    const d = String(b.end).localeCompare(String(a.end));
    return d || String(b.filed).localeCompare(String(a.filed));
  });

  return {
    value: Math.abs(all[0].value),
    label: all[0].label,
    source: "SEC XBRL — " + all[0].label
  };
}

function isQuarter(item) {
  if (!item.start || !item.end) return true;

  const start = Date.parse(item.start + "T00:00:00Z");
  const end = Date.parse(item.end + "T00:00:00Z");

  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;

  const days = (end - start) / 86400000;
  return days >= 60 && days <= 130;
}

function sharesFromSEC(facts) {
  const tag = facts && facts.facts && facts.facts.dei &&
    facts.facts.dei.EntityCommonStockSharesOutstanding;

  if (!tag) return null;

  const values = [];
  for (const unit of Object.keys(tag.units || {})) {
    for (const item of tag.units[unit] || []) {
      const value = Number(item.val);
      if (Number.isFinite(value) && value > 0) {
        values.push({ value, date: item.end || item.filed || "" });
      }
    }
  }

  values.sort((a, b) => String(b.date).localeCompare(String(a.date)));
  return values.length ? values[0].value : null;
}

async function filingRows(cik, filing) {
  const base =
    "https://www.sec.gov/Archives/edgar/data/" +
    String(Number(cik)) + "/" +
    filing.accession.replace(/-/g, "") + "/";

  const url = filing.primaryDocument
    ? base + filing.primaryDocument
    : base + filing.accession + ".txt";

  let html;

  try {
    html = await getText(url);
  } catch (_) {
    html = await getText(base + filing.accession + ".txt");
  }

  return parseRows(html);
}

function parseRows(html) {
  const text = String(html || "");
  const rows = [];
  const thousands = /(?:dollars?\\s+in\\s+thousands|\\bin\\s+thousands\\b)/i.test(text);
  const scale = thousands ? 1000 : 1;
  const rowRe = /<tr\\b[^>]*>([\\s\\S]*?)<\\/tr>/gi;

  let rowMatch;

  while ((rowMatch = rowRe.exec(text))) {
    const cells = [];
    const cellRe = /<(?:td|th)\\b[^>]*>([\\s\\S]*?)<\\/(?:td|th)>/gi;
    let cellMatch;

    while ((cellMatch = cellRe.exec(rowMatch[1]))) {
      const value = decode(cellMatch[1]
        .replace(/<br\\s*\\/?>/gi, " ")
        .replace(/<[^>]+>/g, " ")
      ).replace(/\\s+/g, " ").trim();

      if (value) cells.push(value);
    }

    if (cells.length < 2) continue;

    rows.push({
      label: cells[0],
      values: cells.slice(1)
        .map(toNumber)
        .filter(v => v !== null)
        .map(v => v * scale)
    });
  }

  return rows;
}

function toNumber(text) {
  const s = String(text || "")
    .replace(/,/g, "")
    .replace(/\\$/g, "")
    .trim();

  if (!s) return null;

  const negative = /^\\(.*\\)$/.test(s);
  const match = s.match(/[-+]?\\d+(?:\\.\\d+)?/);

  if (!match) return null;

  const value = Number(match[0]);
  if (!Number.isFinite(value)) return null;

  return negative ? -Math.abs(value) : value;
}

function decode(text) {
  return String(text || "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, "\"")
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#x27;/gi, "'");
}

async function yahoo(symbol) {
  try {
    const url =
      "https://query1.finance.yahoo.com/v7/finance/quote?symbols=" +
      encodeURIComponent(symbol);

    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });

    if (r.ok) {
      const q = (await r.json()).quoteResponse &&
        (await Promise.resolve({r: q})); // unreachable helper avoided below
    }
  } catch (_) {}

  try {
    const url =
      "https://query1.finance.yahoo.com/v8/finance/chart/" +
      encodeURIComponent(symbol) + "?range=5d&interval=1d";

    const r = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" }
    });

    if (!r.ok) return null;

    const body = await r.json();
    const result = body.chart && body.chart.result && body.chart.result[0];
    if (!result) return null;

    const meta = result.meta || {};
    const closes = result.indicators &&
      result.indicators.quote &&
      result.indicators.quote[0] &&
      result.indicators.quote[0].close || [];

    const valid = closes.filter(x => Number.isFinite(Number(x)));
    const price = Number(
      meta.regularMarketPrice ||
      meta.postMarketPrice ||
      meta.previousClose ||
      valid[valid.length - 1]
    );

    return Number.isFinite(price) && price > 0
      ? { price, marketCap: null, shares: null, source: "Yahoo Finance chart" }
      : null;
  } catch (_) {
    return null;
  }
}

async function getText(url) {
  const r = await fetch(url, { headers: SEC_HEADERS });
  if (!r.ok) throw new Error("SEC HTTP " + r.status);
  return r.text();
}

async function getJson(url) {
  const r = await fetch(url, { headers: SEC_HEADERS });
  if (!r.ok) throw new Error("SEC HTTP " + r.status);
  return r.json();
}
