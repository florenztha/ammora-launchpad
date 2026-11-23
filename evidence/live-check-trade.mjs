// Keyless live check of the BUILT bundle's simple Buy / Sell card.
// Loads docs/bundle.js with a stub DOM (same approach as wallet-sim-test),
// waits for the header status line, the token list and, after selecting the
// ZENT token with the card's default amount (0.01), asserts the estimate box
// shows live WETH-denominated quotes for both directions. No wallet involved:
// without an account the buttons must stay disabled with the connect note.
import { readFileSync } from 'node:fs';

const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); };

function makeEl(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(), children: [], style: {}, dataset: {},
    _text: '', _html: '', value: '', disabled: false, className: '',
    _listeners: {},
    appendChild(child) { this.children.push(child); return child; },
    addEventListener(type, fn) { (this._listeners[type] ??= []).push(fn); },
    click() { for (const fn of this._listeners.click ?? []) fn(); },
  };
  Object.defineProperty(el, 'textContent', {
    get() { return this._text; }, set(v) { this._text = String(v); this.children = []; },
  });
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html; }, set(v) { this._html = String(v); if (v === '') this.children = []; },
  });
  return el;
}
const elements = new Map();
const el = (id) => { if (!elements.has(id)) elements.set(id, makeEl()); return elements.get(id); };
globalThis.document = {
  getElementById: (id) => el(id),
  createElement: (tag) => makeEl(tag),
  createTextNode: (text) => ({ nodeType: 3, data: String(text) }),
};
const win = new EventTarget();
globalThis.window = win;

// The real page's amount input defaults to 0.01 (see index.html).
el('tradeAmt').value = '0.01';

const bundle = readFileSync(new URL('../docs/bundle.js', import.meta.url), 'utf8');
eval(bundle);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await sleep(150); }
  throw new Error('timeout waiting for: ' + what);
}

// 1. Header status line shows a current block.
await waitFor(() => /Block \d+/.test(el('statusLine').textContent), 30000, 'status line block');
const blockShown = el('statusLine').textContent.match(/Block (\d+)/)[1];
check('network status line shows a live block', true, el('statusLine').textContent);

// 2. Token list renders with at least one Trading open token.
await waitFor(() => el('tradeList').children.length > 0, 60000, 'trade token list');
const items = el('tradeList').children;
const labelOf = (b) => b.children.map((c) => (c._text ?? c.data ?? '') + (c.children ?? []).map((g) => g._text ?? g.data ?? '').join('')).join(' ');
check('trade token list rendered', items.length > 0, `${items.length} token(s)`);
// The listed token 0x3d40...7a1d is the ZENT token (evidence/verify-weth-path.mjs);
// its list label falls back to the address because the launch metadataURI
// carries no name/symbol, so match on the address fragment.
const zentBtn = items.find((b) => labelOf(b).includes('0x3d40'));
check('ZENT token (0x3d40...7a1d) is listed', !!zentBtn, items.map(labelOf).join(' | '));
if (zentBtn) check('ZENT shows Trading open', labelOf(zentBtn).includes('Trading open'), labelOf(zentBtn));

// 3. Selecting ZENT produces live WETH quotes in the estimate box.
if (zentBtn) zentBtn.click();
await waitFor(() => el('tradeEstimate').innerHTML.includes('WETH'), 60000, 'trade estimate with WETH quote');
const est = el('tradeEstimate').innerHTML;
check('estimate shows a buy quote in WETH', /Buy with 0\.01 WETH/.test(est), '');
check('estimate shows a sell quote paying WETH', /Sell [\d.,]+ (ZENT|tokens)/.test(est) && /WETH/.test(est), '');
check('estimate is a prepared quote, not a curve-only estimate', !est.includes('(estimate)'), '');
check('no leftover "one-click ETH trading is not available" wording', !est.includes('one-click'), '');
check('keyless: Buy button stays disabled until a wallet connects', el('tradeBuyBtn').disabled === true);
check('keyless: estimate asks to connect a wallet', est.includes('Connect your wallet to buy or sell'), '');
console.log('\nEstimate box HTML:\n' + est);
console.log('Status line: ' + el('statusLine').textContent + ` (block ${blockShown})`);

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nLIVE CHECK: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
