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
      ['Quote asset (WETH)', WETH],
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
      `<option value="${r.id}">Config #${r.id} · supply ${fmtInt(r.cfg.totalSupply, r.cfg.tokenDecimals)} · graduates at ${formatEther(r.cfg.migrationQuoteThreshold)} WETH</option>`
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
let account = null;
let walletClient = null;

async function connectWallet() {
  const btn = $('connectBtn');
  if (!window.ethereum) {
    $('walletAddr').innerHTML = '<span class="err">No browser wallet found. Install MetaMask or a compatible wallet.</span>';
    return;
  }
  try {
    btn.disabled = true;
    const accounts = await window.ethereum.request({ method: 'eth_requestAccounts' });
    account = accounts[0];
    const current = await window.ethereum.request({ method: 'eth_chainId' });
    if (parseInt(current, 16) !== 91342) {
      try {
        await window.ethereum.request({ method: 'wallet_switchEthereumChain', params: [{ chainId: '0x164ce' }] });
      } catch (err) {
        if (err.code === 4902) {
          await window.ethereum.request({
            method: 'wallet_addEthereumChain',
            params: [{
              chainId: '0x164ce', chainName: 'GIWA Sepolia',
              nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
              rpcUrls: [RPC_URL], blockExplorerUrls: [EXPLORER],
            }],
          });
        } else throw err;
      }
    }
    walletClient = createWalletClient({ chain: giwaSepolia, transport: custom(window.ethereum) });
    btn.textContent = 'Connected';
    $('planBtn').disabled = false;
    await showWallet();
  } catch (e) {
    $('walletAddr').innerHTML = `<span class="err">${esc(e.shortMessage ?? e.message)}</span>`;
    btn.disabled = false;
  }
}

async function showWallet() {
  if (!account) return;
  try {
    const [eth, weth] = await Promise.all([
      publicClient.getBalance({ address: account }),
      publicClient.readContract({ address: WETH, abi: erc20Abi, functionName: 'balanceOf', args: [account] }),
    ]);
    $('walletAddr').textContent = `${short(account)} · ${formatEther(eth)} ETH · ${formatEther(weth)} WETH`;
  } catch {
    $('walletAddr').textContent = short(account);
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
      `Total first buy: ${formatEther(plan.totalQuoteAmountRaw)} WETH`,
      `Estimated gas: ${plan.estimatedGasUnits} units`,
    ];
    if (plan.status === 'APPROVAL_REQUIRED') {
      for (const r of plan.approvalRequirements) {
        lines.push(`Approval needed: ${formatUnits(r.exactAmountRaw, r.decimals)} of token ${r.token} to spender ${r.spender} (current allowance ${formatUnits(r.currentAllowanceRaw, r.decimals)})`);
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
    const inDecimals = baseForQuote ? baseDecimals : 18;
    const outDecimals = baseForQuote ? 18 : baseDecimals;
    const amount = parseUnits($('quoteAmt').value || '0', inDecimals);
    if (amount <= 0n) { out.textContent = 'Amount must be above zero.'; return; }
    const q = await curve.quoteExactInput(amount, baseForQuote);
    const [label] = statusLabel(state.status);
    out.textContent = [
      `Curve status: ${label} · config #${state.configId} · fee ${state.currentFeeBps} bps`,
      `Base token: ${state.baseToken} (${baseDecimals} decimals)`,
      `Reserves: ${fmtInt(state.baseReserve, baseDecimals)} base · ${formatEther(state.quoteReserve)} WETH`,
      `You pay: ${formatUnits(amount, inDecimals)} ${baseForQuote ? 'base' : 'WETH'}`,
      `You receive (est.): ${formatUnits(q.amountOut, outDecimals)} ${baseForQuote ? 'WETH' : 'base'}`,
      `Fee: ${formatUnits(q.fee, inDecimals)} ${baseForQuote ? 'base' : 'WETH'} · unfilled remainder: ${formatUnits(q.amountLeft, inDecimals)}`,
      `Quoted at block ${q.asOfBlock}`,
    ].join('\n');
  } catch (e) {
    out.textContent = 'Quote failed: ' + (e.shortMessage ?? e.message) +
      '\nNote: graduated curves (status 3) no longer quote pre-graduation trades; pick an active curve from the launches list.';
  }
}

// ---------------------------------------------------------------- wiring
$('connectBtn').addEventListener('click', connectWallet);
$('refreshNet').addEventListener('click', loadNetwork);
$('refreshLaunches').addEventListener('click', loadLaunches);
$('planBtn').addEventListener('click', generatePlan);
$('sendPlanBtn').addEventListener('click', sendPlanStep);
$('quoteBtn').addEventListener('click', runQuote);
if (window.ethereum?.on) {
  window.ethereum.on('accountsChanged', () => location.reload());
  window.ethereum.on('chainChanged', () => location.reload());
}
loadNetwork();
loadConfigs();
loadLaunches();
setInterval(loadNetwork, 30000);
