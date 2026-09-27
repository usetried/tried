import http from 'node:http';
import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import WebSocket from 'ws';
import { analyze, isToolSite, warmTemplates, DATA_DIR } from './pipeline.js';
import { aiStatus } from './judge.js';

process.on('unhandledRejection', (e) => console.warn('[unhandled]', e?.message || e));
process.on('uncaughtException', (e) => console.warn('[uncaught]', e?.message || e));

const PORT = +process.env.PORT || 8787;
const CONCURRENCY = +process.env.CONCURRENCY || 3;
const MAX_QUEUE = 30;
const RESULTS = path.join(DATA_DIR, 'results.jsonl');

const feed = [];
const reports = new Map();
const queue = [];
let running = 0;
const bySite = new Map();
const stats = { mintsSeen: 0, withSite: 0, tried: 0, dropped: 0, sameSite: 0, skipped: 0, startedAt: new Date().toISOString() };

async function loadExisting() {
  const txt = await fs.readFile(RESULTS, 'utf8').catch(() => '');
  const all = txt.trim().split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  all.forEach((r, i) => { r.no ??= i + 1; reports.set(r.id, r); });
  for (const r of all.slice(-200)) feed.unshift(r);
}

async function file(r) {
  r.no = reports.size + 1;
  feed.unshift(r);
  feed.length = Math.min(feed.length, 300);
  reports.set(r.id, r);
  await fs.appendFile(RESULTS, JSON.stringify(r) + '\n');
}

const siteKey = (u) => { try { const x = new URL(u); return (x.hostname.replace(/^www\./, '') + x.pathname.replace(/\/$/, '')).toLowerCase(); } catch { return u; } };

function enqueue(coin) {
  const key = siteKey(coin.website);
  const prev = bySite.get(key);
  if (prev) {
    stats.sameSite++;
    if (prev !== 'pending') { prev.sameSiteCoins = (prev.sameSiteCoins || 1) + 1; (prev.sameSiteSymbols ||= []).push((coin.symbol || '').trim()); }
    return;
  }
  bySite.set(key, 'pending');
  coin.key = key;
  if (queue.length >= MAX_QUEUE) { queue.shift(); stats.dropped++; }
  queue.push(coin);
  pump();
}

function pump() {
  while (running < CONCURRENCY && queue.length) {
    const coin = queue.pop();
    running++;
    analyze(coin)
      .then(async (r) => {
        if (!r) { stats.skipped++; bySite.delete(coin.key); return; }
        bySite.set(coin.key, r);
        stats.tried++;
        await file(r);
        console.log(`${r.verdict.padEnd(14)} $${(r.coin.symbol || '').trim().padEnd(10)} ${String(r.timing.total_ms).padStart(6)}ms  ${r.site}`);
      })
      .catch((e) => console.warn('[analyze]', coin.website, e.message))
      .finally(() => { running--; pump(); });
  }
}

const MIN_BUYERS = +process.env.MIN_BUYERS || 3;
const WATCH_MS = (+process.env.WATCH_SECONDS || 120) * 1000;
const MAX_PER_CREATOR_HOUR = 3;
const watching = new Map();
const creatorLaunches = new Map();
Object.assign(stats, { lowActivity: 0, creatorCapped: 0 });

function creatorAllowed(creator) {
  const now = Date.now();
  const list = (creatorLaunches.get(creator) || []).filter((t) => now - t < 60 * 60_000);
  if (list.length >= MAX_PER_CREATOR_HOUR) return false;
  list.push(now); creatorLaunches.set(creator, list);
  return true;
}

let backoff = 3000;
let liveWs;
function watch(coin, creator) {
  const w = { coin, creator, buyers: new Set() };
  w.timer = setTimeout(() => {
    watching.delete(coin.mint); stats.lowActivity++;
    liveWs?.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [coin.mint] }));
  }, WATCH_MS);
  watching.set(coin.mint, w);
  liveWs?.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [coin.mint] }));
}

function onTrade(m) {
  const w = watching.get(m.mint);
  if (!w || m.txType !== 'buy' || !m.traderPublicKey || m.traderPublicKey === w.creator) return;
  w.buyers.add(m.traderPublicKey);
  if (w.buyers.size >= MIN_BUYERS) {
    clearTimeout(w.timer); watching.delete(m.mint);
    liveWs?.send(JSON.stringify({ method: 'unsubscribeTokenTrade', keys: [m.mint] }));
    enqueue(w.coin);
  }
}

