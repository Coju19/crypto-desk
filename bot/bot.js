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
globalThis.window = {}; // the page checks window.__deskServer; empty here
(0, eval)(engine + "\n;globalThis.E={simulate,liveCheck,yesterday,analyze,posValue,labData,LAB};");

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

// ---- long price history (Binance public market data, daily, back to each coin's listing) ----
// CoinGecko's free API only gives the last 365 days, so older days come from Binance's USDT pairs (USDT is about $1).
// Saved per coin in data/history/<id>.json as {sym, t0, c:[closes], v:[USD volumes in millions]}; value at day t = price at 00:00 UTC,
// the same convention as CoinGecko's daily points.
const BN = "https://data-api.binance.vision/api/v3/klines";
async function bn(sym, start) {
  for (let i = 0; i < 4; i++) {
    try { const r = await fetch(`${BN}?symbol=${sym}&interval=1d&limit=1000&startTime=${start}`);
      if (r.ok) return await r.json(); if (r.status === 400) return null; console.log(`Binance ${r.status} for ${sym}`); }
    catch (e) { console.log("Binance network error", e.message); }
    await sleep(3000 * (i + 1));
  }
  throw new Error("Binance kept failing for " + sym);
}
async function updateHistory(id, sym) {
  const f = `history/${id}.json`; let h = null; try { h = rd(f); } catch {}
  if (h && h.none) return h;
  if (!h) h = { sym: sym.toUpperCase() + "USDT", t0: null, c: [], v: [] };
  let start = h.t0 == null ? Date.UTC(2017, 0, 1) : (h.t0 + h.c.length * 86400) * 1000;
  const today = Date.parse(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  while (start <= today) {
    const k = await bn(h.sym, start);
    if (k === null) { console.log(`No Binance pair ${h.sym}`); h = { none: true, sym: h.sym }; break; }
    if (!k.length) break;
    for (const row of k) { const t = Math.round(row[0] / 1000);
      if (h.t0 == null) h.t0 = t;
      while (h.t0 + h.c.length * 86400 < t) { h.c.push(h.c.at(-1)); h.v.push(0); } // fill a missing day
      if (h.t0 + h.c.length * 86400 === t) { h.c.push(+(+row[1]).toPrecision(6)); h.v.push(+(+row[7] / 1e6).toPrecision(3)); } }
    start = k.at(-1)[0] + 864e5; if (k.length < 1000) break; await sleep(300);
  }
  if (!h.none && h.c.length && h.t0 + (h.c.length - 1) * 86400 === Math.round(today / 1000)) { h.c.pop(); h.v.pop(); } // today's open only
  fs.mkdirSync(path.join(DATA, "history"), { recursive: true }); wr(f, h); return h;
}
// put the older Binance days in front of CoinGecko's 365 days; old volumes are scaled to CoinGecko's level over the overlap
function longSeries(c, h) {
  if (!h || h.none || !h.c.length || !c.closes || !c.t0 || h.t0 >= c.t0) return { t0: c.t0, closes: c.closes, vols: c.vols };
  const n = Math.round((c.t0 - h.t0) / 86400); if (n > h.c.length) return { t0: c.t0, closes: c.closes, vols: c.vols };
  const r = []; if (c.vols) for (let i = 0; i < c.vols.length; i++) { const j = n + i; if (j < h.v.length && h.v[j] > 0 && c.vols[i] > 0) r.push(c.vols[i] / h.v[j]); }
  r.sort((a, b) => a - b); const k = r.length ? r[r.length >> 1] : 1;
  return { t0: h.t0, closes: [...h.c.slice(0, n), ...c.closes], vols: c.vols ? [...h.v.slice(0, n).map(x => +(x * k).toPrecision(3)), ...c.vols] : null };
}

(async () => {
  const errors = [], now = new Date().toISOString();
  S.watch = rd("watchlist.json").ids;
  Object.assign(S.settings, rd("settings.json"));
  for (const id of S.watch) { try { S.coins[id] = rd(`coins/${id}.json`); } catch { /* new coin */ } }
  const st = rd("paper.json");
  S.hist = {}; for (const id of S.watch) { try { S.hist[id] = rd(`history/${id}.json`); } catch {} }

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

  // long history: refreshed with the daily run, or fetched once for a new coin
  const histMissing = S.watch.some(id => !S.hist[id]);
  if (needDaily || histMissing) for (const id of S.watch) { const c = S.coins[id]; if (!c?.symbol || (!needDaily && S.hist[id])) continue;
    try { S.hist[id] = await updateHistory(id, c.symbol); } catch (e) { errors.push(`History for ${id}: ${e.message}`); } }

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
  const cgOnly = Object.fromEntries(S.watch.filter(id => S.coins[id]).map(id => [id, { t0: S.coins[id].t0, closes: S.coins[id].closes, vols: S.coins[id].vols }]));
  const long = Object.fromEntries(S.watch.filter(id => S.coins[id]).map(id => [id, Object.assign({}, S.coins[id], longSeries(S.coins[id], S.hist[id]))]));
  // backtest over the full history (heavy, so once a day here instead of on your phone)
  let lab = null; try { lab = rd("lab.json"); } catch {}
  if (!lab || needDaily || histMissing || process.env.FORCE_DAILY === "1" || lab.ids !== S.watch.join(",")) {
    const t = Date.now(); for (const id of S.watch) if (long[id]) S.coins[id] = long[id];
    const L = E.labData();
    // keep the file small for phones: round numbers, keep the explanation text only on the newest 150 trades
    const r = v => typeof v === "number" ? +v.toPrecision(6) : v, tr = L.bt.trades, cut = tr.length - 150;
    const bt = Object.assign({}, L.bt, { pos: {}, equity: L.bt.equity.map(e => ({ d: e.d, v: r(e.v) })),
      trades: tr.map((t, i) => { const o = {}; for (const [k, v] of Object.entries(t)) if (k !== "rules" && (k !== "why" || i >= cut)) o[k] = r(v); return o; }) });
    for (const [id, q] of Object.entries(L.bt.pos)) bt.pos[id] = q;
    lab = { at: now, ids: S.watch.join(","), bt, btFrom: L.btFrom, hold: L.hold.map(e => ({ d: e.d, v: r(e.v) })), score: L.score, key: "server" };
    wr("lab.json", lab); console.log(`Backtest from ${L.btFrom}: ${((Date.now() - t) / 1000).toFixed(1)}s`);
  }
  wr("desk.json", { at: now, status, paper: st, watchlist: { ids: S.watch }, settings: rd("settings.json"), coins: Object.fromEntries(S.watch.filter(id => S.coins[id]).map(id => [id, Object.assign({}, S.coins[id], cgOnly[id])])), lab });
  console.log(JSON.stringify({ at: now, equity: st.live.v, open: Object.keys(st.pos), closed: closed.map(t => t.coin + " " + t.why), errors }));
})().catch(e => { console.error(e); process.exit(1); });
