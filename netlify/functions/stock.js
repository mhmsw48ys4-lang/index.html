exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const tf = q.tf || "1d";
  const requestedSymbol = (q.symbol || "").trim().toUpperCase().replace(/[^A-Z0-9.\-]/g,"");
  const massiveKey = process.env.MASSIVE_API_KEY;
  const alphaKey = process.env.ALPHA_VANTAGE_API_KEY;
  const configured = (process.env.SCAN_SYMBOLS || "").split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);
  const fallbackSymbols = ["NTCL","PN","FEMY","AMIX","SILO","PRFX","DXST","INUV","BGL","ATPC","MTEN","AMOD","PTLE","SMSI","CETX","WXM","ICCM"];
  const headers = {"Access-Control-Allow-Origin":"*","Content-Type":"application/json","Cache-Control":"no-store"};
  const out=(status,body)=>({statusCode:status,headers,body:JSON.stringify(body)});

  const massive = async (path, params={}) => {
    if(!massiveKey) return null;
    const u = new URL("https://api.massive.com"+path);
    Object.entries({...params,apiKey:massiveKey}).forEach(([k,v])=>u.searchParams.set(k,v));
    const r = await fetch(u);
    if(!r.ok) throw new Error("Massive API "+r.status);
    return r.json();
  };

  const alpha = async (params) => {
    if(!alphaKey) return null;
    const u = new URL("https://www.alphavantage.co/query");
    Object.entries({...params,apikey:alphaKey}).forEach(([k,v])=>u.searchParams.set(k,v));
    const r=await fetch(u), j=await r.json();
    if(j["Error Message"]||j["Note"]||j["Information"]) throw new Error(j["Error Message"]||j["Note"]||j["Information"]);
    return j;
  };


  const yahoo = async (symbol) => {
    const end = Math.floor(Date.now()/1000);
    let periodDays = 420, interval = "1d";
    if(tf === "1w"){ periodDays = 1500; interval = "1wk"; }
    if(tf === "4h"){ periodDays = 30; interval = "60m"; }
    const start = end - periodDays*86400;
    const u = new URL("https://query1.finance.yahoo.com/v8/finance/chart/"+encodeURIComponent(symbol));
    u.searchParams.set("period1", String(start));
    u.searchParams.set("period2", String(end));
    u.searchParams.set("interval", interval);
    u.searchParams.set("events", "div,splits");
    u.searchParams.set("includeAdjustedClose", "true");
    const r = await fetch(u, {headers: {"User-Agent":"Mozilla/5.0"}});
    if(!r.ok) throw new Error("Yahoo Finance "+r.status);
    const j = await r.json();
    const res = j?.chart?.result?.[0];
    if(!res) throw new Error(j?.chart?.error?.description || "Yahoo data unavailable");
    const ts=res.timestamp||[], q=res.indicators?.quote?.[0]||{}, adj=res.indicators?.adjclose?.[0]?.adjclose||[];
    const raw=ts.map((t,i)=>({date:new Date(t*1000).toISOString(),o:+q.open?.[i],h:+q.high?.[i],l:+q.low?.[i],c:+(adj[i]??q.close?.[i]),v:+q.volume?.[i]||0}))
      .filter(x=>Number.isFinite(x.c)&&Number.isFinite(x.o)&&Number.isFinite(x.h)&&Number.isFinite(x.l));
    if(tf !== "4h") return raw.sort((a,b)=>a.date.localeCompare(b.date));
    const r4=[]; for(let i=0;i<raw.length;i+=4){const g=raw.slice(i,i+4);if(g.length===4)r4.push({date:g[3].date,o:g[0].o,h:Math.max(...g.map(x=>x.h)),l:Math.min(...g.map(x=>x.l)),c:g[3].c,v:g.reduce((s,x)=>s+x.v,0)})}
    return r4;
  };

  const dateDaysAgo = (days) => {
    const d=new Date(Date.now()-days*86400000);
    return d.toISOString().slice(0,10);
  };

  const normalize = (arr) => (arr||[]).map(x=>({
    date:new Date(x.t||x.date).toISOString(),
    o:+x.o,h:+x.h,l:+x.l,c:+x.c,v:+x.v||0
  })).sort((a,b)=>a.date.localeCompare(b.date));

  const ema=(a,p)=>{if(a.length<p)return null;let e=a.slice(0,p).reduce((s,x)=>s+x,0)/p,k=2/(p+1);for(let i=p;i<a.length;i++)e=a[i]*k+e*(1-k);return e};
  const rsi=(a,p=14)=>{if(a.length<=p)return null;let g=0,l=0;for(let i=1;i<=p;i++){let d=a[i]-a[i-1];g+=Math.max(d,0);l+=Math.max(-d,0)}let ag=g/p,al=l/p;for(let i=p+1;i<a.length;i++){let d=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p}return al===0?100:100-100/(1+ag/al)};
  const macd=(a)=>{const a12=ema(a,12),a26=ema(a,26);return a12==null||a26==null?null:a12-a26};

  async function getBarsMassive(symbol){
    let mult=1,span="day",days=420,limit=180;
    if(tf==="1w"){span="week";days=1500;limit=160}
    if(tf==="4h"){mult=4;span="hour";days=120;limit=180}
    const j=await massive("/v2/aggs/ticker/"+encodeURIComponent(symbol)+"/range/"+mult+"/"+span+"/"+dateDaysAgo(days)+"/"+dateDaysAgo(0),{adjusted:"true",sort:"asc",limit});
    return normalize(j.results);
  }

  async function getBarsAlpha(symbol){
    if(tf==="1w"){
      const j=await alpha({function:"TIME_SERIES_WEEKLY",symbol});
      return Object.entries(j?.["Weekly Time Series"]||{}).map(([date,v])=>({date:new Date(date).toISOString(),o:+v["1. open"],h:+v["2. high"],l:+v["3. low"],c:+v["4. close"],v:+v["5. volume"]})).sort((a,b)=>a.date.localeCompare(b.date));
    }
    if(tf==="4h"){
      const j=await alpha({function:"TIME_SERIES_INTRADAY",symbol,interval:"60min",outputsize:"full"});
      const raw=Object.entries(j?.["Time Series (60min)"]||{}).map(([date,v])=>({date:new Date(date).toISOString(),o:+v["1. open"],h:+v["2. high"],l:+v["3. low"],c:+v["4. close"],v:+v["5. volume"]})).sort((a,b)=>a.date.localeCompare(b.date));
      const r=[];for(let i=0;i<raw.length;i+=4){const g=raw.slice(i,i+4);if(g.length===4)r.push({date:g[3].date,o:g[0].o,h:Math.max(...g.map(x=>x.h)),l:Math.min(...g.map(x=>x.l)),c:g[3].c,v:g.reduce((s,x)=>s+x.v,0)})}return r;
    }
    const j=await alpha({function:"TIME_SERIES_DAILY",symbol,outputsize:"full"});
    const ts=j?.["Time Series (Daily)"]||j?.["Time Series (Daily Adjusted)"]||{};
    return Object.entries(ts).map(([date,v])=>({date:new Date(date).toISOString(),o:+v["1. open"],h:+v["2. high"],l:+v["3. low"],c:+(v["5. adjusted close"]||v["4. close"]),v:+(v["6. volume"]||v["5. volume"])})).sort((a,b)=>a.date.localeCompare(b.date));
  }

  async function universe(){
    if(configured.length) return configured;
    if(massiveKey){
      try{
        const j=await massive("/v2/snapshot/locale/us/markets/stocks/tickers",{});
        const rows=(j?.tickers||[]).map(x=>({symbol:x.ticker,price:x.day?.c??x.lastTrade?.p??null,volume:x.day?.v??0}));
        const candidates=rows.filter(x=>x.symbol&&x.price>=1&&x.price<=10&&x.volume>=100000).sort((a,b)=>b.volume-a.volume).slice(0,150);
        // لا نستخدم market cap من الـsnapshot. نفحص المرجع لكل مرشح، لكن لا نسقط السهم
        // إذا كانت بيانات المرجع ناقصة؛ عندها يمر للتحليل الفني، وتظهر بياناته إن توفرت.
        const checked=[];
        for(let i=0;i<candidates.length;i+=15){
          const batch=candidates.slice(i,i+15);
          const refs=await Promise.all(batch.map(async x=>{
            try{
              const rr=await massive("/v3/reference/tickers/"+encodeURIComponent(x.symbol),{});
              const z=rr?.results||{};
              const mc=Number(z.market_cap), so=Number(z.share_class_shares_outstanding??z.weighted_shares_outstanding);
              return {symbol:x.symbol,marketCap:mc,sharesOutstanding:so};
            }catch{return {symbol:x.symbol,marketCap:null,sharesOutstanding:null};}
          }));
          checked.push(...refs);
        }
        // نفضل المطابقين للـ10M، وإذا لم يرجع الـAPI هذه الحقول نسمح بالمرشح
        // حتى لا تصبح الشاشة صفرًا بسبب نقص بيانات مرجعية.
        const exact=checked.filter(x=>x.marketCap>0&&x.sharesOutstanding>0&&x.marketCap<=10000000&&x.sharesOutstanding<=10000000).map(x=>x.symbol);
        const picked=exact.slice(0,80);
        if(picked.length) return picked;
      }catch{}
    }
    try{
      const ids=["most_actives","day_gainers","day_losers"];
      const all=new Map();
      for(const scrIds of ids){
        const u=new URL("https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved");
        u.searchParams.set("scrIds",scrIds);
        u.searchParams.set("count","250");
        const r=await fetch(u,{headers:{"User-Agent":"Mozilla/5.0"}});
        if(!r.ok) continue;
        const j=await r.json();
        const rows=j?.finance?.result?.[0]?.quotes||[];
        for(const x of rows){
          const p=Number(x.regularMarketPrice), v=Number(x.regularMarketVolume||0);
          const mc=Number(x.marketCap??x.market_cap??x.marketCapRaw??0); const so=Number(x.sharesOutstanding??x.share_class_shares_outstanding??x.weighted_shares_outstanding??0); if(x.symbol&&p>=1&&p<=10&&v>=100000&&true) all.set(x.symbol,{symbol:x.symbol,price:p,volume:v,marketCap:mc,sharesOutstanding:so});
        }
      }
      const picked=[...all.values()].sort((a,b)=>(b.volume||0)-(a.volume||0)).slice(0,120).map(x=>x.symbol);
      if(picked.length) return picked;
    }catch{}
    return fallbackSymbols;
  }

  async function shortData(symbol){
    if(!massiveKey) return {};
    try{
      const calls=await Promise.allSettled([
        massive("/stocks/v1/short-volume",{ticker:symbol,limit:1}),
        massive("/stocks/v1/short-interest",{ticker:symbol,limit:1}),
        massive("/stocks/vX/float",{ticker:symbol,limit:1}),
        massive("/v3/reference/tickers/"+encodeURIComponent(symbol),{}),
        massive("/v3/reference/splits",{ticker:symbol,limit:20,sort:"execution_date.desc"})
      ]);
      const val=i=>calls[i]?.status==="fulfilled"?calls[i].value:null;
      const sv=val(0),si=val(1),fl=val(2),ref=val(3),splits=val(4);
      const a=sv?.results?.[0]||{}, b=si?.results?.[0]||{}, f=fl?.results?.[0]||{}, r=ref?.results||{}, sp=splits?.results?.[0]||null;
      const shortVolume=a.short_volume??a.shortVolume??null,totalVolume=a.total_volume??a.totalVolume??null;
      const shortRatio=a.short_volume_ratio!=null?Number(a.short_volume_ratio)/100:(shortVolume&&totalVolume?shortVolume/totalVolume:null);
      return {
        shortVolume, shortRatio, shortDate:a.date??a.trading_date??null,
        shortInterest:b.short_interest??null, daysToCover:b.days_to_cover??null,
        float:f.float??f.free_float??null,
        marketCap:r.market_cap??null, sharesOutstanding:r.share_class_shares_outstanding??r.weighted_shares_outstanding??null,
        companyName:r.name??null,
        splitDate:sp?.execution_date??null, splitFrom:sp?.split_from??null, splitTo:sp?.split_to??null
      };
    }catch{return {}}
  }

  async function profileData(symbol){
    if(!alphaKey) return {};
    try{
      const j=await alpha({function:"OVERVIEW",symbol});
      return {
        hq:[j.Address,j.City,j.State,j.Country].filter(Boolean).join(", ")||null,
        name:j.Name||null,
        country:j.Country==="China"?"CN":"US"
      };
    }catch{return {}}
  }

  const symbols=requestedSymbol?[requestedSymbol]:await universe();

  const results=[], errors=[];
  for(let i=0;i<symbols.length;i+=6){
    const batch=symbols.slice(i,i+6);
    const got=await Promise.all(batch.map(async symbol=>{
      try{
        const bars=massiveKey?await getBarsMassive(symbol):await yahoo(symbol);
        if(bars.length<35) throw new Error("بيانات تاريخية غير كافية");
        const close=bars.map(x=>x.c), vol=bars.map(x=>x.v), last=bars[bars.length-1];
        const e20=ema(close,20),e30=ema(close,30),e50=ema(close,50),e20p=ema(close.slice(0,-1),20),e30p=ema(close.slice(0,-1),30),e50p=ema(close.slice(0,-1),50),rr=rsi(close),mm=macd(close),mmp=macd(close.slice(0,-1));
        const win=bars.slice(-80);
        const pivotLows=[],pivotHighs=[];
        for(let i=2;i<win.length-2;i++){
          const b=win[i];
          if(b.l<=win[i-1].l&&b.l<=win[i-2].l&&b.l<=win[i+1].l&&b.l<=win[i+2].l) pivotLows.push({i,low:b.l});
          if(b.h>=win[i-1].h&&b.h>=win[i-2].h&&b.h>=win[i+1].h&&b.h>=win[i+2].h) pivotHighs.push({i,high:b.h});
        }
        const below=pivotLows.filter(x=>x.low<=last.c).sort((a,b)=>b.low-a.low);
        const above=pivotHighs.filter(x=>x.high>=last.c).sort((a,b)=>a.high-b.high);
        const support=(below[0]?.low??Math.min(...win.map(x=>x.l)));
        const resistance=(above[0]?.high??Math.max(...win.map(x=>x.h)));
        const av=vol.slice(-21,-1).reduce((s,x)=>s+x,0)/Math.max(1,vol.slice(-21,-1).length);
        const rv=av?last.v/av:null, distance=support?((last.c-support)/support)*100:999;
        let stability=0,stableBase=null;
        for(let p=bars.length-3;p>=2;p--){
          const b=bars[p];
          const isPivot=b.l<=bars[p-1].l&&b.l<=bars[p-2].l&&b.l<=bars[p+1].l&&b.l<=bars[p+2].l;
          const hadDrop=bars[p-2].c>bars[p-1].c&&bars[p-1].c>b.c;
          if(!isPivot||!hadDrop) continue;
          let count=1;
          for(let j=p+1;j<bars.length;j++){
            if(bars[j].l<b.l){count=0;break}
            count++;
          }
          if(count>0){stability=count;stableBase=b.l;break}
        }
        if(!stability){stability=1;stableBase=last.l}
        const prev=bars[Math.max(0,bars.length-2)], rebound=last.c>last.o&&last.c>prev.c, macdImproving=mm!=null&&mmp!=null&&mm>mmp, emaRecovery=(e20!=null&&e30!=null&&e50!=null&&e20p!=null&&e30p!=null&&e50p!=null)&&e20>e20p&&e30>e30p&&e50>e50p, volumeImproving=last.v>prev.v&&rv>=1.2, nearSupport=distance<=20, supportHold=last.c>support&&last.l<=support*1.05;
        // 100-point pivot score.
        let score=0;
        if(nearSupport)score+=20;else if(distance<=30)score+=12;
        if(supportHold)score+=10;
        if(macdImproving)score+=15;
        if(emaRecovery)score+=15;
        if(volumeImproving)score+=10;else if(rv>=1)score+=5;
        if(stability>=4)score+=10;else if(stability>=3)score+=7;else if(stability>=2)score+=4;
        if(rebound)score+=10;
        if(resistance>last.c*1.15)score+=5;
        if(last.v>=500000)score+=5;
        const sd=await shortData(symbol);
        if(!requestedSymbol && (sd.marketCap==null || sd.sharesOutstanding==null || Number(sd.marketCap)>10000000 || Number(sd.sharesOutstanding)>10000000)) return null;
        const profile=requestedSymbol?await profileData(symbol):{};
        const splitDays=sd.splitDate?Math.max(0,Math.floor((Date.now()-new Date(sd.splitDate).getTime())/86400000)):null;
        return {symbol,name:profile.name||sd.companyName||symbol,hq:profile.hq||null,country:profile.country||"US",price:last.c,change:bars.length>1?((last.c-bars[bars.length-2].c)/bars[bars.length-2].c)*100:null,volume:last.v,gap:bars.length>1&&bars[bars.length-2].c?((last.o-bars[bars.length-2].c)/bars[bars.length-2].c)*100:null,support,resistance,distance,pivotSupport:support,pivotResistance:resistance,stableBase,rsi:rr,rvol:rv,ema20:e20,ema30:e30,ema50:e50,macd:mm,stability,stabilityNeed:4,score:Math.min(100,Math.round(score)),supportOK:supportHold,rebound,macdOK:macdImproving,macdTrend:mm!=null?(macdImproving?"يتحسن":"يتراجع"):"—",emaOK:emaRecovery,emaRecovery,volumeImproving,emaState:(last.c>e20?"فوق":"دون")+" 20 / "+(last.c>e30?"فوق":"دون")+" 30 / "+(last.c>e50?"فوق":"دون")+" 50",room:resistance>last.c*1.15,afterHours:null,highAfterSplit:sd.splitDate?Math.max(...bars.filter(z=>new Date(z.date)>=new Date(sd.splitDate)).map(z=>z.h),last.h):null,...sd,splitDays};
      }catch(e){errors.push(symbol+":"+e.message);return null}
    }));
    results.push(...got.filter(Boolean));
  }
  results.sort((a,b)=>b.score-a.score);
  if(requestedSymbol && !results.length){ return out(404,{stocks:[],updated:new Date().toLocaleString("ar-SA"),tf,source:massiveKey?"Massive":"Yahoo Finance",errors:errors.length?errors:[requestedSymbol+": لا توجد بيانات"],universeCount:1}); }
  return out(200,{stocks:results,updated:new Date().toLocaleString("ar-SA"),tf,source:massiveKey?"Massive":"Yahoo Finance",errors:errors.slice(0,10),universeCount:symbols.length});
};