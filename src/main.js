// Florenz Launchpad — a static launchpad front-end built on the Ammora SDK 0.3.9.
// Reads and plan generation run keylessly against GIWA Sepolia; sending is done
// only through the visitor's own connected wallet. No keys exist in this bundle.
//
// Layout: the main page is a simple two-card flow (Create Token, Buy / Sell)
// written in plain language. Everything technical from the original UI (full
// deployment catalog, config list, raw planner, raw quotes, raw errors) lives
// in the collapsed "Advanced" section and runs on the exact same SDK calls.
import {
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaTokenLockDeployment,
  giwaSepoliaAtomicLaunchDeployment,
  giwaSepoliaAtomicLaunchTargets,
  ammoraLaunchConfigRegistryV4Abi,
  ammoraLaunchFactoryV4Abi,
  AmmoraV4LaunchCurveClient,
  AmmoraSwapClient,
  verifyAmmoraPortableDeploymentAtBlock,
  AmmoraPortableLifecyclePlanner,
} from '@ammora-protocol/sdk';
import {
  createPublicClient, createWalletClient, custom, http, defineChain,
  parseEther, parseUnits, formatUnits, formatEther, erc20Abi, isAddress,
} from 'viem';

const RPC_URL = 'https://sepolia-rpc.giwa.io';
const EXPLORER = 'https://sepolia-explorer.giwa.io';
const QUARANTINED_CONFIG_ID = 6n; // Docs graduation readiness notice: never use Config 6 on this registry for new launches.

const deployment = giwaSepoliaAutoRouteDeployment;
const REGISTRY = deployment.contracts.launch.configRegistry;
const FACTORY = deployment.contracts.launch.factory;
const WETH = deployment.contracts.tokens.wrappedNative;
const NATIVE_ROUTER = deployment.contracts.routers.native;
const EXEC_REGISTRY = deployment.contracts.routers.executionRegistry;
const CORE = {
  launchFactory: giwaSepoliaAtomicLaunchDeployment.contracts.launchFactory,
  feePolicy: giwaSepoliaAtomicLaunchDeployment.contracts.feePolicy,
};

const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: EXPLORER } },
  testnet: true,
});

const publicClient = createPublicClient({
  chain: giwaSepolia,
  transport: http(RPC_URL, { timeout: 60_000, retryCount: 3, retryDelay: 1200 }),
});

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const short = (a) => (a ? `${a.slice(0, 6)}…${a.slice(-4)}` : '');
const fmtInt = (raw, decimals) => {
  const s = formatUnits(raw, decimals);
  const [i, f] = s.split('.');
  return Number(i).toLocaleString('en-US') + (f && !/^0+$/.test(f) ? '.' + f.slice(0, 4) : '');
};
const statusLabel = (s) => (s === 1 ? ['Active', 'active'] : s === 3 ? ['Graduated', 'grad'] : [`Status ${s}`, '']);

// Raw protocol errors never reach the main UI. They are appended here, in the
// Advanced section, while the main flow shows a plain-language sentence.
function logRaw(context, e) {
  const box = $('rawLog');
  if (!box) return;
  const line = `[${new Date().toLocaleTimeString()}] ${context}: ${e?.shortMessage ?? e?.message ?? String(e)}`;
  box.textContent = box.textContent ? `${box.textContent}\n${line}` : line;
}
function plainError(e) {
  const m = `${e?.shortMessage ?? ''} ${e?.message ?? ''}`;
  if (/user rejected|user denied|rejected the request/i.test(m)) return 'You cancelled the request in your wallet. Nothing was sent.';
  if (/insufficient funds/i.test(m)) return 'Your wallet does not have enough balance for this. Nothing was sent.';
  return 'Something went wrong. Nothing was completed; the technical details are in the Advanced section below.';
}

// ---------------------------------------------------------------- network
// One code path feeds both the compact status line in the header and the full
// catalog table in Advanced.
async function loadNetwork() {
  const rows = $('netRows');
  try {
    const [chainId, block, nextId] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlock(),
      publicClient.readContract({ address: REGISTRY, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'nextConfigId' }),
    ]);
    const lock = giwaSepoliaTokenLockDeployment;
    $('statusLine').textContent = `GIWA Sepolia testnet · Block ${block.number}`;
    rows.innerHTML = [
      ['Network', `GIWA Sepolia · chain ${chainId} · testnet`],
      ['Latest block', String(block.number)],
      ['Deployment slot', deployment.slot],
      ['Launch protocol', `Ammora V${deployment.contracts.launch.protocolVersion} (auto-route)`],
      ['Launch factory', FACTORY],
      ['Config registry', REGISTRY],
      ['First-buy executor', deployment.contracts.launch.firstBuyExecutor],
      ['Native router (ETH in / out)', NATIVE_ROUTER],
      ['Native execution registry', EXEC_REGISTRY],
      ['Curve quote asset (protocol-internal)', `${WETH} (WETH, custodied inside the curves)`],
      ['Token lock factory', lock.factory],
      ['Configs registered', `${nextId - 1n} (next id ${nextId})`],
    ].map(([k, v]) => `<div class="row"><span class="k">${esc(k)}</span><span class="v">${esc(v)}</span></div>`).join('');
  } catch (e) {
    $('statusLine').textContent = 'Network unavailable, retrying…';
    rows.innerHTML = `<div class="row"><span class="k">Status</span><span class="v err">${esc(e.shortMessage ?? e.message)}</span></div>`;
  }
}

