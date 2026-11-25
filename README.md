# Crypto Desk

A crypto watchlist with buy/hold/sell signals, plus a **paper-trading bot with fake $100**.
Paper only: nothing here connects to an exchange, and there are no API keys or passwords in this repo.
The signals are automated indicators, not financial advice.

## How it works

- **The bot** (`bot/bot.js`) runs on GitHub Actions every 5 minutes, for free, without any computer of yours being on.
  - Every run it fetches live prices from CoinGecko and does a **live check**: an open position that hit its stop-loss, target or liquidation price is closed. It only saves (commits) when something happened, or every ~30 minutes to keep the page's numbers fresh, so the repo and the page don't churn every 5 minutes.
  - Once a day, after the daily close (00:00 UTC, so the first run after 01:00 Berlin time), it reloads the 1-year daily charts and processes the finished day. **This is the only time new trades open**: a spot buy, a leveraged long or a short (max 5×), picked by the same rules as the page.
  - It saves everything in `data/` and commits it to this repo, so the history of every run is in the commit log.
- **History:** CoinGecko's free API only gives 365 days, so the bot also keeps each coin's full daily history from Binance's public market data (USDT pairs, back to 2017 or the coin's listing) in `data/history/`. The Strategy lab backtest runs over all of it once a day on GitHub and saves the result in `data/lab.json`, so your phone doesn't have to crunch years of data. Signals and the 30-day simulation still use the most recent year on purpose: they should react to today's market, not 2018's.
- **The page** (`index.html`) is published by GitHub Pages. It reads the bot's results from `data/desk.json` and loads live prices, charts, whale wallets, options and Polymarket odds in your browser. Your own trade log on the page is saved in that browser only (use "Back up data").
- The trading rules live in one place: the bot reads its engine straight out of `index.html`, so the page and the bot always agree.

## Files

| File | What it is |
|---|---|
| `data/paper.json` | The bot's state: cash, open positions, all trades, daily equity |
| `data/status.json` | Last run time, current value, open coins, warnings, a log of recent trades |
| `data/watchlist.json` | The coins the bot trades (CoinGecko ids). Edit this file on GitHub to add or remove coins. |
| `data/settings.json` | Budget, risk per trade (%) and spot fee (%) |
| `data/coins/*.json` | Price stats and 1-year daily chart per coin |
| `data/history/*.json` | Full daily history per coin (Binance), used for the long backtest |
| `data/lab.json` | The long backtest result shown in the Strategy lab |
| `data/desk.json` | Everything above in one file, for the page |
| `.github/workflows/bot.yml` | The schedule |

## Everyday use

- **See the bot:** open your GitHub Pages link (Settings → Pages shows it), e.g. `https://<username>.github.io/crypto-desk/`. Add it to your phone's home screen.
- **Run it right now:** Actions tab → *Paper bot* → *Run workflow*.
- **Add a coin:** edit `data/watchlist.json`, add the CoinGecko id (the last part of the coin's coingecko.com URL), commit. The next run loads its chart.
- **Reset to a fresh $100:** replace `data/paper.json` with `{"budget":100,"cash":100,"pos":{},"trades":[],"equity":[],"lastDate":"<yesterday, YYYY-MM-DD>","startDate":"<today>"}`.

## Setup (once)

1. Settings → Pages → *Deploy from a branch* → `main`, folder `/ (root)` → Save.
2. Actions tab → enable workflows if GitHub asks.
3. Optional but recommended: a free CoinGecko "Demo" API key (coingecko.com → Developer dashboard) makes the bot less likely to be rate-limited. Add it under Settings → Secrets and variables → Actions → *New repository secret*, name `COINGECKO_API_KEY`. The bot works without it, just slower.

## Good to know

- GitHub can start scheduled runs a few minutes late, sometimes more at busy times.
- GitHub pauses schedules in a repo with no activity for 60 days. The bot's own commits normally count as activity; if you ever see a "workflow disabled" banner on the Actions tab, press *Enable*.
- Fees, funding and liquidation are estimates (0.1% per side, 0.03%/day funding, 2.5% maintenance margin). Daily closes miss intraday wicks; the 5-minute live check catches most of them.
- Carried over from the Claude version on 2026-11-25: started 2026-11-23 with $100; 3 shorts at 5× opened on 2026-11-24 (UNI 4.843, COMP 17.50, LINK 9.008).
