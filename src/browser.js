import { chromium } from 'playwright';
import { isPublicHost } from './netguard.js';
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';

let browser;

export async function getBrowser() {
  if (browser?.isConnected()) return browser;
  browser = await chromium.launch({ headless: true, channel: process.env.BROWSER_CHANNEL || (process.platform === 'win32' ? 'msedge' : undefined) });
  return browser;
}

const SAMPLE_CA = '7YQGD6vjEHgSUT5tkHuaCu5TgHc6NMwjxXrhKkYHpump';

export async function visit(url, outDir, { navTimeout = 8000 } = {}) {
  const t0 = Date.now();
  const b = await getBrowser();
  const ctx = await b.newContext({
    viewport: { width: 1280, height: 800 },
    acceptDownloads: false,
    javaScriptEnabled: true,
  });
  await ctx.route('**/*', async (route) => {
    try {
      const host = new URL(route.request().url()).hostname;
      if (/^(data|blob):/.test(route.request().url()) || (await isPublicHost(host))) return route.continue();
    } catch {}
    return route.abort('blockedbyclient');
  });
  const page = await ctx.newPage();
  ctx.on('page', (p) => p !== page && p.close().catch(() => {}));
  const consoleErrors = [];
  page.on('pageerror', (e) => consoleErrors.push(String(e.message).slice(0, 200)));
  const frames = [];
  const shot = async (name) => {
    const file = path.join(outDir, `${name}.jpg`);
    await page.screenshot({ path: file, type: 'jpeg', quality: 70 }).catch(() => {});
    frames.push(file);
    return file;
  };

  const out = { loaded: false, title: '', poke: null, consoleErrors, frames, ms: 0 };
  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: navTimeout });
    await page.waitForLoadState('networkidle', { timeout: 2500 }).catch(() => {});
    out.loaded = true;
    out.title = (await page.title()).slice(0, 120);
    const overlay = page.getByRole('button', { name: /^(reject all|reject|decline|close|dismiss|got it|continue|enter|i understand|×|x)$/i }).first();
    if (await overlay.isVisible({ timeout: 300 }).catch(() => false)) {
      await overlay.click({ timeout: 800 }).catch(() => {});
      await page.waitForTimeout(300);
    }
    out.main = await shot('0-landing');

    const words = () => page.evaluate(() => (document.body?.innerText || '').split(/\s+/).filter(Boolean));
    const before = new Set(await words().catch(() => []));
    const input = page.locator('input[type=text], input:not([type]), textarea').first();
    if ((await input.count()) && (await input.isVisible().catch(() => false))) {
      await input.fill(SAMPLE_CA, { timeout: 1500 }).catch(() => {});
      await input.press('Enter', { timeout: 1000 }).catch(() => {});
      out.poke = 'typed a contract address into the first input and pressed Enter';
    } else {
      const btn = page
        .locator('button, a[role=button], a[class*=btn], a[class*=button]')
        .filter({ hasNotText: /connect|wallet|buy|pump\.fun|dexscreener|twitter|telegram|^x$/i })
        .first();
      if ((await btn.count()) && (await btn.isVisible().catch(() => false))) {
        const label = ((await btn.innerText().catch(() => '')) || '').trim().slice(0, 40);
        await btn.click({ timeout: 1500, noWaitAfter: true }).catch(() => {});
        out.poke = `clicked the main button "${label}"`;
      }
    }
    if (out.poke) {
      await page.waitForTimeout(1500);
      out.after = await shot('1-after-poke');
      const after = await words().catch(() => []);
      out.newText = [...new Set(after.filter((w) => !before.has(w) && w !== SAMPLE_CA))].slice(0, 25);
      out.pokeChangedPage = out.newText.length >= 2 || page.url() !== url;
    }
    for (let i = 2; i <= 3; i++) {
      await page.mouse.wheel(0, 700).catch(() => {});
      await page.waitForTimeout(250);
      await shot(`${i}-scroll`);
    }
  } catch (e) {
    out.error = String(e.message || e).split('\n')[0].slice(0, 200);
  } finally {
    await ctx.close().catch(() => {});
    out.ms = Date.now() - t0;
  }
  return out;
}

export function makeGif(frames, outFile) {
  return new Promise((resolve) => {
    if (frames.length < 2) return resolve(null);
    const listFile = outFile + '.txt';
    const list = frames.map((f) => `file '${f.replace(/\\/g, '/')}'\nduration 1.2`).join('\n') + `\nfile '${frames.at(-1).replace(/\\/g, '/')}'`;
    fs.writeFile(listFile, list).then(() => {
      const p = spawn('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', listFile,
        '-vf', 'scale=640:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse', '-loop', '0', outFile]);
      p.on('close', (code) => { fs.rm(listFile).catch(() => {}); resolve(code === 0 ? outFile : null); });
      p.on('error', () => resolve(null));
    });
  });
}

export async function closeBrowser() {
  await browser?.close().catch(() => {});
}