// ---------------------------------------------------------------- configs
let qualifiedConfigs = [];
async function loadConfigs() {
  const sel = $('cfgSelect');
  try {
    const nextId = await publicClient.readContract({ address: REGISTRY, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'nextConfigId' });
    const ids = [];
    for (let id = 1n; id < nextId && id <= 200n; id++) ids.push(id);
    const found = [];
    for (let i = 0; i < ids.length; i += 8) {
      const batch = ids.slice(i, i + 8);
      const results = await Promise.all(batch.map(async (id) => {
        try {
          const [enabled, hash, cfg] = await Promise.all([
            publicClient.readContract({ address: REGISTRY, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'enabled', args: [id] }),
            publicClient.readContract({ address: REGISTRY, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'configHash', args: [id] }),
            publicClient.readContract({ address: REGISTRY, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'get', args: [id] }),
          ]);
          return { id, enabled, hash, cfg };
        } catch { return null; }
      }));
      for (const r of results) {
        // Docs readiness rules: enabled, migrationBaseThreshold == 0, and never the quarantined #6.
        if (r && r.enabled && r.cfg.migrationBaseThreshold === 0n && r.id !== QUARANTINED_CONFIG_ID) found.push(r);
      }
    }
    qualifiedConfigs = found;
    if (!found.length) {
      sel.innerHTML = '<option value="">no qualified config found</option>';
      return;
    }
    sel.innerHTML = found.map((r) =>
      `<option value="${r.id}">Config #${r.id} · supply ${fmtInt(r.cfg.totalSupply, r.cfg.tokenDecimals)} · graduation threshold ${formatEther(r.cfg.migrationQuoteThreshold)} (protocol quote asset)</option>`
    ).join('');
    sel.value = String(found[found.length - 1].id);
    $('cfgNote').textContent =
      `${found.length} qualified templates found. Config #6 is excluded: the Ammora graduation readiness notice quarantines it for new launches.`;
    updatePresetNote();
  } catch (e) {
    sel.innerHTML = '<option value="">failed to load configs</option>';
    $('cfgNote').textContent = e.shortMessage ?? e.message;
  }
}

// Config auto-pick rule for the simple Create Token flow (no dropdown there):
// the visitor's requested total supply picks the preset. Among the qualified
// configs, choose the one whose total supply is closest to the requested
// supply on a log scale (supplies span orders of magnitude). Config 78, the
// config proven end-to-end in evidence/, wins ties and is also the default
// when no supply is entered; if it is ever not qualified, fall back to the
// newest qualified config.
const PROVEN_CONFIG_ID = 78n;
function pickConfig(supplyWhole) {
  if (!qualifiedConfigs.length) return null;
  const proven = qualifiedConfigs.find((c) => c.id === PROVEN_CONFIG_ID) ?? null;
  if (supplyWhole == null || !(supplyWhole > 0)) {
    return proven ?? qualifiedConfigs[qualifiedConfigs.length - 1];
  }
  const target = Math.log10(supplyWhole);
  let best = null;
  let bestDist = Infinity;
  for (const c of qualifiedConfigs) {
    const s = Number(formatUnits(c.cfg.totalSupply, c.cfg.tokenDecimals));
    const d = Math.abs(Math.log10(Math.max(s, 1)) - target);
    if (d < bestDist - 1e-9 || (Math.abs(d - bestDist) <= 1e-9 && c.id === PROVEN_CONFIG_ID)) {
      best = c;
      bestDist = d;
    }
  }
  return best ?? proven ?? qualifiedConfigs[qualifiedConfigs.length - 1];
}
function requestedSupply() {
  const v = parseFloat($('ctSupply').value);
  return Number.isFinite(v) && v > 0 ? v : null;
}
function updatePresetNote() {
  const entry = pickConfig(requestedSupply());
  if (!entry) return;
  $('ctPresetNote').textContent =
    `Closest available preset: ${fmtInt(entry.cfg.totalSupply, entry.cfg.tokenDecimals)} tokens total supply. It is selected automatically.`;
}

// ---------------------------------------------------------------- launches scan
function parseMetaName(uri) {
  try {
    if (!uri || !uri.startsWith('data:application/json')) return null;
    const json = JSON.parse(decodeURIComponent(uri.slice('data:application/json,'.length)));
    if (json && (json.name || json.symbol)) return { name: json.name ?? '', symbol: json.symbol ?? '' };
  } catch { /* not parseable */ }
  return null;
}

let tradeTokens = []; // { token, curve, configId, name, symbol, status }
let selectedTrade = null;

async function loadLaunches() {
  const list = $('launchList');
  const tradeList = $('tradeList');
  list.innerHTML = '<p class="sub">scanning…</p>';
  tradeList.innerHTML = '<p class="sub">loading tokens…</p>';
  try {
    const latest = await publicClient.getBlockNumber();
    const event = ammoraLaunchFactoryV4Abi.find((x) => x.type === 'event' && x.name === 'LaunchCreated');
    const logs = [];
    // This RPC caps eth_getLogs at 10,000 blocks per call; scan backwards in 9,999-block chunks.
    for (let end = latest; end > deployment.startBlock && logs.length < 10; end -= 9999n) {
      const from = end - 9999n < deployment.startBlock ? deployment.startBlock : end - 9999n;
      const chunk = await publicClient.getLogs({ address: FACTORY, event, fromBlock: from, toBlock: end });
      logs.unshift(...chunk);
      if (chunk.length) break;
    }
    const recent = logs.slice(-8).reverse();
    if (!recent.length) {
      list.innerHTML = '<p class="sub">No launches found in the scanned range.</p>';
      tradeList.innerHTML = '<p class="sub">No tokens found yet.</p>';
      return;
    }
    const items = [];
    tradeTokens = [];
    let firstActiveCurve = null;
    for (const log of recent) {
      const a = log.args;
      const meta = parseMetaName(a.metadataURI);
      let status = null;
      try {
        const c = new AmmoraV4LaunchCurveClient(publicClient, a.curve, CORE);
        status = (await c.getState()).status;
      } catch { /* state read is best-effort for the list */ }
      if (status === 1 && !firstActiveCurve) firstActiveCurve = a.curve;
      const [label, cls] = status === null ? ['Unknown', ''] : statusLabel(status);
      const name = meta ? meta.name : 'Token ' + short(a.token);
      const symbol = meta ? meta.symbol : '';
      tradeTokens.push({ token: a.token, curve: a.curve, configId: a.configId, name, symbol, status });
      items.push(`<div class="launch">
        <span class="t">${esc(meta ? `${meta.name} (${meta.symbol})` : 'Token ' + short(a.token))}</span>
        <span class="pill ${cls}">${esc(label)}</span>
        <div class="m">token ${esc(a.token)}<br>curve ${esc(a.curve)}<br>config #${esc(a.configId)} · block ${esc(log.blockNumber)}</div>
      </div>`);
    }
    list.innerHTML = items.join('');
    renderTradeList();
    if (firstActiveCurve && !$('curveAddr').value) $('curveAddr').value = firstActiveCurve;
    const firstActive = tradeTokens.find((t) => t.status === 1) ?? tradeTokens[0];
    if (firstActive && !selectedTrade) selectTrade(firstActive, false);
    else if (selectedTrade) refreshTradeEstimate();
  } catch (e) {
    list.innerHTML = `<p class="sub err">${esc(e.shortMessage ?? e.message)}</p>`;
    tradeList.innerHTML = '<p class="sub">Could not load tokens. Details are in the Advanced section below.</p>';
    logRaw('loadLaunches', e);
  }
}

