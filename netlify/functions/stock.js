exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const tf = q.tf || "1d";
  const requested = String(q.symbol || "").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g, "");
  const massiveKey = process.env.MASSIVE_API_KEY;
  const alphaKey = process.env.ALPHA_VANTAGE_API_KEY;
  const configured = String(process.env.SCAN_SYMBOLS || "").split(",").map(s => s.trim().toUpperCase()).filter(Boolean);

  const headers = {
    "Access-Control-Allow-Origin": "*",
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  };
  const out = (status, body) => ({ statusCode: status, headers, body: JSON.stringify(body) });

  const massive = async (path, params = {}) => {
    if (!massiveKey) return null;
    const u = new URL("https://api.massive.com" + path);
    u.searchParams.set("apiKey", massiveKey);
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") u.searchParams.set(k, String(v));
    }
    const r = await fetch(u);
    const text = await r.text();
    let j = {};
    try { j = JSON.parse(text); } catch {}
    if (!r.ok) throw new Error("Massive " + r.status + (j?.error ? ": " + j.error : ""));
    return j;
  };

  const alpha = async (params) => {
    if (!alphaKey) return null;
    const u = new URL("https://www.alphavantage.co/query");
    for (const [k, v] of Object.entries({ ...params, apikey: alphaKey })) u.searchParams.set(k, String(v));
    const r = await fetch(u);
    const j = await r.json();
    if (j["Error Message"] || j["Note"] || j["Information"]) throw new Error(j["Error Message"] || j["Note"] || j["Information"]);
    return j;
  };

  const dateAgo = days => new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);

  const normalize = rows => (rows || []).map(x => ({
    date: new Date(x.t || x.date).toISOString(),
    o: Number(x.o), h: Number(x.h), l: Number(x.l), c: Number(x.c), v: Number(x.v || 0)
  })).filter(x => [x.o,x.h,x.l,x.c].every(Number.isFinite)).sort((a,b) => a.date.localeCompare(b.date));

  const yahooBars = async symbol => {
    const end = Math.floor(Date.now()/1000);
    let days = 420, interval = "1d";
    if (tf === "1w") { days = 1500; interval = "1wk"; }
    if (tf === "4h") { days = 60; interval = "60m"; }
    const u = new URL("https://query1.finance.yahoo.com/v8/finance/chart/" + encodeURIComponent(symbol));
    u.searchParams.set("period1", String(end - days * 86400));
    u.searchParams.set("period2", String(end));
    u.searchParams.set("interval", interval);
    u.searchParams.set("events", "div,splits");
    const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!r.ok) throw new Error("Yahoo " + r.status);
    const j = await r.json();
    const z = j?.chart?.result?.[0];
    if (!z) throw new Error("لا توجد بيانات سعر");
    const ts = z.timestamp || [], a = z.indicators?.quote?.[0] || {};
    const raw = ts.map((t,i)=>({
      date:new Date(t*1000).toISOString(), o:Number(a.open?.[i]), h:Number(a.high?.[i]),
      l:Number(a.low?.[i]), c:Number(a.close?.[i]), v:Number(a.volume?.[i]||0)
    })).filter(x=>[x.o,x.h,x.l,x.c].every(Number.isFinite));
    if (tf !== "4h") return raw.sort((a,b)=>a.date.localeCompare(b.date));
    const r4=[];
    for(let i=0;i<raw.length;i+=4){
      const g=raw.slice(i,i+4); if(g.length<4) continue;
      r4.push({date:g[3].date,o:g[0].o,h:Math.max(...g.map(x=>x.h)),l:Math.min(...g.map(x=>x.l)),c:g[3].c,v:g.reduce((s,x)=>s+x.v,0)});
    }
    return r4;
  };

  const getBars = async symbol => {
    if (!massiveKey) return yahooBars(symbol);
    let mult=1, span="day", days=420, limit=500;
    if(tf==="1w"){span="week";days=1500;limit=500;}
    if(tf==="4h"){mult=4;span="hour";days=120;limit=500;}
    const j=await massive("/v2/aggs/ticker/"+encodeURIComponent(symbol)+"/range/"+mult+"/"+span+"/"+dateAgo(days)+"/"+dateAgo(0),{
      adjusted:"true", sort:"asc", limit
    });
    const bars=normalize(j?.results);
    if(bars.length>=35) return bars;
    return yahooBars(symbol);
  };

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

  const getReference = async symbol => {
    if(!massiveKey) return {};
    try {
      const j=await massive("/v3/reference/tickers/"+encodeURIComponent(symbol),{});
      return j?.results || {};
    } catch { return {}; }
  };

  const getSplits = async symbol => {
    if(!massiveKey) return [];
    try {
      const j=await massive("/stocks/v1/splits",{ticker:symbol,limit:100,sort:"execution_date.desc"});
      return j?.results || [];
    } catch { return []; }
  };

  const getShort = async symbol => {
    if(!massiveKey) return {};
    const [sv,si,fl]=await Promise.allSettled([
      massive("/stocks/v1/short-volume",{ticker:symbol,limit:1}),
      massive("/stocks/v1/short-interest",{ticker:symbol,limit:1}),
      massive("/stocks/vX/float",{ticker:symbol,limit:1})
    ]);
    const val=x=>x.status==="fulfilled"?x.value:null;
    const a=val(sv)?.results?.[0]||{}, b=val(si)?.results?.[0]||{}, f=val(fl)?.results?.[0]||{};
    const shortVolume=a.short_volume??a.shortVolume??null;
    const totalVolume=a.total_volume??a.totalVolume??null;
    return {
      shortVolume,
      shortRatio:a.short_volume_ratio!=null?Number(a.short_volume_ratio)/100:(shortVolume&&totalVolume?shortVolume/totalVolume:null),
      shortDate:a.date??a.trading_date??null,
      shortInterest:b.short_interest??null,
      daysToCover:b.days_to_cover??null,
      float:f.float??f.free_float??null
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
    if(resistance>last.c*1.15)score+=5;
    if(last.v>=500000)score+=5;

    const splits=await getSplits(symbol);
    const latestSplit=splits[0]||null;
    const splitDate=latestSplit?.execution_date||null;
    const splitDays=splitDate?Math.max(0,Math.floor((Date.now()-new Date(splitDate).getTime())/86400000)):null;
    const splitBars=splitDate?bars.filter(x=>new Date(x.date)>=new Date(splitDate)):[];
    const highAfterSplit=splitDate&&splitBars.length?Math.max(...splitBars.map(x=>x.h)):null;
    const short=await getShort(symbol);

    const shares=Number(ref.share_class_shares_outstanding??ref.weighted_shares_outstanding);
    const marketCap=Number(ref.market_cap);
    const derivedCap=Number.isFinite(marketCap)&&marketCap>0?marketCap:(Number.isFinite(shares)&&shares>0?shares*last.c:null);

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
      highAfterSplit,
      companyName:ref.name||symbol
    };
  };

  // Direct search: never apply the scanner's micro-cap gate.
  if(requested){
    try{
      const ref=await getReference(requested);
      const x=await buildOne(requested,ref);
      return out(200,{stocks:[x],errors:[],universeCount:1,source:massiveKey?"Massive":"Yahoo Finance",tf,updated:new Date().toLocaleString("ar-SA")});
    }catch(e){
      return out(404,{stocks:[],errors:[requested+": "+e.message],universeCount:1,source:massiveKey?"Massive":"Yahoo Finance",tf});
    }
  }

  let symbols=[];
  const diagnostics={snapshot:0,priceVolume:0,referenceChecked:0,microcaps:0,bars:0};

  if(configured.length){
    symbols=configured;
  } else if(massiveKey){
    try{
      // لا نعتمد على Full Market Snapshot لأنه متاح في خطط Massive محددة.
      // نستخدم Grouped Daily الذي يرجع جميع أسهم السوق في طلب واحد.
      let grouped=null, usedDate=null;
      for(let back=0;back<7 && !grouped;back++){
        const d=new Date(Date.now()-back*86400000).toISOString().slice(0,10);
        try{
          const j=await massive("/v2/aggs/grouped/locale/us/market/stocks/"+d,{adjusted:"true"});
          if(j?.results?.length){grouped=j;usedDate=d;}
        }catch{}
      }
      const rows=(grouped?.results||[]).map(x=>({
        symbol:String(x.T||"").toUpperCase(),
        price:Number(x.c),volume:Number(x.v||0),open:Number(x.o),high:Number(x.h),low:Number(x.l)
      })).filter(x=>/^[A-Z][A-Z0-9.\-]{0,7}$/.test(x.symbol));
      diagnostics.snapshot=rows.length;
      const pv=rows.filter(x=>x.price>=1&&x.price<=10&&x.volume>=100000).sort((a,b)=>b.volume-a.volume);
      diagnostics.priceVolume=pv.length;
      diagnostics.groupedDate=usedDate||null;

      // نفحص أفضل المرشحين بالمرجع فقط، ثم نطبق:
      // Market Cap <= $10M + Shares Outstanding <= 10M.
      const checked=[];
      for(let i=0;i<pv.length && checked.length<300;i+=25){
        const batch=pv.slice(i,i+25);
        const refs=await Promise.all(batch.map(async x=>{
          const r=await getReference(x.symbol);
          const shares=Number(r.share_class_shares_outstanding??r.weighted_shares_outstanding);
          const reportedCap=Number(r.market_cap);
          const cap=reportedCap>0?reportedCap:(shares>0?shares*x.price:null);
          return {...x,ref:r,shares,marketCap:cap};
        }));
        checked.push(...refs);
      }
      diagnostics.referenceChecked=checked.length;
      const micro=checked.filter(x=>x.marketCap>0&&x.marketCap<=10000000&&x.shares>0&&x.shares<=10000000);
      diagnostics.microcaps=micro.length;
      symbols=micro.sort((a,b)=>b.volume-a.volume).slice(0,80).map(x=>x.symbol);
    }catch(e){
      diagnostics.error=String(e.message||e);
    }
  }  if(!symbols.length){
    return out(200,{stocks:[],errors:["لم يجد الفاحص أسهماً مطابقة بعد مرحلة السعر/الحجم/القيمة السوقية","تشخيص: "+JSON.stringify(diagnostics)],universeCount:0,source:"Massive",tf,diagnostics});
  }

  const results=[], errors=[];
  for(let i=0;i<symbols.length;i+=5){
    const batch=symbols.slice(i,i+5);
    const got=await Promise.all(batch.map(async symbol=>{
      try{
        const ref=await getReference(symbol);
        const x=await buildOne(symbol,ref);
        const cap=Number(x.marketCap), shares=Number(x.sharesOutstanding);
        if(!(cap>0&&cap<=10000000&&shares>0&&shares<=10000000)) return null;
        diagnostics.bars++;
        return x;
      }catch(e){errors.push(symbol+": "+e.message);return null;}
    }));
    results.push(...got.filter(Boolean));
  }

  results.sort((a,b)=>b.score-a.score);
  return out(200,{
    stocks:results,
    errors:errors.slice(0,12),
    universeCount:symbols.length,
    source:"Massive",
    tf,
    updated:new Date().toLocaleString("ar-SA"),
    diagnostics
  });
};
