// Crypto Desk paper bot, GitHub Actions version. PAPER TRADING ONLY: it never talks to an exchange.
// Usage: node bot/bot.js            (run from the repo root; no npm install needed, Node 20+)
// Every run:
//   1. fetches live prices for the watchlist from CoinGecko (one request),
//   2. if the 1-year daily charts are older than 20 hours, or the bot is behind a day, refreshes them
//      (paced, with retries) and lets the bot process every finished day: this is where NEW trades open,
//   3. runs the live check: closes open positions that hit their stop, target or liquidation price,
//   4. writes data/paper.json, data/coins/*.json, data/status.json and data/desk.json (what the page reads).
// The trading rules are the page's own engine, read straight out of index.html, so page and bot always agree.
const fs = require("fs"), path = require("path");
const ROOT = path.join(__dirname, ".."), DATA = path.join(ROOT, "data");
const rd = p => JSON.parse(fs.readFileSync(path.join(DATA, p), "utf8"));
const wr = (p, v, pretty) => fs.writeFileSync(path.join(DATA, p), JSON.stringify(v, null, pretty ? 1 : 0) + "\n");
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- load the engine from the page ----
const html = fs.readFileSync(path.join(ROOT, "index.html"), "utf8");
const pageScript = html.split("<script>").map(s => s.split("</script>")[0]).find(s => s.includes("const HOST ="));
if (!pageScript) throw new Error("Could not find the Crypto Desk engine in index.html");
const engine = pageScript.split("/* ---------- rendering")[0]
  .replace("const S = ", "globalThis.S = ").replace("const $ =", "globalThis.$ =");
(0, eval)(engine + "\n;globalThis.E={simulate,liveCheck,yesterday,analyze,posValue};");

// ---- CoinGecko ----
const CG = "https://api.coingecko.com/api/v3";
const KEY = process.env.COINGECKO_API_KEY || ""; // optional free "Demo" key; works without one
async function cg(url, tries = 6) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(CG + url, { headers: Object.assign({ accept: "application/json", "user-agent": "crypto-desk-paper-bot" }, KEY ? { "x-cg-demo-api-key": KEY } : {}) });
      if (r.ok) return await r.json();
      console.log(`CoinGecko ${r.status} on ${url.split("?")[0]}, retry ${i + 1}`);
      await sleep(r.status === 429 ? 30000 + i * 15000 : 5000);
    } catch (e) { console.log("network error", e.message); await sleep(5000); }
  }
  throw new Error("CoinGecko kept failing for " + url.split("?")[0]);
}