function renderTradeList() {
  const tradeList = $('tradeList');
  tradeList.innerHTML = '';
  for (const t of tradeTokens) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tokenitem' + (selectedTrade && selectedTrade.curve === t.curve ? ' sel' : '');
    const left = document.createElement('span');
    left.textContent = t.symbol ? `${t.name} (${t.symbol})` : t.name;
    const right = document.createElement('span');
    right.className = 'pill ' + (t.status === 1 ? 'active' : t.status === 3 ? 'grad' : '');
    right.textContent = t.status === 1 ? 'Trading open' : t.status === 3 ? 'Graduated' : 'Unknown';
    b.appendChild(left);
    b.appendChild(right);
    b.addEventListener('click', () => selectTrade(t, true));
    tradeList.appendChild(b);
  }
}

function selectTrade(t, userPicked) {
  selectedTrade = t;
  $('curveAddr').value = t.curve; // keep the Advanced quote panel in sync
  renderTradeList();
  $('tradeMsg').textContent = '';
  if (userPicked || true) refreshTradeEstimate();
}

// ---------------------------------------------------------------- wallet
// Provider discovery follows EIP-6963, and this is load-bearing, not cosmetic:
// when MetaMask and OKX Wallet are both installed, OKX claims the legacy
// window.ethereum object for itself, while MetaMask is only reachable through
// its EIP-6963 announcement. Code that talks only to window.ethereum can
// therefore only ever connect OKX. Every wallet interaction below goes through
// the one provider the visitor actually picked in the picker.
const GIWA_CHAIN_ID_HEX = '0x164CE'; // 91342, canonical hex form
const announcedWallets = new Map(); // EIP-6963 uuid -> { info, provider }
let selectedWallet = null; // { info, provider } chosen by the visitor
let walletName = '';
let account = null;
let walletClient = null;
let boundProvider = null;

function walletDisplayName(detail) {
  const { info, provider } = detail ?? {};
  if (info?.rdns === 'com.okex.wallet' || provider?.isOkxWallet) return 'OKX Wallet';
  if (info?.rdns === 'io.metamask') return 'MetaMask';
  if (info?.name) return info.name;
  if (provider?.isMetaMask) return 'MetaMask';
  return 'Browser wallet';
}

window.addEventListener('eip6963:announceProvider', (event) => {
  const detail = event.detail;
  if (detail?.info?.uuid && detail?.provider?.request) announcedWallets.set(detail.info.uuid, detail);
});
function requestWalletAnnouncements() {
  window.dispatchEvent(new Event('eip6963:requestProvider'));
}
requestWalletAnnouncements();

function legacyWalletDetail() {
  // Fallback for wallets that predate EIP-6963. OKX exposes its own global;
  // window.ethereum belongs to whichever wallet claimed it (often OKX), so it
  // is only used when no wallet announced itself at all.
  const okx = window.okxwallet?.request ? window.okxwallet : window.okxwallet?.ethereum;
  if (okx?.request) return { info: { uuid: 'legacy-okx', name: 'OKX Wallet', rdns: 'com.okex.wallet' }, provider: okx };
  const eth = window.ethereum;
  if (eth?.request) return { info: { uuid: 'legacy-ethereum', name: '', rdns: '' }, provider: eth };
  return null;
}

async function discoverWallets() {
  requestWalletAnnouncements();
  // Announcements arrive asynchronously; give wallets a brief window to answer.
  await new Promise((r) => setTimeout(r, 350));
  const found = [...announcedWallets.values()];
  if (!found.length) {
    const legacy = legacyWalletDetail();
    if (legacy) found.push(legacy);
  }
  return found;
}

function renderWalletPicker(wallets) {
  const picker = $('walletPicker');
  picker.innerHTML = '';
  const label = document.createElement('span');
  label.className = 'addr';
  label.textContent = 'Choose a wallet:';
  picker.appendChild(label);
  for (const detail of wallets) {
    const b = document.createElement('button');
    b.className = 'secondary';
    if (detail.info?.icon) {
      const img = document.createElement('img');
      img.src = detail.info.icon;
      img.alt = '';
      img.width = 16;
      img.height = 16;
      b.appendChild(img);
    }
    b.appendChild(document.createTextNode(walletDisplayName(detail)));
    b.addEventListener('click', () => connectWallet(detail));
    picker.appendChild(b);
  }
  picker.style.display = 'flex';
}
function hideWalletPicker() {
  $('walletPicker').style.display = 'none';
  $('walletPicker').innerHTML = '';
}

function bindProviderEvents(provider) {
  if (boundProvider === provider) return;
  unbindProviderEvents();
  boundProvider = provider;
  provider.on?.('accountsChanged', onAccountsChanged);
  provider.on?.('chainChanged', onChainChanged);
}
function unbindProviderEvents() {
  if (!boundProvider) return;
  boundProvider.removeListener?.('accountsChanged', onAccountsChanged);
  boundProvider.removeListener?.('chainChanged', onChainChanged);
  boundProvider = null;
}
async function onAccountsChanged(accounts) {
  if (!accounts?.length) { disconnectWallet(); return; }
  account = accounts[0];
  if (selectedWallet) {
    walletClient = createWalletClient({ account, chain: giwaSepolia, transport: custom(selectedWallet.provider) });
  }
  await showWallet();
}
function onChainChanged(chainIdHex) {
  if (parseInt(chainIdHex, 16) !== 91342) {
    $('walletAddr').innerHTML = '<span class="err">Wrong network: switch your wallet to GIWA Sepolia (chain 91342).</span>';
    $('planBtn').disabled = true;
    $('ctCreateBtn').disabled = true;
  } else {
    $('planBtn').disabled = false;
    $('ctCreateBtn').disabled = false;
    showWallet();
  }
}

