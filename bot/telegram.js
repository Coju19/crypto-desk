// Telegram messages for the paper bot. Turned on by the repo secret TELEGRAM_BOT_TOKEN (never put the token in a file here: the repo is public).
// - trade opened / closed: one message each
// - morning summary once a day (first run after 08:00 Berlin time)
// - "/status" (or any message) sent to the bot gets a summary back on the next run
// The chat is found automatically: the first person who presses Start in the bot is remembered in data/telegram.json
// (or set the secret TELEGRAM_CHAT_ID). Messages from any other chat are ignored.
const TOKEN = process.env.TELEGRAM_BOT_TOKEN || "";
const PAGE = process.env.PAGE_URL || "";
const API = m => `https://api.telegram.org/bot${TOKEN}/${m}`;

async function tg(method, body) {
  const r = await fetch(API(method), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body || {}) });
  const j = await r.json().catch(() => ({}));
  if (!j.ok) throw new Error(`Telegram ${method}: ${j.description || r.status}`);
  return j.result;
}
const esc = s => String(s ?? "").replace(/[&<>]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));
const money = v => (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const price = v => { const a = Math.abs(v); return "$" + v.toLocaleString("en-US", { maximumFractionDigits: a >= 1000 ? 0 : a >= 1 ? 3 : 6 }); };
const pm = v => (v >= 0 ? "+" : "") + money(v);
const sign = v => (v >= 0 ? "+" : "") + v.toFixed(2);
const TYPE = { spot: "Spot buy", long: "Long", short: "Short" };

function sym(S, id) { return (S.coins[id]?.symbol || id).toUpperCase(); }
function tradeText(S, st, t) {
  const lev = t.type === "spot" ? "" : ` ${(+t.lev).toFixed(1)}×`, acct = st.live?.v ?? st.cash;
  if (t.side === "open") return `🟢 <b>Opened ${TYPE[t.type] || t.type}${lev} ${sym(S, t.coin)}</b> at ${price(t.price)}\n`
    + `Put in ${money(t.margin ?? t.usd)}${t.type !== "spot" ? ` (controls ${money(t.usd)})` : ""} · stop ${price(t.stop)} · target ${price(t.target)}${t.liqPrice ? ` · liquidation ${price(t.liqPrice)}` : ""}\n`
    + `<i>${esc((t.why || "").split(/\. (Stop|\$)/)[0])}</i>\nAccount: ${money(acct)} (fake money)`;
  const icon = t.liq ? "💥" : t.pnl >= 0 ? "✅" : "🔴";
  return `${icon} <b>Closed ${TYPE[t.type] || t.type}${lev} ${sym(S, t.coin)}</b> at ${price(t.price)}: <b>${pm(t.pnl)}</b> after ${t.days} day${t.days === 1 ? "" : "s"}\n`
    + `<i>${esc(t.why)}</i>\nAccount: ${money(acct)} (fake money)`;
}

async function fearGreed() {
  try { const r = await fetch("https://api.alternative.me/fng/?limit=1"); const d = (await r.json()).data[0]; return `${d.value}/100 (${d.value_classification})`; }
  catch { return null; }
}
async function summaryText(S, E, st, title) {
  const v = st.live?.v ?? st.cash, b = st.budget, lines = [];
  lines.push(`📊 <b>${title}</b>`);
  lines.push(`Paper bot: <b>${money(v)}</b> (${sign((v / b - 1) * 100)}% since ${st.startDate}) · cash ${money(st.cash)}`);
  const pos = Object.entries(st.pos || {});
  if (pos.length) for (const [id, q] of pos) {
    const pl = E.posValue(q) - q.cost;
    lines.push(`• ${TYPE[q.type] || q.type}${q.type === "spot" ? "" : " " + (+q.lev).toFixed(1) + "×"} ${sym(S, id)}: entry ${price(q.entry)}, now ${price(q.last)}, ${pm(pl)} · stop ${price(q.stop)} / target ${price(q.target)}`);
  } else lines.push("• No open trades");
  const closed = st.trades.filter(t => t.pnl != null); if (closed.length) lines.push(`Closed trades: ${closed.length}, ${closed.filter(t => t.pnl > 0).length} won`);
  const btc = S.coins.bitcoin, fg = await fearGreed();
  lines.push("");
  if (btc) lines.push(`BTC ${price(btc.price)} (${sign(btc.ch24 ?? 0)}% 24h, ${sign(btc.ch7 ?? 0)}% 7d)`);
  if (fg) lines.push(`Market mood (Fear &amp; Greed): ${fg}`);
  const buys = [], sells = [], ideas = [];
  for (const id of S.watch) { const c = S.coins[id]; const an = c && E.analyze(c); if (!an) continue;
    if (an.signal === "BUY") buys.push(sym(S, id)); else if (an.signal === "SELL") sells.push(sym(S, id));
    const p = E.pickTrade(an); if (p && !st.pos[id]) ideas.push(`${sym(S, id)} ${p.type === "spot" ? "spot buy" : p.type + " " + p.lev.toFixed(1) + "×"} (score ${an.score > 0 ? "+" : ""}${an.score})`); }
  lines.push(`Signals: buy ${buys.join(", ") || "none"} · sell/avoid ${sells.join(", ") || "none"}`);
  lines.push(`Trade setups right now: ${ideas.join(", ") || "none"} <i>(the bot only acts on them at the daily close)</i>`);
  if (PAGE) lines.push(`\n<a href="${PAGE}">Open Crypto Desk</a>`);
  lines.push(`<i>Paper trading only, not financial advice.</i>`);
  return lines.join("\n");
}

// Returns true when data/telegram.json changed (so the run should be saved).
async function run({ S, E, st, events, rd, wr, log }) {
  if (!TOKEN) return false;
  let cfg = {}; try { cfg = rd("telegram.json"); } catch {}
  const before = JSON.stringify(cfg);
  const send = async text => { await tg("sendMessage", { chat_id: process.env.TELEGRAM_CHAT_ID || cfg.chatId, text, parse_mode: "HTML", disable_web_page_preview: true }); };
  // incoming messages
  let ask = false;
  try {
    const ups = await tg("getUpdates", { offset: cfg.offset || 0, timeout: 0, allowed_updates: ["message"] });
    const me = cfg.chatId ? null : await tg("getMe"); if (me) log(`Telegram bot @${me.username}: ${ups.length} new message(s)`);
    for (const u of ups) { cfg.offset = u.update_id + 1; const m = u.message; if (!m || m.chat?.type !== "private") continue;
      if (!process.env.TELEGRAM_CHAT_ID && !cfg.chatId) { cfg.chatId = m.chat.id; cfg.hello = true; }
      if (m.chat.id === (process.env.TELEGRAM_CHAT_ID ? +process.env.TELEGRAM_CHAT_ID : cfg.chatId)) ask = true; }
  } catch (e) { log("Telegram updates: " + e.message); }
  if (!(process.env.TELEGRAM_CHAT_ID || cfg.chatId)) { log("Telegram: no chat yet. Open your bot in Telegram and press Start."); return JSON.stringify(cfg) !== before; }
  try {
    if (cfg.hello) { await send(`👋 Connected! I'm your Crypto Desk paper bot. I'll message you when I open or close a (fake-money) trade, send a short summary every morning, and answer /status.`); delete cfg.hello; ask = true; }
    for (const t of events) await send(tradeText(S, st, t));
    const berlin = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Berlin", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false }).formatToParts(new Date());
    const g = k => berlin.find(p => p.type === k).value, day = `${g("year")}-${g("month")}-${g("day")}`, hour = +g("hour");
    if (hour >= 8 && cfg.lastSummary !== day) { await send(await summaryText(S, E, st, "Good morning: Crypto Desk " + day)); cfg.lastSummary = day; }
    else if (ask) await send(await summaryText(S, E, st, "Crypto Desk now"));
  } catch (e) { log("Telegram send: " + e.message); }
  const changed = JSON.stringify(cfg) !== before;
  if (changed) wr("telegram.json", cfg, true);
  return changed;
}
module.exports = { run, tradeText, summaryText };
