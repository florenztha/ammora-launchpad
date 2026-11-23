// Florenz Launchpad — a static launchpad front-end built on the Ammora SDK 0.3.9.
// Reads and plan generation run keylessly against GIWA Sepolia; sending is done
// only through the visitor's own connected wallet. No keys exist in this bundle.
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

// ---------------------------------------------------------------- network panel
async function loadNetwork() {
  const rows = $('netRows');
  try {
    const [chainId, block, nextId] = await Promise.all([
      publicClient.getChainId(),
      publicClient.getBlock(),
      publicClient.readContract({ address: REGISTRY, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'nextConfigId' }),
    ]);
    const lock = giwaSepoliaTokenLockDeployment;
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
    rows.innerHTML = `<div class="row"><span class="k">Status</span><span class="v err">${esc(e.shortMessage ?? e.message)}</span></div>`;
  }
}

// ---------------------------------------------------------------- config loading
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
  } catch (e) {
    sel.innerHTML = '<option value="">failed to load configs</option>';
    $('cfgNote').textContent = e.shortMessage ?? e.message;
  }
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

async function loadLaunches() {
  const list = $('launchList');
  list.innerHTML = '<p class="sub">scanning…</p>';
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
    if (!recent.length) { list.innerHTML = '<p class="sub">No launches found in the scanned range.</p>'; return; }
    const items = [];
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
      items.push(`<div class="launch">
        <span class="t">${esc(meta ? `${meta.name} (${meta.symbol})` : 'Token ' + short(a.token))}</span>
        <span class="pill ${cls}">${esc(label)}</span>
        <div class="m">token ${esc(a.token)}<br>curve ${esc(a.curve)}<br>config #${esc(a.configId)} · block ${esc(log.blockNumber)}</div>
      </div>`);
    }
    list.innerHTML = items.join('');
    if (firstActiveCurve && !$('curveAddr').value) $('curveAddr').value = firstActiveCurve;
  } catch (e) {
    list.innerHTML = `<p class="sub err">${esc(e.shortMessage ?? e.message)}</p>`;
  }
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
  } else {
    $('planBtn').disabled = false;
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
    await showWallet();
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
    // The WETH balance is shown only inside the Create panel: the SDK's atomic
    // first buy is the one step that still settles in the protocol quote asset.
    $('wethBal').textContent = `Your WETH balance for the first-buy step below: ${formatEther(weth)} WETH. Your native ETH pays gas and the pool creation fee.`;
  } catch {
    $('walletAddr').textContent = `${walletName ? walletName + ' · ' : ''}${short(account)}`;
  }
}

// ---------------------------------------------------------------- create-launch plan
let currentPlan = null;

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
    const block = await publicClient.getBlock();
    const context = await verifyAmmoraPortableDeploymentAtBlock(publicClient, giwaSepoliaAtomicLaunchDeployment, block.number);
    const planner = new AmmoraPortableLifecyclePlanner(context, giwaSepoliaAtomicLaunchTargets);
    let maxFee = (block.baseFeePerGas ?? 1000000000n) * 3n;
    try { const fees = await publicClient.estimateFeesPerGas(); if (fees.maxFeePerGas) maxFee = fees.maxFeePerGas; } catch { /* fallback above */ }
    const plan = await planner.planExistingConfigAtomicFirstBuy({
      account,
      configId: entry.id,
      expectedConfigHash: entry.hash,
      launch: {
        name, symbol,
        metadataURI: $('tokMeta').value.trim(),
        creatorMetadataURI: '',
        tokenDecimals: entry.cfg.tokenDecimals,
      },
      firstBuys: [{ includedQuoteAmountRaw: firstBuyRaw, minimumBaseAmountOutRaw: minOut, allowPartialFill: false, recipient: account }],
      deadline: BigInt(Math.floor(Date.now() / 1000) + 1800),
      gas: { maxFeePerGasNativeRaw: maxFee, safetyMarginBps: 2000n },
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
    const hash = await walletClient.sendTransaction({
      account,
      chain: giwaSepolia,
      to: plan.transaction.to,
      data: plan.transaction.data,
      value: plan.transaction.value ?? 0n,
      gas: plan.estimatedGasUnits ? (plan.estimatedGasUnits * 130n) / 100n : undefined,
    });
    out.textContent += `\n\nSubmitted: ${hash}\nExplorer: ${EXPLORER}/tx/${hash}\nWaiting for receipt…`;
    const receipt = await publicClient.waitForTransactionReceipt({ hash });
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

// ---------------------------------------------------------------- quote panel
// Trading on a launch curve is native-ETH based. The SDK's AmmoraSwapClient
// plans the trade through the deployment's native router: a buy sends the
// amount as native transaction value (no ERC-20 approval), a sell pays native
// ETH back out. The router wraps/unwraps internally; the curve itself keeps
// custody of its quote asset (WETH), which is why the curve's own reference
// quote below is denominated in that protocol-internal asset.
let swapClientPromise = null;
function getSwapClient() {
  if (!swapClientPromise) {
    swapClientPromise = AmmoraSwapClient.create(publicClient, {
      deploymentCatalog: { [deployment.chain.id]: deployment },
    });
  }
  return swapClientPromise;
}

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