async function onConnectClick() {
  if (account) { disconnectWallet(); return; }
  const btn = $('connectBtn');
  btn.disabled = true;
  try {
    const wallets = await discoverWallets();
    if (!wallets.length) {
      $('walletAddr').innerHTML = '<span class="err">No browser wallet found. Install MetaMask or OKX Wallet.</span>';
      return;
    }
    const stillThere = selectedWallet && wallets.some((w) => w.provider === selectedWallet.provider);
    if (wallets.length > 1 && !stillThere) { renderWalletPicker(wallets); return; }
    await connectWallet(stillThere ? selectedWallet : wallets[0]);
  } finally {
    btn.disabled = false;
  }
}

async function connectWallet(detail) {
  const btn = $('connectBtn');
  const provider = detail.provider;
  hideWalletPicker();
  try {
    btn.disabled = true;
    const accounts = await provider.request({ method: 'eth_requestAccounts' });
    if (!accounts?.length) throw new Error('The wallet returned no account.');
    const current = await provider.request({ method: 'eth_chainId' });
    if (parseInt(current, 16) !== 91342) {
      try {
        await provider.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: GIWA_CHAIN_ID_HEX }] });
      } catch (err) {
        if (err?.code === 4902) {
          await provider.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: GIWA_CHAIN_ID_HEX, chainName: 'GIWA Sepolia',
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
              rpcUrls: [RPC_URL], blockExplorerUrls: [EXPLORER],
            }],
          });
        } else throw err;
      }
    }
    selectedWallet = detail;
    walletName = walletDisplayName(detail);
    account = accounts[0];
    walletClient = createWalletClient({ account, chain: giwaSepolia, transport: custom(provider) });
    bindProviderEvents(provider);
    btn.textContent = 'Disconnect';
    $('planBtn').disabled = false;
    $('ctCreateBtn').disabled = false;
    await showWallet();
    refreshTradeEstimate();
  } catch (e) {
    $('walletAddr').innerHTML = `<span class="err">${esc(e.shortMessage ?? e.message)}</span>`;
  } finally {
    btn.disabled = false;
  }
}

async function disconnectWallet() {
  const provider = selectedWallet?.provider;
  account = null;
  walletClient = null;
  currentPlan = null;
  unbindProviderEvents();
  $('connectBtn').textContent = 'Connect Wallet';
  $('walletAddr').textContent = '';
  $('wethBal').textContent = '';
  $('planBtn').disabled = true;
  $('ctCreateBtn').disabled = true;
  $('sendPlanBtn').style.display = 'none';
  // Best effort: ask the wallet to revoke the eth_accounts permission so the
  // next connect re-prompts (MetaMask supports wallet_revokePermissions;
  // wallets without it simply ignore the attempt and the local disconnect
  // above still stands).
  try { await provider?.request({ method: 'wallet_revokePermissions', params: [{ eth_accounts: {} }] }); } catch { /* unsupported: local disconnect already done */ }
}

async function showWallet() {
  if (!account) return;
  try {
    const [eth, weth] = await Promise.all([
      publicClient.getBalance({ address: account }),
      publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    ]);
    $('walletAddr').textContent = `${walletName ? walletName + ' · ' : ''}${short(account)} · ${formatEther(eth)} ETH`;
    // This note lives inside the Advanced create panel: the SDK's atomic
    // first buy settles in the protocol quote asset. The Buy / Sell card
    // reads the same WETH balance separately for its own trades.
    $('wethBal').textContent = `Your WETH balance for the first-buy step below: ${formatEther(weth)} WETH. Your native ETH pays gas and the pool creation fee.`;
  } catch {
    $('walletAddr').textContent = `${walletName ? walletName + ' · ' : ''}${short(account)}`;
  }
}

// ---------------------------------------------------------------- launch planner (shared)
// One planner code path serves both the simple Create Token flow and the raw
// planner in Advanced. The SDK machinery is identical; only the presentation
// differs.
let currentPlan = null;

async function buildPlan(entry, { name, symbol, metadataURI, firstBuyRaw, minOut }) {
  const block = await publicClient.getBlock();
  const context = await verifyAmmoraPortableDeploymentAtBlock(publicClient, giwaSepoliaAtomicLaunchDeployment, block.number);
  const planner = new AmmoraPortableLifecyclePlanner(context, giwaSepoliaAtomicLaunchTargets);
  let maxFee = (block.baseFeePerGas ?? 1000000000n) * 3n;
  try { const fees = await publicClient.estimateFeesPerGas(); if (fees.maxFeePerGas) maxFee = fees.maxFeePerGas; } catch { /* fallback above */ }
  return planner.planExistingConfigAtomicFirstBuy({
    account,
    configId: entry.id,
    expectedConfigHash: entry.hash,
    launch: {
      name, symbol,
      metadataURI,
      creatorMetadataURI: '',
      tokenDecimals: entry.cfg.tokenDecimals,
    },
    firstBuys: [{ includedQuoteAmountRaw: firstBuyRaw, minimumBaseAmountOutRaw: minOut, allowPartialFill: false, recipient: account }],
    deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
    gas: { maxFeePerGasNativeRaw: maxFee, safetyMarginBps: 2000n },
  });
}

async function sendPlanTransaction(plan) {
  const hash = await walletClient.sendTransaction({
    account,
    chain: giwaSepolia,
    to: plan.transaction.to,
    data: plan.transaction.data,
    value: plan.transaction.value ?? 0n,
    gas: plan.estimatedGasUnits ? (plan.estimatedGasUnits * 130n) / 100n : undefined,
  });
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  return { hash, receipt };
}

// -------------------------------------------------- simple Create Token flow
function setSteps(defs) {
  // defs: [{ label, state: 'todo' | 'doing' | 'done' }]
  $('ctSteps').innerHTML = defs.map((d) => {
    const mark = d.state === 'done' ? '✓' : d.state === 'doing' ? '…' : '·';
    return `<li class="${esc(d.state)}"><span class="st">${mark}</span><span>${esc(d.label)}</span></li>`;
  }).join('');
}

