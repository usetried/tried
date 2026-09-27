import { isPublicUrl } from './netguard.js';

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36';

export async function fetchSite(url, timeoutMs = 5000) {
  const t0 = Date.now();
  try {
    let current = url;
    let res;
    for (let hop = 0; hop < 6; hop++) {
      if (!(await isPublicUrl(current))) return { ok: false, status: 0, finalUrl: current, html: '', error: 'blocked-private', ms: Date.now() - t0 };
      res = await fetch(current, {
        headers: { 'user-agent': UA, accept: 'text/html,*/*' },
        redirect: 'manual',
        signal: AbortSignal.timeout(timeoutMs),
      });
      const loc = res.status >= 300 && res.status < 400 && res.headers.get('location');
      if (!loc) break;
      current = new URL(loc, current).href;
    }
    const html = (await res.text()).slice(0, 2_000_000);
    return { ok: res.ok, status: res.status, finalUrl: current, html, ms: Date.now() - t0 };
  } catch (e) {
    return { ok: false, status: 0, finalUrl: url, html: '', error: String(e.name || e), ms: Date.now() - t0 };
  }
}

export function extractText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function isBotWall(html, status) {
  return (
    status === 403 || status === 503
      ? /cloudflare|cf-chl|challenge-platform|captcha|just a moment/i.test(html)
      : /cf-chl-|challenge-platform|Just a moment\.\.\./i.test(html)
  );
}

export function caCheck(html, mint) {
  const found = html.includes(mint);
  const others = [...new Set(html.match(/\b[1-9A-HJ-NP-Za-km-z]{32,44}pump\b/g) || [])].filter((m) => m !== mint);
  return { found, otherMints: others.slice(0, 5) };
}

const DANGER = [
  [/(?:enter|paste|type|import|input|provide|submit)\s+(?:your|the)\s+(?:12|24|twelve|twenty[- ]four)?[- ]?(?:word\s+)?(?:seed|recovery|secret recovery|mnemonic)\s*phrase/i, 'asks you to enter a seed/recovery phrase'],
  [/(?:enter|paste|import|provide|submit)\s+(?:your|the)\s+(?:wallet\s+)?private\s*key/i, 'asks you to enter a private key'],
  [/<(?:input|textarea)[^>]+(?:placeholder|name|id|aria-label)=["'][^"']*(?:seed|mnemonic|private.?key|recovery)/i, 'has a seed/private-key input field'],
  [/wallet[-_ ]?drainer|inferno[-_ ]?drainer|pink[-_ ]?drainer|angel[-_ ]?drainer/i, 'references a known drainer kit'],
  [/setApprovalForAll|signAllTransactions\s*\(/i, 'requests bulk transaction signing'],
];

export function dangerScan(html) {
  return DANGER.filter(([re]) => re.test(html)).map(([, why]) => why);
}

export function needsWallet(html) {
  return /connect\s*wallet|select\s*wallet|phantom|solflare|wallet-adapter/i.test(html);
}

export function shingles(text, n = 5) {
  const w = text.toLowerCase().replace(/[^a-z0-9$ ]/g, ' ').split(/\s+/).filter(Boolean);
  const s = new Set();
  for (let i = 0; i + n <= w.length; i++) s.add(w.slice(i, i + n).join(' '));
  return s;
}

export function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

export async function domainAgeDays(url) {
  try {
    const host = new URL(url).hostname.split('.').slice(-2).join('.');
    const res = await fetch(`https://rdap.org/domain/${host}`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    const j = await res.json();
    const reg = (j.events || []).find((e) => e.eventAction === 'registration');
    return reg ? Math.floor((Date.now() - new Date(reg.eventDate)) / 86_400_000) : null;
  } catch {
    return null;
  }
}
