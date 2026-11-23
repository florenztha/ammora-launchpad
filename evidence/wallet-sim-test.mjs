// Headless simulation test for the site's wallet discovery + connect flow.
// Reproduces the reported bug condition: OKX Wallet owns window.ethereum while
// MetaMask is only reachable via EIP-6963. Loads the BUILT bundle (docs/bundle.js)
// with a stub DOM, clicks Connect, and asserts the picker offers both wallets and
// that choosing MetaMask sends every request to MetaMask and none to OKX.
// Usage: node evidence/wallet-sim-test.mjs [switch|add]
//   switch: wallet_switchEthereumChain succeeds
//   add:    switch throws 4902, wallet_addEthereumChain must follow with the exact payload
import { readFileSync } from 'node:fs';

const scenario = process.argv[2] || 'switch';
const TEST_ACCOUNT = '0x1C6fc66d6C059Db31BAea571FdCe8b18A3C9cBbf';
const results = [];
const check = (name, ok, extra = '') => { results.push([name, ok]); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); };

// ---------------------------------------------------------- fake wallets
function fakeWallet(kind, { failSwitch = false } = {}) {
  const calls = [];
  return {
    calls,
    isMetaMask: kind === 'metamask',
    isOkxWallet: kind === 'okx',
    async request({ method, params }) {
      calls.push({ method, params });
      if (method === 'eth_requestAccounts') return [TEST_ACCOUNT];
      if (method === 'eth_chainId') return '0x1'; // wallet starts on Ethereum mainnet
      if (method === 'wallet_switchEthereumChain') {
        if (failSwitch) throw Object.assign(new Error('Unrecognized chain ID. Try adding the chain using wallet_addEthereumChain first.'), { code: 4902 });
        return null;
      }
      if (method === 'wallet_addEthereumChain') return null;
      if (method === 'wallet_revokePermissions') return null;
      throw new Error('unexpected method: ' + method);
    },
    on() { /* listeners accepted, never fired in this harness */ },
    removeListener() { /* no-op */ },
  };
}
const mmProvider = fakeWallet('metamask', { failSwitch: scenario === 'add' });
const okxProvider = fakeWallet('okx');
const mmDetail = { info: { uuid: 'sim-metamask', name: 'MetaMask', rdns: 'io.metamask', icon: 'data:image/svg+xml,<svg/>' }, provider: mmProvider };
const okxDetail = { info: { uuid: 'sim-okx', name: 'OKX Wallet', rdns: 'com.okex.wallet', icon: 'data:image/svg+xml,<svg/>' }, provider: okxProvider };

// ---------------------------------------------------------- stub DOM
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

// ---------------------------------------------------------- window with the bug condition:
// OKX owns window.ethereum (and window.okxwallet); MetaMask exists ONLY as an
// EIP-6963 announcement. This is exactly the user's browser setup.
const win = new EventTarget();
win.ethereum = okxProvider;
win.okxwallet = okxProvider;
globalThis.window = win;
win.addEventListener('eip6963:requestProvider', () => {
  for (const detail of [mmDetail, okxDetail]) {
    const e = new Event('eip6963:announceProvider');
    e.detail = detail;
    win.dispatchEvent(e);
  }
});

// ---------------------------------------------------------- load the built site bundle
const bundle = readFileSync(new URL('../docs/bundle.js', import.meta.url), 'utf8');
eval(bundle);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) { if (fn()) return true; await sleep(100); }
  throw new Error('timeout waiting for: ' + what);
}

// ---------------------------------------------------------- drive the flow
await waitFor(() => (el('connectBtn')._listeners.click ?? []).length > 0, 5000, 'connect handler registered');
el('connectBtn').click(); // user clicks "Connect Wallet"
await waitFor(() => el('walletPicker').children.length >= 3, 8000, 'wallet picker with both wallets');
const pickerButtons = el('walletPicker').children.filter((c) => c.tagName === 'BUTTON');
const names = pickerButtons.map((b) => b.children.map((c) => c.data ?? '').join(''));
check('picker offers MetaMask and OKX Wallet', names.some((n) => n.includes('MetaMask')) && names.some((n) => n.includes('OKX')), names.join(' | '));
check('no wallet was contacted before the user picked one', mmProvider.calls.length === 0 && okxProvider.calls.length === 0);

const mmButton = pickerButtons[names.findIndex((n) => n.includes('MetaMask'))];
mmButton.click(); // user picks MetaMask
await waitFor(() => el('connectBtn').textContent === 'Disconnect', 25000, 'connected state after picking MetaMask');

check('MetaMask received eth_requestAccounts', mmProvider.calls.some((c) => c.method === 'eth_requestAccounts'));
check('OKX received ZERO requests (window.ethereum was never used)', okxProvider.calls.length === 0, `okx calls: ${okxProvider.calls.length}`);
const switchCall = mmProvider.calls.find((c) => c.method === 'wallet_switchEthereumChain');
if (scenario === 'switch') {
  check('switch payload chainId is exactly 0x164CE', switchCall?.params?.[0]?.chainId === '0x164CE', JSON.stringify(switchCall?.params));
} else {
  const addCall = mmProvider.calls.find((c) => c.method === 'wallet_addEthereumChain');
  const p = addCall?.params?.[0] ?? {};
  check('after 4902, add-chain called on MetaMask', !!addCall);
  check('add payload chainId is exactly 0x164CE', p.chainId === '0x164CE', p.chainId);
  check('add payload chainName', p.chainName === 'GIWA Sepolia', p.chainName);
  check('add payload nativeCurrency ETH/18', p.nativeCurrency?.symbol === 'ETH' && p.nativeCurrency?.decimals === 18 && !!p.nativeCurrency?.name, JSON.stringify(p.nativeCurrency));
  check('add payload rpcUrls', Array.isArray(p.rpcUrls) && p.rpcUrls[0] === 'https://sepolia-rpc.giwa.io', JSON.stringify(p.rpcUrls));
  check('add payload blockExplorerUrls', Array.isArray(p.blockExplorerUrls) && p.blockExplorerUrls[0] === 'https://sepolia-explorer.giwa.io', JSON.stringify(p.blockExplorerUrls));
}
await waitFor(() => el('walletAddr').textContent.includes('MetaMask'), 25000, 'wallet header shows MetaMask');
check('header shows the selected wallet name (MetaMask)', el('walletAddr').textContent.includes('MetaMask'), el('walletAddr').textContent);
check('header shows ETH balance line', el('walletAddr').textContent.includes('ETH'), el('walletAddr').textContent);
check('Generate plan button enabled after connect', el('planBtn').disabled === false);

// disconnect: click again
el('connectBtn').click();
await sleep(300);
check('disconnect returns button to Connect Wallet', el('connectBtn').textContent === 'Connect Wallet');
check('disconnect asked MetaMask to revoke eth_accounts (best effort)', mmProvider.calls.some((c) => c.method === 'wallet_revokePermissions'));
check('disconnect cleared the header', el('walletAddr').textContent === '');

const failed = results.filter(([, ok]) => !ok).length;
console.log(`\nSCENARIO ${scenario}: ${results.length - failed}/${results.length} checks passed`);
process.exit(failed ? 1 : 0);