async function createTokenSimple() {
  const msg = $('ctMsg');
  const btn = $('ctCreateBtn');
  msg.textContent = '';
  msg.className = 'msg';
  if (!account || !walletClient) { msg.textContent = 'Connect your wallet first, then create your token.'; return; }
  const name = $('ctName').value.trim();
  const symbol = $('ctSymbol').value.trim();
  if (!name || !symbol) { msg.textContent = 'Give your token a name and a symbol first.'; return; }
  let firstBuyRaw;
  try { firstBuyRaw = parseEther($('ctFirstBuy').value || '0'); } catch { msg.textContent = 'The first buy amount is not a valid number.'; return; }
  if (firstBuyRaw <= 0n) { msg.textContent = 'Enter a first buy amount above zero. The first buy is part of every launch.'; return; }
  const entry = pickConfig(requestedSupply());
  if (!entry) { msg.textContent = 'Launch presets are still loading. Wait a few seconds and try again.'; return; }

  const steps = [
    { label: 'Preparing your launch', state: 'doing' },
    { label: 'Approval in your wallet', state: 'todo' },
    { label: 'Sending the launch transaction', state: 'todo' },
    { label: 'Done', state: 'todo' },
  ];
  btn.disabled = true;
  try {
    setSteps(steps);
    let plan = await buildPlan(entry, { name, symbol, metadataURI: '', firstBuyRaw, minOut: 1n });
    if (plan.status === 'APPROVAL_REQUIRED') {
      steps[0].state = 'done';
      steps[1].state = 'doing';
      steps[1].label = 'Waiting for approval in your wallet';
      setSteps(steps);
      await sendPlanTransaction(plan);
      steps[1].state = 'done';
      steps[1].label = 'Approval confirmed';
      steps[2].state = 'doing';
      setSteps(steps);
      plan = await buildPlan(entry, { name, symbol, metadataURI: '', firstBuyRaw, minOut: 1n });
    } else {
      steps[0].state = 'done';
      steps[1].state = 'done';
      steps[1].label = 'No approval needed';
      steps[2].state = 'doing';
      setSteps(steps);
    }
    const { hash, receipt } = await sendPlanTransaction(plan);
    steps[2].state = 'done';
    if (receipt.status === 'success') {
      steps[3].state = 'done';
      steps[3].label = `Done: ${name} (${symbol}) is created`;
      setSteps(steps);
      msg.innerHTML = `Your token is live on the testnet. Transaction: <a href="${EXPLORER}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(short(hash))}</a>. It will appear in the Buy / Sell list after a rescan.`;
      msg.className = 'msg ok';
      loadLaunches();
    } else {
      setSteps(steps);
      msg.textContent = 'The transaction was sent but did not succeed on chain. The technical details are in the Advanced section below.';
      logRaw('createToken receipt', new Error(`tx ${hash} reverted in block ${receipt.blockNumber}`));
    }
    showWallet();
  } catch (e) {
    setSteps([]);
    msg.textContent = plainError(e);
    msg.className = 'msg err';
    logRaw('createToken', e);
  } finally {
    btn.disabled = false;
  }
}

// -------------------------------------------------- Advanced raw planner
async function generatePlan() {
  const out = $('planOut');
  const sendBtn = $('sendPlanBtn');
  sendBtn.style.display = 'none';
  currentPlan = null;
  if (!account) { out.textContent = 'Connect your wallet first: the planner binds the plan to your account.'; return; }
  const cfgId = BigInt($('cfgSelect').value || '0');
  const entry = qualifiedConfigs.find((c) => c.id === cfgId);
  if (!entry) { out.textContent = 'No qualified config selected.'; return; }
  const name = $('tokName').value.trim();
  const symbol = $('tokSymbol').value.trim();
  if (!name || !symbol) { out.textContent = 'Token name and symbol are required.'; return; }
  let firstBuyRaw;
  try { firstBuyRaw = parseEther($('firstBuy').value || '0'); } catch { out.textContent = 'Invalid first buy amount.'; return; }
  if (firstBuyRaw <= 0n) { out.textContent = 'First buy amount must be above zero: the atomic path always includes a first buy.'; return; }
  let minOut = 1n;
  try { minOut = BigInt($('minOut').value || '1'); } catch { out.textContent = 'Minimum out must be a raw integer.'; return; }

  out.textContent = 'Verifying deployment and simulating plan against the live chain…';
  try {
    const plan = await buildPlan(entry, {
      name, symbol,
      metadataURI: $('tokMeta').value.trim(),
      firstBuyRaw, minOut,
    });
    currentPlan = plan;
    const lines = [
      `Plan status: ${plan.status}`,
      `Operation: ${plan.operation} (${plan.transactionKind})`,
      `Config: #${plan.configId} · chain ${plan.chainId} · planned at block ${plan.asOfBlock}`,
      `Total first buy: ${formatEther(plan.totalQuoteAmountRaw)} WETH (the protocol quote asset; SDK 0.3.9 has no native-ETH first buy, see the note above)`,
      `Estimated gas: ${plan.estimatedGasUnits} units`,
    ];
    if (plan.status === 'APPROVAL_REQUIRED') {
      for (const r of plan.approvalRequirements) {
        const assetNote = r.token.toLowerCase() === WETH.toLowerCase() ? ' (WETH)' : '';
        lines.push(`Approval needed: ${formatUnits(r.exactAmountRaw, r.decimals)}${assetNote} of token ${r.token} to spender ${r.spender} (current allowance ${formatUnits(r.currentAllowanceRaw, r.decimals)})`);
      }
      lines.push('Next step: send the approval below, then generate the plan again for the launch step.');
    } else {
      lines.push(`Predicted token: ${plan.predictedToken}`);
      lines.push(`Predicted curve: ${plan.predictedCurve}`);
      lines.push('Next step: send the atomic create + first buy transaction below. Predictions are reconciled against the receipt after sending.');
    }
    lines.push(`Transaction target: ${plan.transaction.to}`);
    out.textContent = lines.join('\n');
    sendBtn.textContent = plan.status === 'APPROVAL_REQUIRED' ? 'Send approval' : 'Send launch transaction';
    sendBtn.style.display = '';
  } catch (e) {
    out.textContent = 'Plan failed: ' + (e.shortMessage ?? e.message);
  }
}

