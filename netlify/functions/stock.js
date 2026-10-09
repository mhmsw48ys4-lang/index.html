exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const tf = q.tf || "1d";
  const requested = String(q.symbol || "").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
  const configured = String(process.env.SCAN_SYMBOLS || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };
  const out = (status, body) => ({ statusCode: status, headers, body: JSON.stringify(body) });

  const dateAgo = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const yahooBars = async symbol => {
    const end = Math.floor(Date.now()/1000);
    let days = 420, interval = "1d";
    if (tf === "1w") { days = 1500; interval = "1wk"; }
    if (tf === "4h") { days = 60; interval = "60m"; }

    let j=null, lastError=null;
    for (const host of ["query1.finance.yahoo.com","query2.finance.yahoo.com"]) {
      const u = new URL("https://" + host + "/v8/finance/chart/" + encodeURIComponent(symbol));
      u.searchParams.set("period1", String(end - days * 86400));
      u.searchParams.set("period2", String(end));
      u.searchParams.set("interval", interval);
      u.searchParams.set("events", "div,splits");
      u.searchParams.set("includeAdjustedClose", "true");
      try {
        const response = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", "Accept": "application/json" } });
        if (!response.ok) { lastError = new Error("Yahoo " + response.status + " (" + host + ")"); continue; }
        const candidate = await response.json();
        if (candidate?.chart?.result?.[0]) { j=candidate; break; }
        lastError = new Error(candidate?.chart?.error?.description || "Yahoo لم يرجع بيانات تاريخية");
      } catch(e) { lastError=e; }
    }
    const z = j?.chart?.result?.[0];
    if (!z) {
      throw new Error((lastError?.message || "لا توجد بيانات تاريخية من Yahoo") +
        "؛ تحقق من توفر الشموع التاريخية في Yahoo Finance");
    }

    const ts = z.timestamp || [];
    const qv = z.indicators?.quote?.[0] || {};
    const raw = ts.map((t,i)=>({
      date:new Date(t*1000).toISOString(),
      o:Number(qv.open?.[i]), h:Number(qv.high?.[i]), l:Number(qv.low?.[i]),
      c:Number(qv.close?.[i]), v:Number(qv.volume?.[i]||0)
    })).filter(x=>[x.o,x.h,x.l,x.c].every(Number.isFinite));

    const ev=z.events?.splits||{};
    const splitEvents=Object.values(ev).map(x=>({
      date:new Date(Number(x.date)*1000).toISOString().slice(0,10),
      split_from:Number(x.numerator),
      split_to:Number(x.denominator),
      splitRatio:x.splitRatio||null
    })).filter(x=>Number.isFinite(x.split_from)&&Number.isFinite(x.split_to))
      .sort((x,y)=>y.date.localeCompare(x.date));

    if (tf !== "4h") {
      const out=raw.sort((a,b)=>a.date.localeCompare(b.date));
      out._splits=splitEvents;
      return out;
    }

    const r4=[];
    for(let i=0;i<raw.length;i+=4){
      const g=raw.slice(i,i+4);
      if(g.length<4) continue;
      r4.push({
        date:g[3].date,o:g[0].o,h:Math.max(...g.map(x=>x.h)),
        l:Math.min(...g.map(x=>x.l)),c:g[3].c,v:g.reduce((sum,x)=>sum+x.v,0)
      });
    }
    r4._splits=splitEvents;
    return r4;
  };

  const yahooScreener = async screenId => {
    let lastError=null;
    for(const host of ["query1.finance.yahoo.com","query2.finance.yahoo.com"]) {
      const u = new URL("https://"+host+"/v1/finance/screener/predefined/saved");
      u.searchParams.set("formatted","false");
      u.searchParams.set("scrIds",screenId);
      u.searchParams.set("count","250");
      u.searchParams.set("start","0");
      try {
        const response=await fetch(u,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"}});
        if(!response.ok){lastError=new Error("Yahoo screener "+response.status+" ("+host+")");continue;}
        const j=await response.json();
        const quotes=j?.finance?.result?.[0]?.quotes;
        if(Array.isArray(quotes)) return quotes;
        lastError=new Error("Yahoo screener لم يرجع قائمة أسهم");
      } catch(e){lastError=e;}
    }
    throw(lastError||new Error("Yahoo screener unavailable"));
  };

  const yahooQuotes = async symbols => {
    const map=new Map();
    for(let i=0;i<symbols.length;i+=100){
      const batch=symbols.slice(i,i+100);
      if(!batch.length) continue;
      let j=null, lastError=null;
      for(const host of ["query1.finance.yahoo.com","query2.finance.yahoo.com"]) {
        const u=new URL("https://"+host+"/v7/finance/quote");
        u.searchParams.set("symbols",batch.join(","));
        u.searchParams.set("formatted","false");
        u.searchParams.set("region","US");
        u.searchParams.set("lang","en-US");
        try {
          const response=await fetch(u,{headers:{"User-Agent":"Mozilla/5.0","Accept":"application/json"}});
          if(!response.ok){lastError=new Error("Yahoo quote "+response.status+" ("+host+")");continue;}
          const candidate=await response.json();
          if(Array.isArray(candidate?.quoteResponse?.result)){j=candidate;break;}
          lastError=new Error("Yahoo quote لم يرجع قائمة أسعار");
        } catch(e){lastError=e;}
      }
      if(!j) throw (lastError||new Error("Yahoo quote unavailable"));
      for(const x of (j?.quoteResponse?.result||[])) map.set(String(x.symbol||"").toUpperCase(),x);
    }
    return map;
  };

  const getBars = async symbol => yahooBars(symbol);

  const ema = (a,p) => {
    if(a.length<p) return null;
    let e=a.slice(0,p).reduce((s,x)=>s+x,0)/p, k=2/(p+1);
    for(let i=p;i<a.length;i++) e=a[i]*k+e*(1-k);
    return e;
  };
  const rsi = (a,p=14) => {
    if(a.length<=p) return null;
    let g=0,l=0;
    for(let i=1;i<=p;i++){const d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0);}
    let ag=g/p, al=l/p;
    for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p;}
    return al===0?100:100-100/(1+ag/al);
  };
  const macd = a => {
    const e12=ema(a,12),e26=ema(a,26);
    return e12==null||e26==null?null:e12-e26;
  };


  // Public no-key Yahoo fundamentals fallback. Share count is only accepted when explicitly reported.
  const yahooFundamentals = async symbol => {
    let lastError = null;
    const end = Math.floor(Date.now()/1000), start = end - 5*365*86400;
    for (const host of ["query2.finance.yahoo.com","query1.finance.yahoo.com"]) {
      const u = new URL("https://" + host + "/ws/fundamentals-timeseries/v1/finance/timeseries/" + encodeURIComponent(symbol));
      u.searchParams.set("symbol", symbol);
      u.searchParams.set("type", "sharesOutstanding,impliedSharesOutstanding,trailingMarketCap");
      u.searchParams.set("period1", String(start));
      u.searchParams.set("period2", String(end));
      try {
        const response = await fetch(u, {headers: {"User-Agent":"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/125 Safari/537.36", "Accept":"application/json"}});
        if (!response.ok) { lastError = new Error("Yahoo fundamentals " + response.status); continue; }
        const j = await response.json();
        const found = {};
        const latest = arr => {
          if (!Array.isArray(arr)) return null;
          const vals = arr.map(v => ({t:Number(v.timestamp || 0), n:Number(v?.reportedValue?.raw ?? v?.raw ?? v?.value)}))
            .filter(v => v.n > 0 && Number.isFinite(v.n)).sort((a,b) => b.t-a.t);
          return vals.length ? vals[0].n : null;
        };
        const walk = node => {
          if (!node || typeof node !== "object") return;
          if (Array.isArray(node)) { node.forEach(walk); return; }
          for (const key of ["sharesOutstanding","impliedSharesOutstanding","trailingMarketCap"]) {
            if (found[key] == null && Array.isArray(node[key])) {
              const n = latest(node[key]);
              if (n != null) found[key] = n;
            }
          }
          Object.values(node).forEach(v => { if (v && typeof v === "object") walk(v); });
        };
        walk(j);
        if (found.sharesOutstanding == null && found.impliedSharesOutstanding != null) found.sharesOutstanding = found.impliedSharesOutstanding;
        if (found.marketCap == null && found.trailingMarketCap != null) found.marketCap = found.trailingMarketCap;
        if (Object.keys(found).length) return found;
        lastError = new Error("Yahoo fundamentals لم يرجع بيانات الأسهم");
      } catch (e) { lastError = e; }
    }
    throw lastError || new Error("Yahoo fundamentals unavailable");
  };

  const getShort = async (symbol, ref={}) => {
    const shortVolume=null;
    const totalVolume=null;
    const shortRatio=ref.shortRatio!=null?Number(ref.shortRatio):null;
    const shortInterest=ref.sharesShort!=null?Number(ref.sharesShort):null;
    const float=ref.floatShares!=null?Number(ref.floatShares):null;
    const pctFloat=ref.shortPercentOfFloat!=null?Number(ref.shortPercentOfFloat)*100:
      (ref.sharesPercentSharesOut!=null?Number(ref.sharesPercentSharesOut)*100:null);
    return {
      shortVolume,
      totalVolume,
      shortRatio,
      shortInterest,
      daysToCover:shortRatio,
      float,
      shortPercentFloat:pctFloat,
      shortDate:ref.dateShortInterest?new Date(Number(ref.dateShortInterest)*1000).toISOString().slice(0,10):null
    };
  };

  const buildOne = async (symbol, ref={}) => {
    const bars=await getBars(symbol);
    if(bars.length<35) throw new Error("بيانات تاريخية غير كافية");

    const close=bars.map(x=>x.c), volume=bars.map(x=>x.v), last=bars[bars.length-1], prev=bars[bars.length-2];
    const e20=ema(close,20),e30=ema(close,30),e50=ema(close,50);
    const e20p=ema(close.slice(0,-1),20),e30p=ema(close.slice(0,-1),30),e50p=ema(close.slice(0,-1),50);
    const rr=rsi(close), mm=macd(close), mmp=macd(close.slice(0,-1));

    const win=bars.slice(-80), lows=[], highs=[];
    for(let i=2;i<win.length-2;i++){
      if(win[i].l<=win[i-1].l&&win[i].l<=win[i-2].l&&win[i].l<=win[i+1].l&&win[i].l<=win[i+2].l) lows.push({i,low:win[i].l});
      if(win[i].h>=win[i-1].h&&win[i].h>=win[i-2].h&&win[i].h>=win[i+1].h&&win[i].h>=win[i+2].h) highs.push({i,high:win[i].h});
    }
    const support=(lows.filter(x=>x.low<=last.c).sort((a,b)=>b.low-a.low)[0]?.low??Math.min(...win.map(x=>x.l)));
    const resistance=(highs.filter(x=>x.high>=last.c).sort((a,b)=>a.high-b.high)[0]?.high??Math.max(...win.map(x=>x.h)));

    const av=volume.slice(-21,-1).reduce((s,x)=>s+x,0)/Math.max(1,volume.slice(-21,-1).length);
    const rv=av?last.v/av:null, distance=support?((last.c-support)/support)*100:999;

    let stability=1,stableBase=last.l;
    for(let p=bars.length-3;p>=2;p--){
      const b=bars[p];
      const pivot=b.l<=bars[p-1].l&&b.l<=bars[p-2].l&&b.l<=bars[p+1].l&&b.l<=bars[p+2].l;
      const drop=bars[p-2].c>bars[p-1].c&&bars[p-1].c>b.c;
      if(!pivot||!drop) continue;
      let n=1;
      for(let j=p+1;j<bars.length;j++){if(bars[j].l<b.l){n=0;break;}n++;}
      if(n){stability=n;stableBase=b.l;break;}
    }

    const rebound=last.c>last.o&&last.c>prev.c;
    const macdImproving=mm!=null&&mmp!=null&&mm>mmp;
    const emaRecovery=e20!=null&&e30!=null&&e50!=null&&e20p!=null&&e30p!=null&&e50p!=null&&e20>e20p&&e30>e30p&&e50>e50p;
    const volumeImproving=last.v>prev.v&&rv>=1.2;
    const nearSupport=distance<=20;
    const supportHold=last.c>=support&&last.l<=support*1.05;

    let score=0;
    if(nearSupport)score+=20; else if(distance<=30)score+=12;
    if(supportHold)score+=10;
    if(macdImproving)score+=15;
    if(emaRecovery)score+=15;
    if(volumeImproving)score+=10; else if(rv>=1)score+=5;
    if(stability>=4)score+=10; else if(stability>=3)score+=7; else if(stability>=2)score+=4;
    if(rebound)score+=10;
    // RSI 0-35 is preferred near-pivot context, not a mandatory entry signal.
    if(rr!=null&&rr>=0&&rr<=35)score+=5;
    if(resistance>last.c*1.15)score+=5;
    if(last.v>=500000)score+=5;

    const splitEvents=Array.isArray(bars._splits)?bars._splits:[];
    const latestSplit=splitEvents[0]||null;
    const splitDate=latestSplit?.date||null;
    const splitDays=splitDate?Math.max(0,Math.floor((Date.now()-new Date(splitDate).getTime())/86400000)):null;
    const splitBars=splitDate?bars.filter(x=>new Date(x.date)>=new Date(splitDate)):[];
    const highAfterSplit=splitDate&&splitBars.length?Math.max(...splitBars.map(x=>x.h)):null;
    const short=await getShort(symbol,ref);

    const reportedShares=Number(ref.share_class_shares_outstanding??ref.weighted_shares_outstanding??ref.sharesOutstanding??ref.shares_outstanding);
    const marketCapRaw=Number(ref.market_cap??ref.marketCap??ref.trailingMarketCap);
    // Never label marketCap/price as a verified share count.
    const shares=Number.isFinite(reportedShares)&&reportedShares>0?reportedShares:NaN;
    const derivedCap=Number.isFinite(marketCapRaw)&&marketCapRaw>0?marketCapRaw:null;

    return {
      symbol,
      name:ref.name||symbol,
      price:last.c,
      change:prev.c?((last.c-prev.c)/prev.c)*100:null,
      volume:last.v,
      support,resistance,pivotSupport:support,pivotResistance:resistance,distance,
      stableBase,stability,stabilityNeed:4,
      rsi:rr,rvol:rv,ema20:e20,ema30:e30,ema50:e50,macd:mm,
      score:Math.min(100,Math.round(score)),
      supportOK:supportHold,rebound,macdOK:macdImproving,macdTrend:mm==null?"—":(macdImproving?"يتحسن":"يتراجع"),
      emaOK:emaRecovery,emaRecovery,volumeImproving,
      emaState:(last.c>e20?"فوق":"دون")+" 20 / "+(last.c>e30?"فوق":"دون")+" 30 / "+(last.c>e50?"فوق":"دون")+" 50",
      room:resistance>last.c*1.15,
      marketCap:derivedCap,
      sharesOutstanding:Number.isFinite(shares)?shares:null,
      float:short.float??null,
      ...short,
      splitDate,splitDays,
      splitFrom:latestSplit?.split_from??null,
      splitTo:latestSplit?.split_to??null,
      splitType:latestSplit?.adjustment_type??null,
      hasSplit:Boolean(splitDate),
      splitWatch:Boolean(splitDate&&splitDays<=100),
      highAfterSplit,
      companyName:ref.longName||ref.shortName||ref.name||symbol
    };
  };

  if(requested){
    try{
      let ref={};
      try { const qmap=await yahooQuotes([requested]); ref=qmap.get(requested)||{}; } catch {}
      if (!(Number(ref.sharesOutstanding??ref.shares_outstanding??ref.share_class_shares_outstanding)>0) || !(Number(ref.marketCap??ref.market_cap)>0)) {
        try { ref={...ref,...await yahooFundamentals(requested)}; } catch {}
      }
      const x=await buildOne(requested,ref);
      return out(200,{stocks:[x],errors:[],universeCount:1,source:"Yahoo Finance",tf,updated:new Date().toLocaleString("ar-SA")});
    }catch(e){
      return out(404,{stocks:[],errors:[requested+": "+e.message],universeCount:1,source:"Yahoo Finance",tf});
    }
  }

  const splitWatchSymbols=["NTCL","JZ","YYGH","SMSI","CETX","WXM","ICCM","SILO","FEMY","AMIX","FCUV","ORIS","VRAX","ASBP","AIXI","BNZI","OLOX","LNAI","FTFT","DKI"];
  let symbols=[];
  const referenceMap=new Map();
  const diagnostics={snapshot:0,priceVolume:0,referenceChecked:0,microcaps:0,bars:0,yahooQuotes:0};

  if(configured.length){
    symbols=[...new Set([...configured,...splitWatchSymbols])];
    try{
      const qmap=await yahooQuotes(symbols);
      for(const [k,v] of qmap) referenceMap.set(k,v);
      diagnostics.yahooQuotes=qmap.size;
    }catch(e){diagnostics.quoteError=String(e.message||e);}
  }


  if(!symbols.length && !configured.length){
    try {
      const ids=["most_actives","day_gainers","small_cap_gainers"];
      const seen=new Map();
      for(const id of ids){
        try {
          const quotes=await yahooScreener(id);
          diagnostics["screener_"+id]=quotes.length;
          for(const q of quotes){
            const symbol=String(q.symbol||"").toUpperCase();
            const price=Number(q.regularMarketPrice);
            const volume=Number(q.regularMarketVolume||q.averageDailyVolume3Month||0);
            if(/^[A-Z][A-Z0-9.\\-]{0,7}$/.test(symbol)&&price>=1&&price<=8&&volume>=100000){
              const prior=seen.get(symbol);
              // Keep the full screener record: its marketCap/fundamental fields may be present
              // even when Yahoo's separate /v7/finance/quote endpoint is blocked.
              if(!prior||volume>prior.volume) seen.set(symbol,{...q,symbol,price,volume});
            }
          }
        } catch(e) { diagnostics["screenerError_"+id]=String(e.message||e); }
      }
      const rows=[...seen.values()].sort((a,b)=>b.volume-a.volume).slice(0,20);
      for(const symbol of splitWatchSymbols){if(!seen.has(symbol))rows.push({symbol,price:null,volume:0,splitWatch:true});}
      diagnostics.yahooScreenerCandidates=rows.length;
      // Seed fundamentals from screener records before trying the often-blocked quote endpoint.
      for(const row of rows) referenceMap.set(row.symbol,row);
      diagnostics.screenerFundamentals=rows.filter(x=>Number(x.marketCap||x.market_cap)>0).length;
      if(rows.length){
        try {
          const qmap=await yahooQuotes(rows.map(x=>x.symbol));
          for(const [k,v] of qmap) referenceMap.set(k,{...(referenceMap.get(k)||{}),...v});
          diagnostics.yahooQuotes=qmap.size;
        } catch(e) {
          diagnostics.yahooQuoteFallbackError=String(e.message||e);
        }
        // Keep screener symbols even if Yahoo's separate quote endpoint rejects requests.
        symbols=rows.map(x=>x.symbol);
      }
    } catch(e) { diagnostics.yahooScreenerError=String(e.message||e); }
  }

  // Last-resort universe: still run the technical engine if Yahoo's predefined screeners are unavailable.
  if(!symbols.length && !configured.length){
    symbols=[...new Set([
      "NTCL","PN","FEMY","AMIX","SILO","PRFX","DXST","INUV","BGL","ATPC",
      "MTEN","AMOD","PTLE","SMSI","CETX","WXM","ICCM","VRAX","ORIS","YYGH",
      "FCUV","ASBP","AIX","JZ","CRE","SSM","CDLX","PMI","GDC","BMGL",...splitWatchSymbols
    ])];
    diagnostics.universeFallback="configured safety list; live price/volume filters still apply";
  }

  if(!symbols.length){
    diagnostics.message = "Yahoo Finance لم يُرجع قائمة أسهم قابلة للتحليل في هذه المحاولة.";
    return out(200,{stocks:[],errors:["لم تصل قائمة أسهم من Yahoo Finance: "+JSON.stringify(diagnostics)],universeCount:0,source:"Yahoo Finance",tf,diagnostics});
  }

  const results=[],errors=[];
  for(let i=0;i<symbols.length;i+=6){
    const batch=symbols.slice(i,i+6);
    const got=await Promise.all(batch.map(async symbol=>{
      try{
        let ref=referenceMap.get(symbol)||{};
        try {
          const qmap=await yahooQuotes([symbol]);
          ref={...ref,...(qmap.get(symbol)||{})};
        } catch {}
        if (!(Number(ref.sharesOutstanding??ref.shares_outstanding??ref.share_class_shares_outstanding)>0) || !(Number(ref.marketCap??ref.market_cap)>0)) {
          try { ref={...ref,...await yahooFundamentals(symbol)}; }
          catch(e) { diagnostics["fundamentals_"+symbol]=String(e.message||e); }
        }
        referenceMap.set(symbol,ref);
        const x=await buildOne(symbol,ref);
        diagnostics.bars++;
        return x;
      }catch(e){errors.push(symbol+": "+e.message);return null;}
    }));
    results.push(...got.filter(Boolean));
  }

  const beforeLimits=results.length;
  const eligible=results.filter(x=>{
    const cap=Number(x.marketCap), shares=Number(x.sharesOutstanding);
    const capKnown=Number.isFinite(cap)&&cap>0;
    const sharesKnown=Number.isFinite(shares)&&shares>0;
    // Exclude only when a reported value proves the stock is outside the requested limits.
    if(capKnown&&cap>=10000000) return false;
    if(sharesKnown&&shares>=5000000) return false;
    return true;
  });
  diagnostics.rejectedByMicrocapLimits=beforeLimits-eligible.length;
  diagnostics.rejectedMissingMarketCap=results.filter(x=>!(Number.isFinite(Number(x.marketCap))&&Number(x.marketCap)>0)).length;
  diagnostics.rejectedMissingShares=results.filter(x=>!(Number.isFinite(Number(x.sharesOutstanding))&&Number(x.sharesOutstanding)>0)).length;
  eligible.sort((a,b)=>{const as=a.splitDate&&Number(a.splitDays)<=100?1:0,bs=b.splitDate&&Number(b.splitDays)<=100?1:0;if(bs!==as)return bs-as;if(a.splitDate&&!b.splitDate)return -1;if(b.splitDate&&!a.splitDate)return 1;return Number(b.score||0)-Number(a.score||0);});

  if(!eligible.length) {
    diagnostics.fundamentalsMissing=beforeLimits>0?beforeLimits-diagnostics.rejectedByMicrocapLimits:0;
    diagnostics.message=beforeLimits===0
      ?"لم تصل شموع سعرية قابلة للتحليل من مصادر البيانات."
      :"وصلت بيانات فنية لـ"+beforeLimits+" سهم، لكن لم يتبقَّ سهم بعد تطبيق شرطي القيمة السوقية الأقل من 10 ملايين دولار وعدد الأسهم الأقل من 5 ملايين. غالباً بيانات القيمة السوقية/الأسهم غير متاحة أو لم تطابق الحدود.";
  }
  return out(200,{
    stocks:eligible,
    errors:errors.slice(0,12),
    universeCount:symbols.length,
    source:"Yahoo Finance",
    tf,
    updated:new Date().toLocaleString("ar-SA"),
    diagnostics
  });
};
