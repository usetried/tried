import path from 'node:path';
import fs from 'node:fs/promises';
import { fetchSite, extractText, isBotWall, caCheck, dangerScan, needsWallet, shingles, jaccard, domainAgeDays } from './checks.js';
import { visit, makeGif } from './browser.js';
import { judge } from './judge.js';
import { isPublicUrl } from './netguard.js';

export const DATA_DIR = path.resolve('data');
const SHOTS = path.join(DATA_DIR, 'shots');

const SKIP_HOSTS = /(^|\.)(x\.com|twitter\.com|t\.me|telegram\.me|pump\.fun|youtube\.com|youtu\.be|tiktok\.com|instagram\.com|dexscreener\.com|linktr\.ee|discord\.gg|github\.com|reddit\.com|facebook\.com)$/i;

const NEWS_HOSTS = /(^|\.)(independent\.co\.uk|bbc\.co\.uk|bbc\.com|cnn\.com|foxnews\.com|nytimes\.com|reuters\.com|bloomberg\.com|theguardian\.com|dailymail\.co\.uk|nypost\.com|cnbc\.com|forbes\.com|yahoo\.com|msn\.com|coindesk\.com|cointelegraph\.com|decrypt\.co|wikipedia\.org|knowyourmeme\.com|apple\.com|google\.com)$/i;
const PLATFORM_TOKEN_PAGE = /(^|\.)(usepaid\.app|usefork\.cash|useyap\.fun|usetagg\.app|otcdesks\.cash|stonkfun\.xyz|pons\.[a-z]+|bags\.fm|letsbonk\.fun|believe\.app|gmgn\.ai|birdeye\.so|axiom\.trade|photon-sol\.tinyastro\.io)$/i;

export function isToolSite(url) {
  try {
    const u = new URL(url);
    if (NEWS_HOSTS.test(u.hostname) || /\.(gov|mil|edu)(\.[a-z]{2})?$/i.test(u.hostname)) return false;
    if (PLATFORM_TOKEN_PAGE.test(u.hostname) && u.pathname.length > 1) return false;
    return /^https?:$/.test(u.protocol) && !SKIP_HOSTS.test(u.hostname);
  } catch {
    return false;
  }
}

const KNOWN_TEMPLATES = ['https://usepaid.app/', 'https://steampaid.app/', 'https://getcapcheck.xyz/', 'https://gitpaid.xyz/', 'https://cspaid.app/'];
const seen = new Map();

export async function warmTemplates() {
  await Promise.all(KNOWN_TEMPLATES.map(async (u) => {
    const s = await fetchSite(u, 6000);
    if (s.ok) seen.set(new URL(u).hostname, { shingles: shingles(extractText(s.html)), symbol: new URL(u).hostname });
  }));
  return seen.size;
}

function templateMatch(host, sh) {
  let best = null;
  for (const [h, v] of seen) {
    if (h === host) continue;
    const sim = jaccard(sh, v.shingles);
    if (sim >= 0.6 && (!best || sim > best.similarity)) best = { of: h, similarity: +sim.toFixed(2) };
  }
  return best;
}

const SLURS = /n[i1!]gg|f[a@]gg?[o0]t|r[e3]t[a@]rd|k[i1]ke|tr[a@]nn/i;
const clean = (s = '') => (SLURS.test(s) ? '[name hidden]' : s);

export async function analyze(coin) {
  if (!(await isPublicUrl(coin.website))) return null;
  const t0 = Date.now();
  const id = `${Date.now()}-${coin.mint.slice(0, 6)}`;
  const outDir = path.join(SHOTS, id);
  await fs.mkdir(outDir, { recursive: true });

  const [site, v, domainAge] = await Promise.all([
    fetchSite(coin.website),
    visit(coin.website, outDir),
    domainAgeDays(coin.website),
  ]);
  if (site.finalUrl && !isToolSite(site.finalUrl)) { await fs.rm(outDir, { recursive: true, force: true }); return null; }
  const html = site.html || '';
  const text = extractText(html);
  const host = (() => { try { return new URL(site.finalUrl).hostname; } catch { return ''; } })();
  const sh = shingles(text);
  const ev = {
    coin, site, visit: v, domainAge, text,
    botWall: isBotWall(html, site.status),
    ca: caCheck(html, coin.mint),
    danger: dangerScan(html),
    needsWallet: needsWallet(html),
    template: sh.size > 30 ? templateMatch(host, sh) : null,
  };
  const checksMs = Date.now() - t0;
  const verdict = await judge(ev);
  if (host && sh.size > 30 && !seen.has(host)) seen.set(host, { shingles: sh, symbol: coin.symbol });

  const result = {
    id,
    at: new Date().toISOString(),
    coin: { mint: coin.mint, name: clean(coin.name), symbol: clean(coin.symbol) },
    site: site.finalUrl || coin.website,
    ...verdict,
    evidence: {
      http: site.status, ca_on_site: ev.ca.found, other_cas: ev.ca.otherMints, template: ev.template,
      danger: ev.danger, needs_wallet: ev.needsWallet, domain_age_days: domainAge, poke: v.poke || null,
      poke_changed_page: v.pokeChangedPage ?? null, bot_wall: ev.botWall,
    },
    shot: v.main ? `shots/${id}/0-landing.jpg` : null,
    gif: null,
    timing: { checks_ms: checksMs, total_ms: Date.now() - t0 },
  };
  const gif = await makeGif(v.frames, path.join(outDir, 'tried.gif'));
  if (gif) result.gif = `shots/${id}/tried.gif`;
  return result;
}