async function sendPlanStep() {
  const out = $('planOut');
  if (!currentPlan || !walletClient || !account) return;
  const btn = $('sendPlanBtn');
  try {
    btn.disabled = true;
    const plan = currentPlan;
    out.textContent += '\n\nSending…';
    const { hash, receipt } = await sendPlanTransaction(plan);
    out.textContent += `\nSubmitted: ${hash}\nExplorer: ${EXPLORER}/tx/${hash}`;
    out.textContent += `\nReceipt: status ${receipt.status}, block ${receipt.blockNumber}.`;
    if (plan.status === 'APPROVAL_REQUIRED') {
      out.textContent += '\nApproval confirmed. Generate the plan again to prepare the launch transaction.';
      currentPlan = null;
      btn.style.display = 'none';
    } else {
      out.textContent += `\nLaunch sent. Predicted token ${plan.predictedToken} and curve ${plan.predictedCurve} should now exist; verify them in the launches list after a rescan.`;
      currentPlan = null;
      btn.style.display = 'none';
      loadLaunches();
    }
    showWallet();
  } catch (e) {
    out.textContent += '\nSend failed: ' + (e.shortMessage ?? e.message);
  } finally {
    btn.disabled = false;
  }
}

// ---------------------------------------------------------------- swap client (shared)
// The simple Buy / Sell card trades in WETH, the protocol's quote asset.
// With inputAsset/outputAsset 'erc20' the SDK's AmmoraSwapClient skips the
// native execution registry check (that check runs only for 'native'
// assets) and prepares a swapExactInput transaction directly against the
// token's own curve contract: an exact-amount ERC-20 approval per trade and
// transaction value 0. Verified live in evidence/verify-weth-path.mjs:
// prepare plus eth_call simulations matched the SDK quotes exactly, in both
// directions, on live curves. The Advanced quote panel further below still
// uses the native router path ('native' assets), which remains
// registry-blocked chain-side; nothing there changed.
let swapClientPromise = null;
function getSwapClient() {
  if (!swapClientPromise) {
    swapClientPromise = AmmoraSwapClient.create(publicClient, {
      deploymentCatalog: { [deployment.chain.id]: deployment },
    });
  }
  return swapClientPromise;
}

// -------------------------------------------------- simple Buy / Sell flow
let tradeState = null; // { state, baseDecimals }
let tradePlans = { buy: null, sell: null };
let estimateTimer = null;

async function computeTradeSide(dir, curve, state, baseDecimals, amount) {
  // Returns { prepared|null, prepareError, fallbackOut: bigint|null }.
  // Trades are prepared in WETH ('erc20' assets) so the SDK targets the
  // token's curve contract directly; the registry check that blocks the
  // native path does not run for erc20 assets (see the swap-client note
  // above and evidence/verify-weth-path.mjs).
  const payer = account ?? state.creator;
  const swaps = await getSwapClient();
  let prepared = null;
  let prepareError = null;
  try {
    if (dir === 'buy') {
      prepared = await swaps.prepareExactIn({
        model: 'dbc', pool: curve.curve, tokenIn: WETH, inputAsset: 'erc20',
        amountIn: amount, payer, recipient: payer, slippageBps: 100,
      });
    } else {
      prepared = await swaps.prepareExactIn({
        model: 'dbc', pool: curve.curve, tokenIn: state.baseToken, outputAsset: 'erc20',
        amountIn: amount, payer, recipient: payer, slippageBps: 100,
      });
    }
  } catch (e) {
    prepareError = e;
  }
  let fallbackOut = null;
  if (!prepared) {
    try {
      const q = await curve.quoteExactInput(amount, dir === 'sell');
      fallbackOut = q.amountOut;
    } catch { /* graduated curves revert here; the caller presents that plainly */ }
  }
  return { prepared, prepareError, fallbackOut };
}

async function refreshTradeEstimate() {
  const box = $('tradeEstimate');
  const buyBtn = $('tradeBuyBtn');
  const sellBtn = $('tradeSellBtn');
  tradePlans = { buy: null, sell: null };
  buyBtn.disabled = true;
  sellBtn.disabled = true;
  if (!selectedTrade) { box.innerHTML = ''; return; }
  const t = selectedTrade;
  if (t.status === 3) {
    box.innerHTML = '<div class="row"><span class="k">This token has graduated. Trading on this page is closed for it.</span></div>';
    return;
  }
  if (t.status !== 1) {
    box.innerHTML = '<div class="row"><span class="k">This token\'s status could not be read, so trading is unavailable for it.</span></div>';
    return;
  }
  const amtStr = $('tradeAmt').value || '0';
  let buyAmount;
  let sellAmount;
  try {
    buyAmount = parseEther(amtStr);
  } catch { box.innerHTML = '<div class="row"><span class="k">Enter a valid amount.</span></div>'; return; }
  box.innerHTML = '<div class="row"><span class="k">Estimating…</span></div>';
  try {
    const curve = new AmmoraV4LaunchCurveClient(publicClient, t.curve, CORE);
    const state = await curve.getState();
    const baseDecimals = await publicClient.readContract({ address: state.baseToken, abi: erc20Abi, functionName: 'decimals' });
    tradeState = { state, baseDecimals };
    try { sellAmount = parseUnits(amtStr, baseDecimals); } catch { sellAmount = 0n; }
    const sym = t.symbol || 'tokens';
    const rows = [];
    let unprepared = false;
    let wethBalance = null;
    if (account) {
      try {
        wethBalance = await publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] });
        rows.push(`<div class="row"><span class="k">Your WETH balance</span><span class="v">${esc(formatEther(wethBalance))} WETH</span></div>`);
      } catch { /* balance row is informational; the trade itself is checked on chain */ }
    }
    if (buyAmount > 0n) {
      const r = await computeTradeSide('buy', curve, state, baseDecimals, buyAmount);
      if (r.prepared) {
        tradePlans.buy = r.prepared;
        rows.push(`<div class="row"><span class="k">Buy with ${esc(formatEther(buyAmount))} WETH</span><span class="v">≈ ${esc(fmtInt(r.prepared.quote.expectedAmountOut, baseDecimals))} ${esc(sym)}</span></div>`);
        if (wethBalance != null && buyAmount > wethBalance) {
          rows.push('<div class="row"><span class="k">Your WETH balance is below this buy amount, so the buy cannot go through yet.</span></div>');
        }
      } else {
        unprepared = true;
        logRaw('weth buy quote', r.prepareError);
        rows.push(r.fallbackOut != null
          ? `<div class="row"><span class="k">Buy with ${esc(formatEther(buyAmount))} WETH</span><span class="v">≈ ${esc(fmtInt(r.fallbackOut, baseDecimals))} ${esc(sym)} (estimate)</span></div>`
          : `<div class="row"><span class="k">Buy estimate unavailable right now.</span></div>`);
      }
    }
    if (sellAmount > 0n) {
      const r = await computeTradeSide('sell', curve, state, baseDecimals, sellAmount);
      if (r.prepared) {
        tradePlans.sell = r.prepared;
        rows.push(`<div class="row"><span class="k">Sell ${esc(fmtInt(sellAmount, baseDecimals))} ${esc(sym)}</span><span class="v">≈ ${esc(formatEther(r.prepared.quote.expectedAmountOut))} WETH</span></div>`);
      } else {
        unprepared = true;
        logRaw('weth sell quote', r.prepareError);
        rows.push(r.fallbackOut != null
          ? `<div class="row"><span class="k">Sell ${esc(fmtInt(sellAmount, baseDecimals))} ${esc(sym)}</span><span class="v">≈ ${esc(formatEther(r.fallbackOut))} WETH (estimate)</span></div>`
          : `<div class="row"><span class="k">Sell estimate unavailable right now.</span></div>`);
      }
    }
    if (!rows.length) rows.push('<div class="row"><span class="k">Enter an amount to see an estimate.</span></div>');
    if (unprepared) {
      rows.push('<div class="row"><span class="k">Trading could not be prepared for this token right now, so the buttons stay off. The estimate above comes from the token\'s own price curve.</span></div>');
    }
    box.innerHTML = rows.join('');
    buyBtn.disabled = !(tradePlans.buy && account);
    sellBtn.disabled = !(tradePlans.sell && account);
    if (!account && (tradePlans.buy || tradePlans.sell)) {
      box.innerHTML += '<div class="row"><span class="k">Connect your wallet to buy or sell.</span></div>';
    }
  } catch (e) {
    box.innerHTML = '<div class="row"><span class="k">Could not estimate right now. The technical details are in the Advanced section below.</span></div>';
    logRaw('trade estimate', e);
  }
}

