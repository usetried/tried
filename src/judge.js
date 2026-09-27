import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';
import fs from 'node:fs/promises';
import fsSync from 'node:fs';
import path from 'node:path';

export const VERDICTS = ['WORKS', 'DEMO_ONLY', 'TEMPLATE_CLONE', 'CA_MISMATCH', 'DEAD', 'DANGER', 'NOT_TESTED'];

const Verdict = z.object({
  verdict: z.enum(VERDICTS),
  headline: z.string(),
  reasoning: z.array(z.string()),
  what_it_claims: z.string(),
});

const SYSTEM = `You are TRIED, an agent that opens memecoin project websites, pokes the product, and reports honestly what it found.
Judge ONLY from the evidence given (screenshots + automated check results). Never guess about the team or the price.
Verdicts:
- WORKS: there is a real product and it visibly responded to the poke (or clearly functions on the page).
- DEMO_ONLY: looks like a product but nothing responded / it is just a landing page with claims.
- TEMPLATE_CLONE: the automated similarity check says the site is a near copy of another project's site.
- CA_MISMATCH: the site shows a different contract address than this coin (someone else's site, or a copycat coin).
- DEAD: site did not load or is empty/parked.
- DANGER: the site asks for a seed phrase / private key or shows drainer signs.
- NOT_TESTED: the product needs a wallet connection or a login, or a bot wall blocked us.
Priority when several apply: DANGER > DEAD > CA_MISMATCH > TEMPLATE_CLONE > NOT_TESTED > WORKS/DEMO_ONLY.
Write factually and neutrally (no "scam", no insults). Headline: max 90 chars, plain English.`;

let client;
const hasKey = () => !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
const MODEL = process.env.TRIED_MODEL || 'claude-opus-5';

const BUDGET_USD = +process.env.TRIED_AI_BUDGET_USD || 10;
const PRICE = {
  'claude-opus-5': [5, 25], 'claude-opus-5-5': [4, 20], 'claude-sonnet-5': [2, 10], 'claude-haiku-4-5': [1, 5],
};
const SPEND_FILE = path.resolve('data', 'ai-spend.json');
let spend = { day: '', usd: 0, calls: 0 };
try { spend = JSON.parse(fsSync.readFileSync(SPEND_FILE, 'utf8')); } catch {}
const today = () => new Date().toISOString().slice(0, 10);
function spentToday() { if (spend.day !== today()) spend = { day: today(), usd: 0, calls: 0 }; return spend; }
function record(usage) {
  const [pin, pout] = PRICE[MODEL] || PRICE['claude-opus-5'];
  const input = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0) * 1.25 + (usage.cache_read_input_tokens || 0) * 0.1;
  const s = spentToday();
  s.usd += (input * pin + (usage.output_tokens || 0) * pout) / 1e6;
  s.calls++;
  fs.writeFile(SPEND_FILE, JSON.stringify(s)).catch(() => {});
}
export const aiStatus = () => ({ model: hasKey() ? MODEL : null, budgetUsd: BUDGET_USD, ...spentToday() });

export async function judge(ev) {
  if (!hasKey()) return ruleVerdict(ev);
  if (spentToday().usd >= BUDGET_USD) return { ...ruleVerdict(ev), note: 'ai-budget-reached' };
  client ??= new Anthropic();
  const images = [];
  for (const f of [ev.visit?.main, ev.visit?.after].filter(Boolean)) {
    const data = await fs.readFile(f).catch(() => null);
    if (data) images.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: data.toString('base64') } });
  }
  const facts = {
    coin: { name: ev.coin.name, symbol: ev.coin.symbol, mint: ev.coin.mint },
    site: ev.site.finalUrl,
    http_status: ev.site.status,
    bot_wall: ev.botWall,
    contract_address_on_site: ev.ca.found,
    other_contract_addresses_on_site: ev.ca.otherMints,
    template_match: ev.template,
    danger_signals: ev.danger,
    needs_wallet: ev.needsWallet,
    domain_age_days: ev.domainAge,
    page_title: ev.visit?.title,
    poke_action: ev.visit?.poke,
    poke_changed_page: ev.visit?.pokeChangedPage ?? null,
    new_text_after_poke: ev.visit?.newText,
    js_errors: ev.visit?.consoleErrors?.slice(0, 3),
    visible_text_excerpt: ev.text.slice(0, 1500),
  };
  const t0 = Date.now();
  try {
    const res = await client.messages.parse({
      model: MODEL,
      max_tokens: 2000,
      output_config: MODEL.includes('haiku')
        ? { format: zodOutputFormat(Verdict) }
        : { effort: process.env.TRIED_EFFORT || 'low', format: zodOutputFormat(Verdict) },
      system: SYSTEM,
      messages: [{
        role: 'user',
        content: [
          ...images,
          { type: 'text', text: `Screenshots: 1) landing page${images.length > 1 ? ', 2) after the poke' : ''}.\nAutomated checks:\n${JSON.stringify(facts, null, 1)}` },
        ],
      }],
    });
    record(res.usage || {});
    if (res.stop_reason === 'refusal' || !res.parsed_output) return { ...ruleVerdict(ev), note: 'ai-unavailable' };
    return { ...res.parsed_output, by: res.model, aiMs: Date.now() - t0 };
  } catch (e) {
    if (e instanceof Anthropic.RateLimitError) console.warn('[judge] rate limited');
    else if (e instanceof Anthropic.APIError) console.warn(`[judge] API ${e.status}: ${e.message}`);
    else console.warn('[judge]', e.message);
    return { ...ruleVerdict(ev), note: 'ai-error' };
  }
}

export function ruleVerdict(ev) {
  const r = (verdict, headline, reasoning) => ({ verdict, headline, reasoning, what_it_claims: ev.visit?.title || '', by: 'rules' });
  if (ev.danger.length) return r('DANGER', 'Site shows wallet-draining signals', ev.danger);
  if (!ev.site.ok && !ev.visit?.loaded) return r('DEAD', 'Site did not load', [`HTTP ${ev.site.status || 'timeout'}`]);
  if (ev.text.length < 80 && !ev.visit?.loaded) return r('DEAD', 'Site is empty', ['almost no visible text']);
  if (!ev.ca.found && ev.ca.otherMints.length) return r('CA_MISMATCH', 'Site shows a different contract address', [`site lists ${ev.ca.otherMints[0]}`]);
  if (ev.template) return r('TEMPLATE_CLONE', `Site is ${Math.round(ev.template.similarity * 100)}% identical to ${ev.template.of}`, ['text similarity check']);
  if (ev.botWall) return r('NOT_TESTED', 'Bot wall blocked the test', ['challenge page']);
  if (ev.needsWallet && !ev.visit?.pokeChangedPage) return r('NOT_TESTED', 'Product needs a wallet connection', ['connect-wallet UI found']);
  if (ev.visit?.poke && ev.visit.pokeChangedPage) return r('WORKS', 'Product responded when we used it', [ev.visit.poke, `new on page: ${(ev.visit.newText || []).slice(0, 6).join(' ')}`]);
  return r('DEMO_ONLY', 'Landing page only, nothing responded', [ev.visit?.poke ? `${ev.visit.poke}: no change` : 'no interactive element found']);
}
