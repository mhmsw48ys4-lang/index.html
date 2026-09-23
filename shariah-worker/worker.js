const SEC_HEADERS = {
  "User-Agent": "ShariahScanner/1.0 contact@example.com",
  "Accept": "application/json,text/html"
};

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === "/api/scan") {
      const symbol = (url.searchParams.get("symbol") || "").trim().toUpperCase();
      if (!/^[A-Z0-9.-]{1,12}$/.test(symbol)) return json({error:"رمز السهم غير صحيح"},400);
      try { return json(await scan(symbol)); }
      catch (e) { return json({error:"تعذر الفحص",details:String(e?.message||e)},500); }
    }
    return new Response(INDEX, {headers:{"content-type":"text/html;charset=UTF-8"}});
  }
};

async function scan(symbol) {
  const tickers = await getJson("https://www.sec.gov/files/company_tickers.json");
  const company = Object.values(tickers).find(x => String(x.ticker||"").toUpperCase() === symbol);
  if (!company) return {symbol,status:"insufficient",message:"السهم غير موجود في SEC"};

  const cik = String(company.cik_str).padStart(10,"0");
  const [sub,facts] = await Promise.all([
    getJson("https://data.sec.gov/submissions/CIK"+cik+".json"),
    getJson("https://data.sec.gov/api/xbrl/companyfacts/CIK"+cik+".json")
  ]);

  const filing = latest10Q(sub.filings?.recent);
  if (!filing) return {symbol,status:"insufficient",message:"لا يوجد 10-Q/10-K مناسب"};

  const [html, quote] = await Promise.all([
    getFiling(cik,filing),
    getQuote(symbol)
  ]);

  const rows = parseTables(html);
  const reportDate = filing.reportDate;

  const shares = latestShares(facts);
  const price = quote?.price || null;
  const marketCap = price && shares ? price*shares : quote?.marketCap || null;

  const debt = explicitDebt(rows);
  const deposits = explicitDeposits(rows);
  const sales = explicitRevenue(rows, reportDate);
  const interest = explicitInterest(rows, reportDate);

  const checks = {
    debt: ratioCheck(debt,marketCap,30),
    interestTakingDeposits: ratioCheck(deposits,marketCap,30),
    prohibitedIncome: ratioCheck(interest,sales?.value,5)
  };

  const complete = marketCap>0 && Object.values(checks).every(x=>x.pass!==null);

  return {
    symbol,status:complete?(Object.values(checks).every(x=>x.pass)?"compliant":"rejected_financial"):"insufficient",
    company:sub.name||company.title||symbol,
    sic:sub.sic||"",sicDescription:sub.sicDescription||"",
    filing:{form:filing.form,reportDate:filing.reportDate,filingDate:filing.filingDate},
    price,shares,marketCap,
    checks,
    diagnostics:{
      revenue:sales?.label||null,
      interest:sales&&interest?.label||null,
      deposits:deposits?.label||null,
      debt:debt?.label||null
    },
    note:complete?"تم الحساب من الإفصاح المختار.":"لا يتم تحويل الإفصاح المفقود إلى صفر."
  };
}

function latest10Q(r) {
  if (!r) return null;
  let best=null;
  for(let i=0;i<(r.form||[]).length;i++){
    if(!["10-Q","10-K","20-F","40-F"].includes(r.form[i])) continue;
    const x={form:r.form[i],accession:r.accessionNumber?.[i],primaryDocument:r.primaryDocument?.[i],filingDate:r.filingDate?.[i],reportDate:r.reportDate?.[i]};
    if(!best || String(x.reportDate)+String(x.filingDate)>String(best.reportDate)+String(best.filingDate)) best=x;
  }
  return best;
}

async function getFiling(cik,filing){
  const base="https://www.sec.gov/Archives/edgar/data/"+Number(cik)+"/"+filing.accession.replace(/-/g,"")+"/";
  const url=base+(filing.primaryDocument||filing.accession+".txt");
  const r=await fetch(url,{headers:SEC_HEADERS});
  if(!r.ok) throw new Error("SEC filing HTTP "+r.status);
  return r.text();
}