(async () => {
  const errors = [], now = new Date().toISOString();
  S.watch = rd("watchlist.json").ids;
  Object.assign(S.settings, rd("settings.json"));
  for (const id of S.watch) { try { S.coins[id] = rd(`coins/${id}.json`); } catch { /* new coin */ } }
  const st = rd("paper.json");

  // 1. live prices and stats
  const mk = await cg(`/coins/markets?vs_currency=usd&ids=${S.watch.map(encodeURIComponent).join(",")}&price_change_percentage=24h,7d,30d`);
  const prices = {};
  for (const m of mk) {
    const old = S.coins[m.id] || {};
    const c = Object.assign(old, { id: m.id, symbol: m.symbol, name: m.name, price: m.current_price, mcap: m.market_cap, rank: m.market_cap_rank, vol: m.total_volume,
      high24: m.high_24h, low24: m.low_24h, ch24: m.price_change_percentage_24h_in_currency, ch7: m.price_change_percentage_7d_in_currency,
      ch30: m.price_change_percentage_30d_in_currency, circ: m.circulating_supply, total: m.total_supply, max: m.max_supply, ath: m.ath, athDate: m.ath_date,
      updatedAt: now, source: "CoinGecko" });
    // keep today's point in the chart = live price (same as the page does)
    if (c.closes && c.t0) { const idx = Math.floor((Date.now() / 1000 - c.t0) / 86400); if (idx === c.closes.length - 1) c.closes[idx] = +(+m.current_price).toPrecision(6); }
    S.coins[m.id] = c; prices[m.id] = m.current_price;
  }
  const missing = S.watch.filter(id => !prices[id]); if (missing.length) errors.push("No price from CoinGecko for: " + missing.join(", "));

  // 2. daily charts + new trades on the daily close
  const y = E.yesterday();
  const behind = st.lastDate < y, dayStart = Date.parse(now.slice(0, 10) + "T00:00:00Z");
  // a chart is old after 20 hours, or when a new day has closed since it was fetched and the bot still has to process that day
  const chartOld = id => { const c = S.coins[id]; if (!c?.closes || !c.chartAt) return true; const t = new Date(c.chartAt).getTime();
    return Date.now() - t > 20 * 3600e3 || (behind && t < dayStart); };
  const needDaily = st.lastDate < y || S.watch.some(chartOld) || process.env.FORCE_DAILY === "1";
  let newTrades = [], dailyRan = false;
  if (needDaily) {
    for (const id of S.watch) {
      if (!chartOld(id)) continue;
      try {
        await sleep(KEY ? 2500 : 7000);
        const ch = await cg(`/coins/${encodeURIComponent(id)}/market_chart?vs_currency=usd&days=365&interval=daily`);
        if (ch?.prices?.length) { const c = S.coins[id] || (S.coins[id] = { id });
          c.t0 = Math.round(ch.prices[0][0] / 1000); c.closes = ch.prices.map(p => +(+p[1]).toPrecision(6));
          c.vols = (ch.total_volumes || []).map(v => +(v[1] / 1e6).toPrecision(3)); c.chartAt = now; }
      } catch (e) { errors.push(`Chart for ${id}: ${e.message}`); }
    }
    if (st.lastDate < y) {
      // only run the day logic when every watchlist coin has fresh data, so no day is processed with a coin missing
      const stale = S.watch.filter(id => S.coins[id]?.closes && chartOld(id));
      if (stale.length) errors.push("Waiting for fresh charts before the daily run: " + stale.join(", "));
      else {
        const n0 = st.trades.length, before = st.lastDate;
        E.simulate(S.watch.filter(id => S.coins[id]?.closes), st, before, y);
        st.equity = st.equity.slice(-400); newTrades = st.trades.slice(n0); dailyRan = true;
        console.log(`Daily run ${before} -> ${st.lastDate}: ${newTrades.length} new trade events`);
      }
    }
  }

  // 3. live check (stops, targets, liquidations) on live prices
  const closed = E.liveCheck(st, prices, now);
  st.updatedAt = now;

  // 4. write everything
  for (const id of S.watch) if (S.coins[id]) wr(`coins/${id}.json`, S.coins[id]);
  wr("paper.json", st, true);
  let log = []; try { log = rd("status.json").log || []; } catch {}
  const events = [...newTrades, ...closed].map(t => `${t.date} ${t.side} ${t.type} ${t.coin} @ ${t.price}${t.pnl != null ? ` P/L ${t.pnl.toFixed(2)}` : ""}`);
  if (events.length || errors.length) log = [...log, { at: now, events, errors }].slice(-100);
  const status = { lastRun: now, dailyRan, lastDate: st.lastDate, equity: st.live.v, cash: +st.cash.toFixed(4), open: Object.keys(st.pos), errors, log };
  wr("status.json", status, true);
  wr("desk.json", { at: now, status, paper: st, watchlist: { ids: S.watch }, settings: rd("settings.json"), coins: Object.fromEntries(S.watch.filter(id => S.coins[id]).map(id => [id, S.coins[id]])) });
  console.log(JSON.stringify({ at: now, equity: st.live.v, open: Object.keys(st.pos), closed: closed.map(t => t.coin + " " + t.why), errors }));
})().catch(e => { console.error(e); process.exit(1); });
