/* engine.js: the INITS receipt engine. Public Solana RPC + GeckoTerminal candles + DexScreener prices. No keys, nothing to sign. */
const INITS = (() => {
  const WSOL = "So11111111111111111111111111111111111111112";
  const STABLE = new Set(["EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
  const RENT = 2039280; // token-account rent: paid when the account opens, refunded when it closes. Not a trade.
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const isAddr = s => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s || "");

  // ---------- Solana RPC (rotates endpoints, backs off on rate limits) ----------
  function makeRpc(urls) {
    let i = 0;
    return async function rpc(method, params, tries = 0) {
      const url = urls[i % urls.length];
      try {
        const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        if (r.status === 429 || r.status >= 500) throw new Error("busy " + r.status);
        const j = await r.json();
        if (j.error) { const e = new Error(j.error.message || "rpc error"); if (!/limit|busy|timeout|429|too many/i.test(e.message)) e.fatal = true; throw e; }
        return j.result;
      } catch (e) {
        if (e.fatal || tries >= 6) throw e;
        i++; await sleep(300 * (tries + 1)); return rpc(method, params, tries + 1);
      }
    };
  }
  // newest transaction version the RPC is asked for; raised on the fly if the chain moves past it
  let MAXV = 1;
  async function getTx(rpc, sig) {
    for (let k = 0; k < 3; k++) {
      try { return await rpc("getTransaction", [sig, { encoding: "json", maxSupportedTransactionVersion: MAXV, commitment: "confirmed" }]); }
      catch (e) { const m = /Transaction version \((\d+)\)/i.exec(e.message || ""); if (m && +m[1] > MAXV) { MAXV = +m[1]; continue; } throw e; }
    }
    return null;
  }
  async function pool(items, n, fn) {
    let k = 0; const out = new Array(items.length);
    await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (k < items.length) { const j = k++; out[j] = await fn(items[j], j); } }));
    return out;
  }

  // ---------- one transaction -> one trade (or nothing) ----------
  // A trade = exactly one non-SOL mint moved in the wallet, and SOL moved the other way.
  function parseTx(tx, wallet, sig) {
    if (!tx || !tx.meta || tx.meta.err || !tx.blockTime) return null;
    const m = tx.transaction.message, la = tx.meta.loadedAddresses || {};
    const keys = [...m.accountKeys.map(k => typeof k === "string" ? k : k.pubkey), ...(la.writable || []), ...(la.readonly || [])];
    const wi = keys.indexOf(wallet); if (wi < 0) return null;
    let lam = tx.meta.postBalances[wi] - tx.meta.preBalances[wi];
    const acct = {};
    for (const b of tx.meta.preTokenBalances || []) if (b.owner === wallet)
      acct[b.accountIndex] = { mint: b.mint, dec: b.uiTokenAmount.decimals, pre: Number(b.uiTokenAmount.amount), post: 0, hadPre: true, hasPost: false };
    for (const b of tx.meta.postTokenBalances || []) if (b.owner === wallet) {
      const a = acct[b.accountIndex] || (acct[b.accountIndex] = { mint: b.mint, dec: b.uiTokenAmount.decimals, pre: 0, hadPre: false });
      a.post = Number(b.uiTokenAmount.amount); a.hasPost = true; }
    const moved = {};
    for (const a of Object.values(acct)) {
      if (a.post === a.pre && a.hadPre === !!a.hasPost) continue;
      if (a.mint === WSOL) { lam += a.post - a.pre; continue; }          // wrapped SOL counts as SOL
      const d = (a.post - a.pre) / 10 ** a.dec;
      const e = moved[a.mint] || (moved[a.mint] = { d: 0, created: false, closed: false });
      e.d += d; if (!a.hadPre) e.created = true; if (!a.hasPost) e.closed = true;
    }
    const mints = Object.keys(moved).filter(k => Math.abs(moved[k].d) > 0);
    if (mints.length !== 1 || STABLE.has(mints[0])) return null;
    const mint = mints[0], e = moved[mint];
    if (e.created) lam += RENT; if (e.closed) lam -= RENT;
    const sol = lam / 1e9;
    // the venue: owner of the token account that moved the other way (a pump.fun bonding curve, a PumpSwap pool…)
    const other = {};
    for (const b of tx.meta.preTokenBalances || []) if (b.mint === mint && b.owner && b.owner !== wallet) other[b.accountIndex] = { owner: b.owner, pre: Number(b.uiTokenAmount.amount), post: 0 };
    for (const b of tx.meta.postTokenBalances || []) if (b.mint === mint && b.owner && b.owner !== wallet) { const o = other[b.accountIndex] || (other[b.accountIndex] = { owner: b.owner, pre: 0 }); o.post = Number(b.uiTokenAmount.amount); }
    let venue = null, best = 0;
    for (const o of Object.values(other)) { const d = o.post - o.pre; if (d && Math.sign(d) === -Math.sign(e.d) && Math.abs(d) > best) { best = Math.abs(d); venue = o.owner; } }
    if (e.d > 0 && sol < -0.0005) return { t: tx.blockTime, mint, side: "buy", tokens: e.d, sol: -sol, sig, venue };
    if (e.d < 0 && sol > 0.0005) return { t: tx.blockTime, mint, side: "sell", tokens: -e.d, sol, sig, venue };
    return null;
  }

  // ---------- trades -> one position per coin ----------
  function positions(trades) {
    const by = {};
    for (const t of trades) (by[t.mint] ||= []).push(t);
    const out = [];
    for (const [mint, ts] of Object.entries(by)) {
      ts.sort((a, b) => a.t - b.t);
      const first = ts.findIndex(t => t.side === "buy"); if (first < 0) continue;   // bought before the window: skip
      const list = ts.slice(first);
      let tok = 0, bought = 0, solIn = 0, solOut = 0;
      for (const t of list) {
        if (t.side === "buy") { tok += t.tokens; bought += t.tokens; solIn += t.sol; }
        else { const q = Math.min(t.tokens, tok); if (q <= 0) continue; solOut += t.sol * q / t.tokens; tok -= q; }
      }
      const open = tok > bought * .005;
      out.push({ mint, trades: list, solIn, solOut, bought, held: open ? tok : 0, open, t0: list[0].t, t1: open ? null : list[list.length - 1].t, entry: solIn / bought });
    }
    return out.sort((a, b) => b.solIn - a.solIn);
  }

  // ---------- the replay: every buy is a lot; when the chart touches thr x that lot's price, sell enough to return its SOL ----------
  // Your own sells are mirrored on whatever the inits track still holds. Candles that start before a buy never count for it.
  function simulate(pos, candles, last, thr = 2, sec = 0) {
    const lots = []; let aTok = 0, aOut = 0, iOut = 0, trig = 0, peak = 0;
    const ev = [...pos.trades.map(t => ({ k: 0, t: t.t, tr: t })), ...candles.map(c => ({ k: 1, t: c.s, c }))].sort((a, b) => a.t - b.t || a.k - b.k);
    for (const e of ev) {
      if (e.k === 0) {
        const tr = e.tr;
        if (tr.side === "buy") { lots.push({ t: tr.t, price: tr.sol / tr.tokens, cost: tr.sol, orig: tr.tokens, tok: tr.tokens, taken: false }); aTok += tr.tokens; }
        else {
          if (aTok <= 0) continue;
          const q = Math.min(tr.tokens, aTok), f = q / aTok, px = tr.sol / tr.tokens;
          aOut += q * px; aTok -= q;
          let iq = 0; for (const l of lots) { const d = l.tok * f; l.tok -= d; iq += d; }
          iOut += iq * px;
        }
      } else {
        const c = e.c;
        if (c.s + sec > pos.t0 && (pos.t1 == null || c.s <= pos.t1)) peak = Math.max(peak, c.h / pos.entry);   // informational: includes the candle the buy landed in
        for (const l of lots) {
          if (l.taken || c.s < l.t || l.tok <= 0) continue;
          if (c.h >= thr * l.price) { const q = Math.min(l.tok, l.orig / thr); l.tok -= q; iOut += q * thr * l.price; l.taken = true; trig++; }
        }
      }
    }
    const iTok = lots.reduce((s, l) => s + l.tok, 0);
    const px = last || 0, actual = aOut + aTok * px, withInits = iOut + iTok * px;
    return { actual, withInits, diff: withInits - actual, triggered: trig, lots: lots.length, peak, endMult: pos.solIn ? actual / pos.solIn : 0 };
  }

  // ---------- GeckoTerminal (public, ~30 calls/min: one call at a time, spaced) ----------
  const TFS = [["minute", 1, 60], ["minute", 5, 300], ["minute", 15, 900], ["hour", 1, 3600], ["hour", 4, 14400], ["hour", 12, 43200], ["day", 1, 86400]];
  const pickTF = span => TFS.find(([, , s]) => span / s <= 980) || TFS[TFS.length - 1];
  function makeGT(base = "https://api.geckoterminal.com/api/v2", gapMs = 2600) {
    let last = 0;
    async function get(path, tries = 0) {
      const wait = Math.max(0, last + gapMs - Date.now()); if (wait) await sleep(wait); last = Date.now();
      let r;
      try { r = await fetch(base + path, { headers: { accept: "application/json" } }); }
      catch (e) { if (tries < 3) { await sleep(7000 * (tries + 1)); return get(path, tries + 1); } throw new Error("chart data unreachable"); }   // a rate-limited reply has no CORS header, so it surfaces as a network error
      if (r.status === 429) { if (tries < 3) { await sleep(10000 * (tries + 1)); return get(path, tries + 1); } throw new Error("chart data is rate limited, try again in a minute"); }
      if (r.status === 404) return null;
      if (!r.ok) throw new Error("chart data " + r.status);
      return r.json();
    }
    return { get };
  }
  async function tokenInfo(gt, mints) {
    const info = {};
    for (let i = 0; i < mints.length; i += 30) {
      const j = await gt.get(`/networks/solana/tokens/multi/${mints.slice(i, i + 30).join(",")}?include=top_pools`);
      if (!j) continue;
      const pools = {}; for (const p of j.included || []) if (p.type === "pool") pools[p.id] = p;
      for (const d of j.data || []) {
        const all = (d.relationships?.top_pools?.data || []).map(r => pools[r.id]).filter(Boolean);
        const solSide = p => { const b = p.relationships?.base_token?.data?.id, q = p.relationships?.quote_token?.data?.id; return !b && !q ? true : [b, q].includes("solana_" + WSOL); };
        info[d.attributes.address] = { symbol: d.attributes.symbol, name: d.attributes.name, pools: all.filter(solSide).map(p => p.attributes.address) };
      }
    }
    return info;
  }
  const DEAD = new Set();   // addresses that are not pools (404): never ask twice
  async function candlesFor(gt, poolAddr, mint, from, to) {
    const [tf, agg, sec] = pickTF(Math.max(120, to - from));
    if (DEAD.has(poolAddr)) return { sec, list: [] };
    const j = await gt.get(`/networks/solana/pools/${poolAddr}/ohlcv/${tf}?aggregate=${agg}&before_timestamp=${Math.ceil(to + sec)}&limit=1000&currency=token&token=${mint}`);
    if (!j) { DEAD.add(poolAddr); return { sec, list: [] }; }
    // prices come in the pool's other token: only SOL pools count
    const m = j.meta || {}, other = m.base?.address === mint ? m.quote : m.quote?.address === mint ? m.base : null;
    if (other && other.address !== WSOL) return { sec, list: [], notSol: other.symbol || "?" };
    const list = (j?.data?.attributes?.ohlcv_list || []).map(([s, o, h, l, c]) => ({ s, o: +o, h: +h, c: +c })).filter(c => c.s + sec >= from && c.h > 0);
    return { sec, list: list.sort((a, b) => a.s - b.s) };
  }
  // sanity: a wick can't be more than 4x the candle's body or the close before it (bad prints happen)
  function clean(list) {
    return list.map((c, i) => { const ref = Math.max(c.o || c.c, c.c, i ? list[i - 1].c : c.c); return { ...c, h: Math.min(c.h, ref * 4) }; });
  }

  // ---------- DexScreener (public): live price in SOL for open bags ----------
  async function dexPrices(mints) {
    const out = {};
    for (let i = 0; i < mints.length; i += 30) {
      const r = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(",")}`);
      if (!r.ok) throw new Error("prices " + r.status);
      for (const p of (await r.json()) || []) {
        const m = p.baseToken?.address; if (!m || p.quoteToken?.address !== WSOL || !+p.priceNative) continue;
        const liq = p.liquidity?.usd || 0; if (!out[m] || liq > out[m].liq) out[m] = { price: +p.priceNative, liq, sym: p.baseToken.symbol, url: p.url };
      }
    }
    return out;
  }

  // ---------- full scan ----------
  async function scan(wallet, o, say = () => {}) {
    const rpc = makeRpc(o.rpc), gt = makeGT(o.gtBase, o.gtGap);
    say("sig", "reading signatures");
    const raw = (await rpc("getSignaturesForAddress", [wallet, { limit: Math.min(1000, o.depth) }]) || []).slice(0, o.depth);
    const sigs = raw.filter(s => !s.err), failedN = raw.length - sigs.length;
    say("sig", `${raw.length} transactions found` + (failedN ? ` · ${failedN} failed on-chain, skipped` : ""), true);
    if (!sigs.length) return { wallet, depth: o.depth, rawN: raw.length, txN: 0, tradeN: 0, coinN: 0, priced: [] };
    let done = 0, skipped = 0, lastErr = "";
    const txs = await pool(sigs, o.concurrency || 4, async s => {
      let tx = null; try { tx = await getTx(rpc, s.signature); } catch (e) { skipped++; lastErr = e.message || String(e); }
      done++; if (done % 5 === 0 || done === sigs.length) say("tx", `reading transactions ${done}/${sigs.length}` + (skipped ? ` · ${skipped} unreadable` : ""), done === sigs.length);
      return tx ? parseTx(tx, wallet, s.signature) : null;
    });
    if (skipped === sigs.length) throw new Error(lastErr || "couldn't read any transaction");
    const trades = txs.filter(Boolean), pos = positions(trades);
    say("trades", `${trades.length} trades across ${pos.length} coins`, true);
    const top = pos.slice(0, o.maxCoins || 12);
    if (!top.length) return { wallet, depth: o.depth, rawN: raw.length, txN: sigs.length, tradeN: trades.length, coinN: 0, priced: [] };
    say("px", "looking up charts");
    let info = {};
    try { info = await tokenInfo(gt, top.map(p => p.mint)); } catch (e) { say("px", "chart data unreachable: " + e.message, true, true); }
    const now = Math.floor(Date.now() / 1000), priced = [];
    for (let i = 0; i < top.length; i++) {
      const p = top[i], meta = info[p.mint] || { symbol: p.mint.slice(0, 4), pools: [] }, sym = (meta.symbol || "?").toUpperCase();
      say("px", `pricing ${i + 1}/${top.length} · $${sym}`, i === top.length - 1);
      const to = p.open ? now : p.t1, row = { mint: p.mint, sym, pos: p, candles: [], last: 0, sec: 60 };
      const uniq = a => [...new Set(a.filter(Boolean))];
      const venues = uniq(p.trades.map(t => t.venue)), tops = meta.pools || [];
      const cands = uniq([...venues, ...tops]).slice(0, 3), tried = new Set();
      try {
        for (const addr of cands) {
          tried.add(addr);
          const c = await candlesFor(gt, addr, p.mint, p.t0, to);
          if (c.notSol) row.notSol = c.notSol;
          if (c.list.length) { if (!row.candles.length) row.sec = c.sec; row.candles = row.candles.concat(c.list); }
          const first = row.candles.length ? Math.min(...row.candles.map(x => x.s)) : Infinity;
          const startOK = first <= p.t0 + row.sec;                                      // covers the first buy
          const endOK = !p.open || tops.includes(addr) || !tops.some(a => !tried.has(a)); // open bag: also want the live pool
          if (startOK && endOK) break;
        }
        row.candles = clean(row.candles.sort((a, b) => a.s - b.s));
        // units check: the chart near the first buy must be close to what the wallet actually paid
        if (row.candles.length) { const near = row.candles.reduce((a, c) => Math.abs(c.s - p.t0) < Math.abs(a.s - p.t0) ? c : a), k = near.c / p.entry;
          if (!(k > .05 && k < 20)) { row.candles = []; row.err = "chart in another unit"; } }
        row.last = row.candles.length ? row.candles[row.candles.length - 1].c : 0;
      } catch (e) { row.err = e.message; }
      if (!row.candles.length) row.err ||= row.notSol ? `paired with $${row.notSol}, not SOL` : "no chart";
      priced.push(row);
    }
    return { wallet, depth: o.depth, rawN: raw.length, txN: sigs.length, tradeN: trades.length, coinN: pos.length, priced, at: now };
  }

  // ---------- scan -> receipt numbers (re-run instantly for another trigger) ----------
  function summarize(S, thr = 2) {
    const rows = S.priced.map(r => {
      if (r.err) return { ...r, ok: false, solIn: r.pos.solIn };
      return { ...r, ok: true, solIn: r.pos.solIn, ...simulate(r.pos, r.candles, r.pos.open ? r.last : 0, thr, r.sec) };
    });
    const ok = rows.filter(r => r.ok), sum = f => ok.reduce((s, r) => s + f(r), 0);
    const given = sum(r => Math.max(0, r.diff)), cost = sum(r => Math.min(0, r.diff));
    const hit = ok.filter(r => r.triggered > 0), rt = hit.filter(r => r.actual < r.solIn);
    const worst = ok.filter(r => r.diff > 0).sort((a, b) => b.diff - a.diff)[0] || null;
    return { wallet: S.wallet, depth: S.depth, txN: S.txN, tradeN: S.tradeN, coinN: S.coinN, thr, rows, okN: ok.length, given, cost, net: given + cost, hitN: hit.length, rtN: rt.length, worst, sample: !!S.sample };
  }

  // ---------- a labeled sample (preview) built from synthetic charts, run through the same replay ----------
  function sample() {
    let seed = 7; const rnd = () => (seed = seed * 16807 % 2147483647) / 2147483647;
    const now = Math.floor(Date.now() / 1000), base = now - 9 * 86400;
    const shapes = [ // [symbol, sol in, peak multiple, end multiple, sold at (fraction of path) or null]
      ["MEOW", 2.4, 4.1, .28, .92], ["GRIND", 1.6, 2.6, .41, .88], ["BLOC", 1.1, 3.3, 1.9, .7], ["HAWK", 1.5, 1.7, .5, .8],
      ["SPLIT", .9, 2.3, .62, null], ["ROPE", 1.2, 6.2, 5.1, .66], ["DUSK", .7, 2.1, .33, .95], ["WIRE", .6, 1.3, .2, .9],
      ["MOTH", .5, 2.8, .7, .85], ["PIER", .4, .9, .1, .7]];
    const priced = shapes.map(([sym, solIn, peakM, endM, soldAt], i) => {
      const mint = sym + "11111111111111111111111111111pump".slice(0, 40 - sym.length), t0 = base + i * 70000, sec = 300, n = 220, p0 = 1e-7 * (1 + i);
      const pk = .25 + rnd() * .3, list = [];
      for (let k = 0; k < n; k++) { const u = k / (n - 1);
        const m = u < pk ? 1 + (peakM - 1) * Math.pow(u / pk, 1.6) : peakM + (endM - peakM) * Math.pow((u - pk) / (1 - pk), .7);
        const v = p0 * m * (1 + (rnd() - .5) * .06); list.push({ s: t0 + 60 + k * sec, h: v * (1 + rnd() * .04), c: v }); }
      const tokens = solIn / (p0 * 1.01), trades = [{ t: t0, mint, side: "buy", tokens, sol: solIn }];
      let t1 = null;
      if (soldAt != null) { const k = Math.floor(soldAt * (n - 1)); t1 = list[k].s + 30; trades.push({ t: t1, mint, side: "sell", tokens, sol: tokens * list[k].c * .99 }); }
      const pos = { mint, trades, solIn, solOut: soldAt != null ? trades[1].sol : 0, bought: tokens, held: soldAt != null ? 0 : tokens, open: soldAt == null, t0, t1, entry: solIn / tokens };
      return { mint, sym, pos, candles: soldAt != null ? list.filter(c => c.s <= t1) : list, last: list[n - 1].c, sec };
    });
    return { wallet: "SamPLe1nits7xKp2wQ9RtV4bM8cZ3fLhNa6dYjE5uG", depth: 250, txN: 250, tradeN: 61, coinN: 23, priced, sample: true, at: now };
  }

  return { WSOL, isAddr, parseTx, positions, simulate, pickTF, scan, summarize, sample, dexPrices, makeRpc, makeGT };
})();
if (typeof module !== "undefined") module.exports = INITS;