function parseTables(html){
  const out=[];
  const thousands=/(?:dollars?\s+in\s+thousands|\bin\s+thousands\b)/i.test(html);
  const scale=thousands?1000:1;
  const rowRe=/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi;
  let m;
  while((m=rowRe.exec(html))){
    const cells=[];
    const cellRe=/<(?:td|th)\b[^>]*>([\s\S]*?)<\/(?:td|th)>/gi;
    let c;
    while((c=cellRe.exec(m[1]))){
      const s=decode(c[1].replace(/<br\s*\/?>/gi," ").replace(/<[^>]+>/g," ")).replace(/\s+/g," ").trim();
      if(s) cells.push(s);
    }
    if(cells.length<2) continue;
    const nums=cells.slice(1).map(toNumber).filter(v=>v!==null).map(v=>v*scale);
    if(nums.length) out.push({label:cells[0],values:nums,cells});
  }
  return out;
}

function explicitDebt(rows){
  const exact=/^(total\s+)?(interest[- ]bearing\s+debt|debt|borrowings?|notes?\s+payable|convertible\s+notes?)(?:\s+and\s+current\s+portion)?$/i;
  const lines=rows.filter(r=>exact.test(r.label));
  const total=lines.find(r=>/^total\s+(debt|borrowings?|notes?\s+payable)$/i.test(r.label));
  if(total) return item(total.values[0],total.label,"SEC filing — explicit total debt");
  if(lines.length) return item(lines.reduce((s,r)=>s+Math.abs(r.values[0]),0),lines.map(r=>r.label).join(" | "),"SEC filing — explicit debt lines");
  return null;
}

function explicitDeposits(rows){
  // Do not equate generic cash/marketable securities with deposits.
  const re=/^(interest[- ]bearing\s+deposits?|interest[- ]bearing\s+balances?|interest[- ]bearing\s+securities|interest[- ]bearing\s+investments?)$/i;
  const r=rows.find(x=>re.test(x.label)&&x.values.length);
  return r?item(Math.abs(r.values[0]),r.label,"SEC filing — explicit interest-bearing deposit"):null;
}

function explicitRevenue(rows){
  const re=/^(sales|net sales|revenue|revenues|net revenue)$/i;
  const r=rows.find(x=>re.test(x.label)&&x.values.length);
  return r?item(Math.abs(r.values[0]),r.label,"SEC filing — revenue/sales"):null;
}

function explicitInterest(rows){
  const re=/^interest\s+income(?:,\s*net)?$/i;
  const r=rows.find(x=>re.test(x.label)&&x.values.length);
  return r?item(Math.abs(r.values[0]),r.label,"SEC filing — standalone interest income"):null;
}

function item(value,label,source){return {value,label,source};}

function ratioCheck(itemValue,den,limit){
  const ratio=itemValue&&den>0?Math.abs(itemValue.value)/den*100:null;
  return {numerator:itemValue?.value??null,denominator:den>0?den:null,ratio,limit,pass:ratio===null?null:ratio<=limit,source:itemValue?.source||null,label:itemValue?.label||null};
}

function latestShares(facts){
  const tag=facts?.facts?.dei?.EntityCommonStockSharesOutstanding;
  if(!tag) return null;
  const a=[];
  for(const unit of Object.keys(tag.units||{})) for(const x of tag.units[unit]||[]){
    const v=Number(x.val); if(v>0) a.push({v,d:x.end||x.filed||""});
  }
  a.sort((x,y)=>String(y.d).localeCompare(String(x.d)));
  return a[0]?.v||null;
}