function listen() {
  const ws = new WebSocket('wss://pumpportal.fun/api/data');
  liveWs = ws;
  ws.on('open', () => {
    ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
    if (watching.size) ws.send(JSON.stringify({ method: 'subscribeTokenTrade', keys: [...watching.keys()] }));
    console.log('[live] subscribed to new pump.fun coins');
  });
  ws.on('message', async (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }
    if (m.mint && (m.txType === 'buy' || m.txType === 'sell')) return onTrade(m);
    if (!m.mint || !m.uri) return;
    stats.mintsSeen++;
    try {
      const meta = await (await fetch(m.uri, { signal: AbortSignal.timeout(4000) })).json();
      if (meta.website && isToolSite(meta.website)) {
        stats.withSite++;
        if (!creatorAllowed(m.traderPublicKey)) { stats.creatorCapped++; return; }
        if (watching.size >= 400) return;
        watch({ mint: m.mint, name: m.name, symbol: m.symbol, website: meta.website }, m.traderPublicKey);
      }
    } catch {}
  });
  ws.on('message', () => { backoff = 3000; });
  ws.on('close', () => {
    console.log(`[live] disconnected, retrying in ${backoff / 1000}s`);
    setTimeout(listen, backoff);
    backoff = Math.min(backoff * 2, 120_000);
  });
  ws.on('error', () => {});
}

const MANUAL_SLOTS = 2, MANUAL_MAX_WAITING = 8;
let manualRunning = 0;
const manualWaiting = [];
async function withManualSlot(fn) {
  if (manualRunning >= MANUAL_SLOTS) {
    if (manualWaiting.length >= MANUAL_MAX_WAITING) return { busy: true };
    await new Promise((resolve) => manualWaiting.push(resolve));
  }
  manualRunning++;
  try { return { value: await fn() }; } finally { manualRunning--; manualWaiting.shift()?.(); }
}

const hits = new Map();
let globalHits = [];
function allowCheck(ip) {
  const now = Date.now();
  const mine = (hits.get(ip) || []).filter((t) => now - t < 10 * 60_000);
  globalHits = globalHits.filter((t) => now - t < 60 * 60_000);
  if (mine.length >= 5 || globalHits.length >= 40) return false;
  mine.push(now); globalHits.push(now); hits.set(ip, mine);
  return true;
}

