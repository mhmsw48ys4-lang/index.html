exports.handler = async (event) => {
  const q = event.queryStringParameters || {};
  const apiKey = process.env.ALPHA_VANTAGE_API_KEY;
  const massiveKey = process.env.MASSIVE_API_KEY;
  const tf = q.tf || "1d";
  const symbols = (q.symbol ? q.symbol : (process.env.SCAN_SYMBOLS || "NTCL,PN,FEMY,AMIX,SILO,PRFX,DXST,INUV,BGL,ATPC,MTEN,AMOD,PTLE,SMSI,CETX,WXM,ICCM"))
    .split(",").map(s=>s.trim().toUpperCase()).filter(Boolean);

  const headers = {"Access-Control-Allow-Origin":"*","Content-Type":"application/json","Cache-Control":"no-store"};
  const out = (status, body) => ({statusCode:status, headers, body:JSON.stringify(body)});

  if (!apiKey) return out(500,{error:"مفتاح ALPHA_VANTAGE_API_KEY غير موجود في Netlify"});

  const av = async (params) => {
    const u = new URL("https://www.alphavantage.co/query");
    for (const [k,v] of Object.entries({...params,apikey:apiKey})) u.searchParams.set(k,v);
    const r = await fetch(u);
    const j = await r.json();
    if (j["Error Message"]) throw new Error("رمز السهم غير صحيح أو غير موجود");
    if (j["Note"]) throw new Error("تم تجاوز حد Alpha Vantage مؤقتًا");
    return j;
  };

  const rows = async (symbol) => {
    let j, ts;
    if (tf === "1w") {
      j = await av({function:"TIME_SERIES_WEEKLY",symbol});
      ts = j["Weekly Time Series"];
      if (!ts) return [];
      return Object.entries(ts).map(([date,v])=>({date,o:+v["1. open"],h:+v["2. high"],l:+v["3. low"],c:+v["4. close"],v:+v["5. volume"]})).sort((a,b)=>a.date.localeCompare(b.date));
    }
    if (tf === "4h") {
      j = await av({function:"TIME_SERIES_INTRADAY",symbol,interval:"60min",outputsize:"full"});
      ts = j["Time Series (60min)"];
      if (!ts) return [];
      const raw = Object.entries(ts).map(([date,v])=>({date,o:+v["1. open"],h:+v["2. high"],l:+v["3. low"],c:+v["4. close"],v:+v["5. volume"]})).sort((a,b)=>a.date.localeCompare(b.date));
      const result=[];
      for(let i=0;i<raw.length;i+=4){const g=raw.slice(i,i+4);if(g.length<4)continue;result.push({date:g[g.length-1].date,o:g[0].o,h:Math.max(...g.map(x=>x.h)),l:Math.min(...g.map(x=>x.l)),c:g[g.length-1].c,v:g.reduce((s,x)=>s+x.v,0)})}
      return result;
    }
    j = await av({function:"TIME_SERIES_DAILY_ADJUSTED",symbol,outputsize:"full"});
    ts = j["Time Series (Daily)"] || j["Time Series (Daily Adjusted)"];
    if (!ts) return [];
    return Object.entries(ts).map(([date,v])=>({date,o:+v["1. open"],h:+v["2. high"],l:+v["3. low"],c:+(v["5. adjusted close"]||v["4. close"]),v:+v["6. volume"]||+v["5. volume"]})).sort((a,b)=>a.date.localeCompare(b.date));
  };

  const ema=(a,p)=>{if(a.length<p)return null;let e=a.slice(0,p).reduce((x,y)=>x+y,0)/p,k=2/(p+1);for(let i=p;i<a.length;i++)e=a[i]*k+e*(1-k);return e};
  const rsi=(a,p=14)=>{if(a.length<=p)return null;let g=0,l=0;for(let i=1;i<=p;i++){const d=a[i]-a[i-1];if(d>=0)g+=d;else l-=d}let ag=g/p,al=l/p;for(let i=p+1;i<a.length;i++){const d=a[i]-a[i-1];ag=(ag*(p-1)+Math.max(d,0))/p;al=(al*(p-1)+Math.max(-d,0))/p}return al===0?100:100-(100/(1+ag/al))};
  const macd=(a)=>{if(a.length<35)return null;let e12=ema(a,12),e26=ema(a,26);return e12!=null&&e26!=null?e12-e26:null};

  async function shortData(symbol){
    if(!massiveKey) return {};
    try{
      const call=async(path,params={})=>{const u=new URL("https://api.massive.com"+path);for(const[k,v]of Object.entries({...params,apiKey:massiveKey}))u.searchParams.set(k,v);const r=await fetch(u);return r.ok?r.json():null};
      const [sv,si,fl]=await Promise.all([
        call("/stocks/v1/short-volume",{ticker:symbol,limit:1}),
        call("/stocks/v1/short-interest",{ticker:symbol,limit:1}),
        call("/stocks/v1/float",{ticker:symbol,limit:1})
      ]);
      const a=sv?.results?.[0]||sv?.data?.[0]||{}, b=si?.results?.[0]||si?.data?.[0]||{}, f=fl?.results?.[0]||fl?.data?.[0]||{};
      const shortVolume=a.short_volume??a.shortVolume??null,totalVolume=a.total_volume??a.totalVolume??null;
      return {shortVolume,shortRatio:shortVolume&&totalVolume?shortVolume/totalVolume:null,shortDate:a.trading_date??a.date??null,shortInterest:b.short_interest??b.shortInterest??null,float:f.float??f.free_float??null,borrowFee:b.borrow_fee??b.borrowFee??null};
    }catch{return {}}
  }

  try{
    const stocks=[];
    for(const symbol of symbols){
      try{
        const r=await rows(symbol); if(r.length<35) continue;
        const c=r.map(x=>x.c), v=r.map(x=>x.v||0), last=r[r.length-1];
        const e20=ema(c,20),e30=ema(c,30),e50=ema(c,50),rr=rsi(c),mm=macd(c);
        const window=r.slice(-60), support=Math.min(...window.map(x=>x.l)), resistance=Math.max(...window.map(x=>x.h));
        const avg=v.slice(-21,-1).reduce((a,b)=>a+b,0)/Math.max(1,v.slice(-21,-1).length), rv=avg?last.v/avg:null;
        let stability=0; for(let i=r.length-1;i>=0;i--){if(r[i].l>=support*.97)stability++;else break}
        const distance=support?((last.c-support)/support)*100:999;
        let score=0;
        if(rr>=23&&rr<=27)score+=20;else if(rr>=20&&rr<=35)score+=10;
        if(distance<=20)score+=15;else if(distance<=30)score+=8;
        if(mm!=null&&mm>=0)score+=10;
        if(e20!=null&&last.c>e20)score+=8;if(e30!=null&&last.c>e30)score+=7;if(e50!=null&&last.c>e50)score+=7;
        if(rv>=1.5)score+=10;else if(rv>=1.2)score+=5;if(stability>=4)score+=10;else if(stability>=2)score+=5;if(last.v>=500000)score+=5;
        const short=await shortData(symbol);
        stocks.push({symbol,name:symbol,country:"US",price:last.c,change:r.length>1?((last.c-r[r.length-2].c)/r[r.length-2].c)*100:null,volume:last.v,support,resistance,distance,rsi:rr,rvol:rv,ema20:e20,ema30:e30,ema50:e50,macd:mm,stability,stabilityNeed:4,score:Math.min(100,Math.round(score)),supportOK:true,rebound:last.c>support,macdOK:mm!=null&&mm>=0,macdTrend:mm!=null?(mm>=0?"إيجابي":"سلبي"):"—",emaOK:last.c>e20||last.c>e30||last.c>e50,emaState:(last.c>e20?"فوق":"تحت")+" 20 / "+(last.c>e30?"فوق":"تحت")+" 30 / "+(last.c>e50?"فوق":"تحت")+" 50",room:resistance>last.c*1.15,...short});
      }catch{}
    }
    stocks.sort((a,b)=>b.score-a.score);
    return out(200,{stocks,updated:new Date().toLocaleString("ar-SA"),tf});
  }catch(e){return out(500,{error:e.message||"حدث خطأ في الاتصال"});}
};