async function getQuote(symbol){
  try{
    const u="https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(symbol)+"?range=1d&interval=1d";
    const r=await fetch(u,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"}});
    if(!r.ok)return null;
    const j=await r.json(),m=j.chart?.result?.[0]?.meta||{};
    const p=Number(m.regularMarketPrice||m.postMarketPrice||m.previousClose);
    return p>0?{price:p}:null;
  }catch{return null}
}

async function getJson(url){
  const r=await fetch(url,{headers:SEC_HEADERS});
  if(!r.ok) throw new Error("SEC HTTP "+r.status);
  return r.json();
}
function toNumber(x){
  const s=String(x||"").replace(/,/g,"").replace(/\$/g,"").replace(/%/g,"").trim();
  if(!s||/^[-—–]$/.test(s)) return null;
  const neg=/^\(.*\)$/.test(s),m=s.match(/[-+]?\d+(?:\.\d+)?/);
  if(!m)return null; const v=Number(m[0]); return Number.isFinite(v)?(neg?-Math.abs(v):v):null;
}
function decode(s){return String(s).replace(/&nbsp;/gi," ").replace(/&amp;/gi,"&").replace(/&lt;/gi,"<").replace(/&gt;/gi,">").replace(/&quot;/gi,'\"').replace(/&#39;|&apos;|&#x27;/gi,"'");}
function json(o,status=200){return new Response(JSON.stringify(o),{status,headers:{"content-type":"application/json;charset=UTF-8","access-control-allow-origin":"*"}});}

const INDEX=\`<!doctype html><html lang="ar" dir="rtl"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>فاحص شرعي مستقل</title><style>body{font-family:Arial;background:#08111f;color:#fff;margin:0;padding:20px}main{max-width:760px;margin:auto}input,button{font-size:18px;padding:13px;border-radius:10px;border:0}input{width:65%}button{cursor:pointer}section{margin-top:18px;padding:18px;border:1px solid #26364d;border-radius:14px;background:#101d30}.row{display:flex;justify-content:space-between;padding:10px 0;border-bottom:1px solid #26364d}.muted{color:#aebbd0}.bad{color:#ff7272}.ok{color:#68e08b}</style><main><h1>فاحص شرعي مستقل</h1><p class="muted">مصدر البيانات: SEC EDGAR. لا نحول البيانات غير المفصح عنها إلى صفر.</p><input id="s" placeholder="MBOT"><button onclick="go()">فحص</button><div id="out"></div></main><script>async function go(){let s=document.getElementById("s").value.trim().toUpperCase(),o=document.getElementById("out");o.innerHTML="<section>جاري الفحص...</section>";try{let r=await fetch("/api/scan?symbol="+encodeURIComponent(s)),j=await r.json();render(j)}catch(e){o.innerHTML="<section>خطأ في الاتصال</section>"}}function pct(x){return x==null?"بيانات غير كافية":x.toFixed(2)+"%"}function render(j){let o=document.getElementById("out");if(j.error){o.innerHTML="<section>"+j.error+"</section>";return}let c=j.checks||{};o.innerHTML="<section><h2>"+(j.company||j.symbol)+"</h2><div class='row'><span>الحالة</span><b>"+(j.status==="compliant"?"اجتاز الفحص":j.status==="rejected_financial"?"لم يجتز الفحص":"لا يمكن الحسم — بيانات غير كافية")+"</b></div><div class='row'><span>القيمة السوقية</span><b>"+(j.marketCap?("$"+(j.marketCap/1e6).toFixed(2)+"M"):"غير متاحة")+"</b></div>"+row("الديون",c.debt)+row("الودائع الآخذة للفائدة",c.interestTakingDeposits)+row("الدخل المحظور",c.prohibitedIncome)+"<p class='muted'>"+(j.note||"")+"</p></section><section><b>مصادر الحساب</b><div class='muted'>الإيرادات: "+(j.diagnostics?.revenue||"غير مفصح")+"</div><div class='muted'>الفائدة: "+(j.diagnostics?.interest||"غير مفصح")+"</div><div class='muted'>الودائع: "+(j.diagnostics?.deposits||"غير مفصح")+"</div></section>"}function row(n,x){let cls=x?.pass===true?"ok":x?.pass===false?"bad":"muted";return "<div class='row'><span>"+n+"</span><b class='"+cls+"'>"+pct(x?.ratio)+"</b></div>"}</script></html>\`;