const TYPES = { '.html': 'text/html; charset=utf-8', '.jpg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif', '.svg': 'image/svg+xml', '.mp4': 'video/mp4', '.js': 'text/javascript', '.css': 'text/css' };

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const json = (code, body) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  if (url.pathname === '/api/feed') return json(200, { stats: { ...stats, queue: queue.length, running, watching: watching.size }, items: feed.slice(0, 100) });
  if (url.pathname === '/api/status' && !req.headers['cf-connecting-ip']) return json(200, { ai: aiStatus(), stats, watching: watching.size, manualRunning, manualWaiting: manualWaiting.length });
  const publicIp = req.headers['cf-connecting-ip'];
  if (url.pathname === '/api/try' && publicIp) return json(403, { error: 'Not available.' });
  if (url.pathname === '/api/check') {
    if (publicIp && !allowCheck(publicIp)) return json(429, { error: 'Too many tests. Try again in a few minutes.' });
    const ca = (url.searchParams.get('ca') || '').trim();
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(ca)) return json(400, { error: 'Invalid contract address.' });
    const cached = feed.find((r) => r.coin.mint === ca);
    if (cached) return json(200, cached);
    let pair;
    try {
      const d = await (await fetch(`https://api.dexscreener.com/latest/dex/tokens/${ca}`, { signal: AbortSignal.timeout(5000) })).json();
      pair = (d.pairs || []).find((p) => p.info?.websites?.length) || d.pairs?.[0];
    } catch {}
    if (!pair) return json(404, { error: 'Coin not found yet (new coins can take a few minutes to be indexed).' });
    const website = pair.info?.websites?.[0]?.url;
    if (!website) return json(404, { error: 'This coin has no website to test.' });
    if (!isToolSite(website)) return json(422, { error: 'This coin links to a social/news page, not its own product.' });
    const slot = await withManualSlot(() => analyze({ website, mint: ca, name: pair.baseToken.name, symbol: pair.baseToken.symbol }));
    if (slot.busy) return json(503, { error: 'The bench is busy. Try again in a minute.' });
    const r = slot.value;
    if (!r) return json(422, { error: 'The website redirects to a social/news page, not a product.' });
    await file(r);
    return json(200, r);
  }
  if (url.pathname === '/api/report') {
    const r = reports.get(url.searchParams.get('id') || '');
    if (!r) return json(404, { error: 'Report not found.' });
    const history = [...reports.values()]
      .filter((x) => x.coin.mint === r.coin.mint && x.coin.mint !== '-' && x.id !== r.id)
      .sort((a, b) => b.at.localeCompare(a.at)).slice(0, 10)
      .map(({ id, at, verdict, headline }) => ({ id, at, verdict, headline }));
    return json(200, { report: r, history });
  }
  if (url.pathname === '/api/retest') {
    if (req.method !== 'POST') return json(405, { error: 'Use POST.' });
    const old = reports.get(url.searchParams.get('id') || '');
    if (!old) return json(404, { error: 'Report not found.' });
    const recent = [...reports.values()].find((x) => x.coin.mint === old.coin.mint && x.coin.mint !== '-' && Date.now() - Date.parse(x.at) < 5 * 60_000);
    if (recent) return json(200, { report: recent, note: 'This coin was tested in the last 5 minutes. Showing that report.' });
    if (publicIp && !allowCheck(publicIp)) return json(429, { error: 'Too many tests. Try again in a few minutes.' });
    const slot = await withManualSlot(() => analyze({ website: old.site, mint: old.coin.mint, name: old.coin.name, symbol: old.coin.symbol }));
    if (slot.busy) return json(503, { error: 'The bench is busy. Try again in a minute.' });
    const r = slot.value;
    if (!r) return json(422, { error: 'The website no longer points to a product.' });
    r.retestOf = old.id;
    await file(r);
    return json(200, { report: r });
  }
  const rm = url.pathname.match(/^\/r\/([\w-]+)$/);
  if (rm) {
    const r = reports.get(rm[1]);
    const html = await fs.readFile(path.resolve('public', 'report.html'), 'utf8').catch(() => null);
    if (!html) return r ? json(200, r) : json(404, { error: 'Report not found.' });
    const base = (publicIp ? 'https://' : 'http://') + req.headers.host;
    const esc = (t) => String(t ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const label = r ? r.verdict.replace('_', ' ') : 'Report not found';
    const out = html
      .replaceAll('{{TITLE}}', esc(r ? `$${(r.coin.symbol || '').trim()} - ${label} · TRIED` : 'TRIED'))
      .replaceAll('{{DESC}}', esc(r ? `${r.headline}. Tested in ${(r.timing.total_ms / 1000).toFixed(1)}s.` : 'This report does not exist.'))
      .replaceAll('{{IMAGE}}', esc(r?.shot ? `${base}/${r.shot}` : `${base}/brand/banner.png`))
      .replaceAll('{{URL}}', esc(`${base}/r/${rm[1]}`))
      .replaceAll('{{ID}}', esc(rm[1]));
    res.writeHead(r ? 200 : 404, { 'content-type': 'text/html; charset=utf-8' });
    return res.end(out);
  }
  if (url.pathname === '/api/try') {
    const site = url.searchParams.get('url');
    if (!site || !isToolSite(site)) return json(400, { error: 'pass ?url= with a project website' });
    const slot = await withManualSlot(() => analyze({ website: site, mint: url.searchParams.get('mint') || '-', name: '', symbol: url.searchParams.get('symbol') || 'MANUAL' }));
    if (slot.busy) return json(503, { error: 'The bench is busy. Try again in a minute.' });
    const r = slot.value;
    if (!r) return json(422, { error: 'not a product site' });
    await file(r);
    return json(200, r);
  }
  const filePath = url.pathname.startsWith('/shots/')
    ? path.join(DATA_DIR, path.normalize(url.pathname).replace(/^[\\/]+/, ''))
    : path.resolve('public', url.pathname === '/' ? 'index.html' : '.' + path.normalize(url.pathname));
  if (!filePath.startsWith(DATA_DIR) && !filePath.startsWith(path.resolve('public'))) { res.writeHead(403); return res.end(); }
  try {
    await fs.access(filePath);
    res.writeHead(200, { 'content-type': TYPES[path.extname(filePath)] || 'application/octet-stream' });
    createReadStream(filePath).pipe(res);
  } catch {
    if (url.pathname === '/') return json(200, { name: 'TRIED', api: ['/api/feed', '/api/check?ca=<mint>', '/api/report?id=<id>', 'POST /api/retest?id=<id>', '/r/<id>'] });
    res.writeHead(404); res.end('not found');
  }
}).listen(PORT, async () => {
  await fs.mkdir(path.join(DATA_DIR, 'shots'), { recursive: true });
  await loadExisting();
  console.log(`[tried] feed on http://localhost:${PORT}  (AI verdicts: ${process.env.ANTHROPIC_API_KEY ? 'on' : 'off, rules only'})`);
  console.log(`[tried] templates loaded: ${await warmTemplates()}`);
  if (process.env.LIVE !== '0') listen();
});
