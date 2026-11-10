# INITS ($INITS) — takes your initials. every time.

One-file site (`index.html`) in the termkit style, session layout, ledger theme (deep green). `og.png` and `fav.png` must sit next to it.

## Fill in before launch

At the top of the last `<script>` in `index.html`:

```js
const CONFIG = {
  ca: "DZiNSWQi6GKERWMi7WGY5kNPykMQXHb6nmpc5C7JdGrQ",  // contract address (set). Buy buttons: pump.fun for a ...pump CA, Jupiter otherwise
  x: "https://x.com/",     // the project's X account
  site: "https://www.takeinits.fun",  // shows on every receipt card and in the "post on X" text, with a ?w=<wallet> link
                           // with a ?w=<wallet> link that opens that wallet's receipt
  ...
};
```

## What's real

| Part | Source | Status |
|---|---|---|
| Receipt (scan + replay + card) | public Solana RPC (publicnode, fallback mainnet-beta), GeckoTerminal candles | live, no keys |
| 2x watch on open bags | DexScreener prices every 15 s, sound and browser notification | live, no keys |
| Launch counter + log | PumpPortal free stream (`subscribeNewToken`) | live, no keys |
| Auto-sell engine | — | preview, labeled on the site |
| Sample receipt | synthetic charts | labeled SAMPLE · PREVIEW |

How the number is counted: each buy is a lot. The first candle that starts after the buy and whose high reaches 2x that buy's price sells enough to return the buy's SOL. Your own sells are mirrored on what the INITS track still holds. "Gave back" = sum over coins where INITS beats what you actually got (plus open bags at the last price). Coins where you did better are counted separately; the net is on the card. Top 12 coins by SOL in, from the last 100/250/500 transactions.

## Deploy

GitHub → Vercel, Framework: Other, no build command, output = the folder with `index.html`.

## Check after deploy

- Fonts: JetBrains Mono loads (headline and the receipt card).
- X preview: paste the URL into a post draft, `og.png` should show.
- Live data: the top bar should count pump.fun launches within seconds. Run a receipt on a wallet you know. GeckoTerminal allows ~30 calls/min, so a 12-coin receipt takes about 30 s; that's expected.
- If publicnode rate-limits under load, put a free RPC from Helius/QuickNode first in `CONFIG.rpc` (needs a key in the URL, so keep it domain-locked).

## Editing

The deployed page is `index.html` with CSS and JS inlined. Sources live in `src/`:
edit `src/index.src.html`, `src/site.css`, `src/engine.js` or `src/termkit.js`, then rebuild from the repo root:

```bash
python3 src/build.py src && mv src/index.html index.html
```
