exports.handler = async function () {
  const token = process.env.FINNHUB_API_KEY;
  if (!token) return { statusCode: 500, headers: {"content-type":"application/json"}, body: JSON.stringify({error:"FINNHUB_API_KEY غير مضبوط في Netlify"}) };
  try {
    const now = Math.floor(Date.now()/1000);
    const url = "https://finnhub.io/api/v1/news?category=general&token="+encodeURIComponent(token);
    const r = await fetch(url);
    if (!r.ok) throw new Error("Finnhub HTTP "+r.status);
    const raw = await r.json();
    const items = Array.isArray(raw) ? raw : [];
    const seen = new Set();
    const candidates = [];
    for (const n of items) {
      const symbols = Array.isArray(n.related) ? n.related : String(n.related||"").split(",").map(s=>s.trim()).filter(Boolean);
      for (const symbol of symbols) {
        const s = symbol.toUpperCase();
        if (!/^[A-Z.]{1,8}$/.test(s) || seen.has(s)) continue;
        seen.add(s);
        candidates.push({symbol:s, news:n});
      }
      if (candidates.length >= 35) break;
    }
    const checked = await Promise.all(candidates.map(async x => {
      try {
        const q = await fetch("https://finnhub.io/api/v1/quote?symbol="+encodeURIComponent(x.symbol)+"&token="+encodeURIComponent(token));
        if (!q.ok) return null;
        const d = await q.json();
        const price = Number(d.c);
        if (!(price >= 1 && price <= 7)) return null;
        return {...x.news, symbol:x.symbol, price, change:Number(d.dp||0)};
      } catch { return null; }
    }));
    const out = checked.filter(Boolean);
    const dedupe = new Set();
    const news = out.filter(x => {
      const key = x.symbol+"|"+String(x.headline||"").toLowerCase().replace(/\W/g,"").slice(0,140);
      if (dedupe.has(key)) return false; dedupe.add(key); return true;
    }).sort((a,b)=>Number(b.datetime||0)-Number(a.datetime||0)).slice(0,30)
      .map(x => ({...x, source:x.source, url:x.url, hot:/FDA|approval|approved|contract|agreement|acquisition|merger|offering|trial|clinical|partnership|deal|guidance|results/i.test(String(x.headline||""))}));
    return {statusCode:200,headers:{"content-type":"application/json","cache-control":"no-store"},body:JSON.stringify({updated:new Date().toISOString(),news})};
  } catch(e) { return {statusCode:500,headers:{"content-type":"application/json"},body:JSON.stringify({error:e.message})}; }
};