async function executeTrade(dir) {
  const msg = $('tradeMsg');
  msg.textContent = '';
  msg.className = 'msg';
  if (!account || !walletClient) { msg.textContent = 'Connect your wallet first.'; return; }
  if (!selectedTrade || !tradeState) { msg.textContent = 'Pick a token first.'; return; }
  const btn = dir === 'buy' ? $('tradeBuyBtn') : $('tradeSellBtn');
  btn.disabled = true;
  try {
    msg.textContent = 'Preparing…';
    // Re-prepare bound to the connected account so the plan is sendable.
    const curve = new AmmoraV4LaunchCurveClient(publicClient, selectedTrade.curve, CORE);
    const amtStr = $('tradeAmt').value || '0';
    const amount = dir === 'buy' ? parseEther(amtStr) : parseUnits(amtStr, tradeState.baseDecimals);
    if (amount <= 0n) { msg.textContent = 'Enter an amount above zero.'; return; }
    const r = await computeTradeSide(dir, curve, tradeState.state, tradeState.baseDecimals, amount);
    if (!r.prepared) {
      msg.textContent = 'Trading could not be prepared for this token right now. The technical details are in the Advanced section below.';
      logRaw(`weth ${dir} prepare`, r.prepareError);
      return;
    }
    const prepared = r.prepared;
    // Approvals first: the plan asks for one exact-amount approval per trade
    // (WETH to the curve for a buy, the token to the curve for a sell), with
    // the token's own curve contract as the spender.
    for (const req of prepared.approvalRequirements ?? []) {
      msg.textContent = 'Approving the exact trade amount in your wallet…';
      const tokenAddr = req.token ?? (dir === 'sell' ? tradeState.state.baseToken : WETH);
      const amountRaw = req.amount ?? req.exactAmountRaw;
      const hash = await walletClient.writeContract({
        account, chain: giwaSepolia,
        address: tokenAddr, abi: erc20Abi, functionName: 'approve',
        args: [req.spender, amountRaw],
      });
      await publicClient.waitForTransactionReceipt({ hash });
    }
    msg.textContent = 'Sending the swap…';
    const hash = await walletClient.sendTransaction({
      account,
      chain: giwaSepolia,
      to: prepared.transaction.to,
      data: prepared.transaction.data,
      value: prepared.transaction.value ?? 0n,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
    if (receipt.status === 'success') {
      msg.innerHTML = `Done. Transaction: <a href="${EXPLORER}/tx/${esc(hash)}" target="_blank" rel="noopener">${esc(short(hash))}</a>.`;
      msg.className = 'msg ok';
    } else {
      msg.textContent = 'The transaction was sent but did not succeed on chain. The technical details are in the Advanced section below.';
      logRaw('trade receipt', new Error(`tx ${hash} reverted in block ${receipt.blockNumber}`));
    }
    showWallet();
    refreshTradeEstimate();
  } catch (e) {
    msg.textContent = plainError(e);
    msg.className = 'msg err';
    logRaw(`trade ${dir}`, e);
  } finally {
    btn.disabled = !(dir === 'buy' ? tradePlans.buy : tradePlans.sell) || !account;
  }
}

// -------------------------------------------------- Advanced raw quote panel
// Trading on a launch curve is native-ETH based. The SDK's AmmoraSwapClient
// plans the trade through the deployment's native router: a buy sends the
// amount as native transaction value (no ERC-20 approval), a sell pays native
// ETH back out. The router wraps/unwraps internally; the curve itself keeps
// custody of its quote asset (WETH), which is why the curve's own reference
// quote below is denominated in that protocol-internal asset.
async function runQuote() {
  const out = $('quoteOut');
  const curveAddr = $('curveAddr').value.trim();
  if (!isAddress(curveAddr)) { out.textContent = 'Enter a valid curve address.'; return; }
  out.textContent = 'Reading curve…';
  try {
    const curve = new AmmoraV4LaunchCurveClient(publicClient, curveAddr, CORE);
    const state = await curve.getState();
    const baseDecimals = await publicClient.readContract({ address: state.baseToken, abi: erc20Abi, functionName: 'decimals' });
    const dir = $('direction').value;
    const baseForQuote = dir === 'sell';
    const amtStr = $('quoteAmt').value || '0';
    const amount = baseForQuote ? parseUnits(amtStr, baseDecimals) : parseEther(amtStr);
    if (amount <= 0n) { out.textContent = 'Amount must be above zero.'; return; }
    const [label] = statusLabel(state.status);
    const lines = [
      `Curve status: ${label} · config #${state.configId} · fee ${state.currentFeeBps} bps`,
      `Base token: ${state.baseToken} (${baseDecimals} decimals)`,
      `Base reserve: ${fmtInt(state.baseReserve, baseDecimals)} base`,
      '',
      '— Native ETH quote (Ammora native router) —',
    ];
    // The native plan is bound to a payer. With a connected wallet that is the
    // visitor's own account; otherwise the curve creator is used as a read-only
    // reference payer (quoting never signs or sends).
    const payer = account ?? state.creator;
    try {
      const swaps = await getSwapClient();
      if (!baseForQuote) {
        const prepared = await swaps.prepareExactIn({
          model: 'dbc', pool: curveAddr, tokenIn: WETH, inputAsset: 'native',
          amountIn: amount, payer, recipient: payer, slippageBps: 100,
        });
        const q = prepared.quote;
        lines.push(`You pay: ${formatEther(amount)} ETH (native GIWA Sepolia ETH, sent as transaction value)`);
        lines.push(`You receive (est.): ${formatUnits(q.expectedAmountOut, baseDecimals)} base · minimum ${formatUnits(q.minimumAmountOut, baseDecimals)} base`);
        if (q.feeAmount != null) lines.push(`Fee: ${formatUnits(q.feeAmount, 18)} ETH (included in the amount you pay)`);
        lines.push(`Plan target: native router ${prepared.transaction.to} · transaction value ${formatEther(prepared.transaction.value ?? amount)} ETH · ERC-20 approvals required: ${prepared.approvalRequirements.length}`);
        lines.push(`Quoted at block ${q.quoteBlockNumber} · payer ${short(payer)}${account ? '' : ' (curve creator, read-only reference; connect your wallet to bind a plan to your account)'}`);
      } else {
        const prepared = await swaps.prepareExactIn({
          model: 'dbc', pool: curveAddr, tokenIn: state.baseToken, outputAsset: 'native',
          amountIn: amount, payer, recipient: payer, slippageBps: 100,
        });
        const q = prepared.quote;
        lines.push(`You pay: ${formatUnits(amount, baseDecimals)} base`);
        lines.push(`You receive (est.): ${formatEther(q.expectedAmountOut)} ETH (native, paid out by the native router) · minimum ${formatEther(q.minimumAmountOut)} ETH`);
        if (q.feeAmount != null) lines.push(`Fee: ${formatUnits(q.feeAmount, baseDecimals)} base`);
        const approvals = prepared.approvalRequirements.map((r) => `${formatUnits(r.amount, baseDecimals)} base to router ${short(r.spender)}`).join('; ');
        lines.push(`Plan target: native router ${prepared.transaction.to} · approval required: ${approvals || 'none'}`);
        lines.push(`Quoted at block ${q.quoteBlockNumber} · payer ${short(payer)}${account ? '' : ' (curve creator, read-only reference; connect your wallet to bind a plan to your account)'}`);
      }
    } catch (e) {
      lines.push(`Native ETH path unavailable for this curve: ${e.shortMessage ?? e.message}`);
      lines.push('Why: the SDK sends native ETH through the native router only for curves Ammora has registered in the native execution registry. This curve is not registered yet, so the SDK fails closed rather than falling back to a WETH trade.');
    }
    lines.push('', '— Protocol reference quote (curve quote asset) —');
    try {
      const q = await curve.quoteExactInput(amount, baseForQuote);
      const inUnit = baseForQuote ? 'base' : 'WETH (protocol quote asset)';
      const outUnit = baseForQuote ? 'WETH (protocol quote asset)' : 'base';
      const inDec = baseForQuote ? baseDecimals : 18;
      const outDec = baseForQuote ? 18 : baseDecimals;
      lines.push(`Curve quote: ${formatUnits(amount, inDec)} ${inUnit} → ${formatUnits(q.amountOut, outDec)} ${outUnit}`);
      lines.push(`Fee: ${formatUnits(q.fee, inDec)} ${inUnit} · unfilled remainder: ${formatUnits(q.amountLeft, inDec)} · quoted at block ${q.asOfBlock}`);
      lines.push('Note: the curve custodies its quote asset internally as WETH. In a native trade the router wraps your ETH for the curve and unwraps the proceeds back to ETH, so you never hold or approve WETH yourself.');
    } catch (e) {
      lines.push('Reference quote failed: ' + (e.shortMessage ?? e.message));
      lines.push('Note: graduated curves (status 3) no longer quote pre-graduation trades; pick an active curve from the launches list.');
    }
    out.textContent = lines.join('\n');
  } catch (e) {
    out.textContent = 'Quote failed: ' + (e.shortMessage ?? e.message);
  }
}

// ---------------------------------------------------------------- wiring
$('connectBtn').addEventListener('click', onConnectClick);
$('refreshNet').addEventListener('click', loadNetwork);
$('refreshLaunches').addEventListener('click', loadLaunches);
$('planBtn').addEventListener('click', generatePlan);
$('sendPlanBtn').addEventListener('click', sendPlanStep);
$('quoteBtn').addEventListener('click', runQuote);
$('ctCreateBtn').addEventListener('click', createTokenSimple);
$('ctSupply').addEventListener('input', updatePresetNote);
$('tradeBuyBtn').addEventListener('click', () => executeTrade('buy'));
$('tradeSellBtn').addEventListener('click', () => executeTrade('sell'));
$('tradeAmt').addEventListener('input', () => {
  clearTimeout(estimateTimer);
  estimateTimer = setTimeout(refreshTradeEstimate, 450);
});
$('direction').addEventListener('change', () => {
  $('amtLabel').textContent = $('direction').value === 'sell'
    ? 'Amount in (base token)'
    : 'Amount in (ETH, native GIWA Sepolia)';
});
// Account/chain change events are bound to the selected provider at connect
// time (see bindProviderEvents); there is deliberately no window.ethereum
// listener here, since window.ethereum may belong to a different wallet.
loadNetwork();
loadConfigs();
loadLaunches();
setInterval(loadNetwork, 30000);
