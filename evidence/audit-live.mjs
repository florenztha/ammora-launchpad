// Full feature audit against live GIWA Sepolia for the Florenz Launchpad site.
// Keyless reads and unsigned plan generation only: no keys, no signing, no sending.
// Mirrors the exact code paths used by src/main.js so results transfer to the site.
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
import { createPublicClient, http, defineChain, parseEther, formatEther, formatUnits, erc20Abi } from 'viem';

const big = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
const out = (label, value) => console.log(label, typeof value === 'object' ? JSON.stringify(value, big, 1) : value);
const section = (t) => console.log('\n=== ' + t + ' ===');

const RPC_URL = 'https://sepolia-rpc.giwa.io';
const deployment = giwaSepoliaAutoRouteDeployment;
const REGISTRY = deployment.contracts.launch.configRegistry;
const FACTORY = deployment.contracts.launch.factory;
const WETH = deployment.contracts.tokens.wrappedNative;
const NATIVE_ROUTER = deployment.contracts.routers.native;
const EXEC_REGISTRY = deployment.contracts.routers.executionRegistry;
const FIRST_BUY_EXECUTOR = deployment.contracts.launch.firstBuyExecutor;
const CORE = {
  launchFactory: giwaSepoliaAtomicLaunchDeployment.contracts.launchFactory,
  feePolicy: giwaSepoliaAtomicLaunchDeployment.contracts.feePolicy,
};
const QUARANTINED_ID = 6n;
const QUARANTINED_HASH = '0x6048908774397e0691bb0e19f72dabb790eb0d892d6081d3622b39e7f738e667';

const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: 'https://sepolia-explorer.giwa.io' } },
  testnet: true,
});
const client = createPublicClient({ chain: giwaSepolia, transport: http(RPC_URL, { timeout: 60_000, retryCount: 3, retryDelay: 1200 }) });

// ------------------------------------------------------------------ 1. network panel
section('1. NETWORK PANEL');
const chainId = await client.getChainId();
out('chainId (expect 91342):', chainId);
const blockA = await client.getBlock();
out('block A:', blockA.number);
await new Promise((r) => setTimeout(r, 7000));
const blockB = await client.getBlock();
out('block B (7s later, auto-refresh source advances):', blockB.number);
out('block advanced:', blockB.number > blockA.number);
for (const [label, addr] of [
  ['factory', FACTORY], ['configRegistry', REGISTRY], ['firstBuyExecutor', FIRST_BUY_EXECUTOR],
  ['nativeRouter', NATIVE_ROUTER], ['executionRegistry', EXEC_REGISTRY],
  ['tokenLockFactory', giwaSepoliaTokenLockDeployment.factory],
  ['curveQuoteAsset/WETH', WETH],
]) {
  const code = await client.getCode({ address: addr });
  out(`bytecode at ${label} ${addr}:`, !!code && code !== '0x');
}
out('catalog slot:', deployment.slot);
out('catalog protocol version:', deployment.contracts.launch.protocolVersion);
out('atomic nativeAsset.kind (expect WRAPPED_ERC20):', giwaSepoliaAtomicLaunchDeployment.nativeAsset?.kind);
out('atomic quoteAsset.symbol (expect WETH):', giwaSepoliaAtomicLaunchDeployment.quoteAsset?.symbol);
const nextId = await client.readContract({ address: REGISTRY, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'nextConfigId' });
out('registry nextConfigId:', nextId);

// ------------------------------------------------------------------ 3. config selection (before launches: feeds audit of filter logic)
section('3. CONFIG SELECTION');
const qualified = [];
let cfg6 = null;
for (let id = 1n; id < nextId && id <= 200n; id++) {
  try {
    const [enabled, hash, cfg] = await Promise.all([
      client.readContract({ address: REGISTRY, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'enabled', args: [id] }),
      client.readContract({ address: REGISTRY, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'configHash', args: [id] }),
      client.readContract({ address: REGISTRY, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'get', args: [id] }),
    ]);
    if (id === QUARANTINED_ID) cfg6 = { enabled, hash, migrationBaseThreshold: cfg.migrationBaseThreshold };
    // Same filter as src/main.js loadConfigs():
    if (enabled && cfg.migrationBaseThreshold === 0n && id !== QUARANTINED_ID) qualified.push({ id, hash, cfg });
  } catch (e) { out(`config ${id} read failed:`, e.shortMessage ?? e.message); }
}
out('qualified configs (site filter: enabled && migrationBaseThreshold==0 && id!=6):', qualified.map((q) => q.id));
out('config 6 enabled:', cfg6?.enabled);
out('config 6 hash matches docs-quarantined hash:', cfg6?.hash?.toLowerCase() === QUARANTINED_HASH);
out('config 6 migrationBaseThreshold:', cfg6?.migrationBaseThreshold);
out('all qualified tokenDecimals (from chain):', [...new Set(qualified.map((q) => q.cfg.tokenDecimals))]);
out('all qualified quoteToken == WETH:', qualified.every((q) => q.cfg.quoteToken.toLowerCase() === WETH.toLowerCase()));

// ------------------------------------------------------------------ 2. latest launches
section('2. LATEST LAUNCHES');
const latest = await client.getBlockNumber();
const event = ammoraLaunchFactoryV4Abi.find((x) => x.type === 'event' && x.name === 'LaunchCreated');
const logs = [];
for (let end = latest; end > deployment.startBlock && logs.length < 10; end -= 9999n) {
  const from = end - 9999n < deployment.startBlock ? deployment.startBlock : end - 9999n;
  const chunk = await client.getLogs({ address: FACTORY, event, fromBlock: from, toBlock: end });
  logs.unshift(...chunk);
  if (chunk.length) break;
}
out('launches found by site scan algorithm:', logs.length);
const recent = logs.slice(-8).reverse();
let activeCurve = null, activeState = null, graduatedCurve = null;
const creators = [];
for (const log of recent) {
  const a = log.args;
  creators.push(a.creator);
  let status = null;
  try { status = (await new AmmoraV4LaunchCurveClient(client, a.curve, CORE).getState()).status; } catch { /* best effort, mirrors site */ }
  out(`launch token ${a.token} curve ${a.curve} config #${a.configId} block ${log.blockNumber} status:`, status);
  if (status === 1 && !activeCurve) { activeCurve = a.curve; activeState = await new AmmoraV4LaunchCurveClient(client, a.curve, CORE).getState(); }
  if (status === 3 && !graduatedCurve) graduatedCurve = a.curve;
}
if (!graduatedCurve) {
  // Widen the search for any graduated curve among older chunks, for the quote-revert check.
  outer: for (let end = latest; end > deployment.startBlock; end -= 9999n) {
    const from = end - 9999n < deployment.startBlock ? deployment.startBlock : end - 9999n;
    const chunk = await client.getLogs({ address: FACTORY, event, fromBlock: from, toBlock: end });
    for (const l of chunk) {
      try { if ((await new AmmoraV4LaunchCurveClient(client, l.args.curve, CORE).getState()).status === 3) { graduatedCurve = l.args.curve; break outer; } } catch { /* skip */ }
    }
    if (end <= deployment.startBlock + 9999n) break;
  }
}
out('first active curve (site prefills quote panel with it):', activeCurve);
out('a graduated curve found:', graduatedCurve);

// ------------------------------------------------------------------ 5. quote panel
section('5. QUOTE PANEL');
if (activeCurve) {
  const curve = new AmmoraV4LaunchCurveClient(client, activeCurve, CORE);
  const baseDecimals = await client.readContract({ address: activeState.baseToken, abi: erc20Abi, functionName: 'decimals' });
  out('active curve base token decimals (read from chain):', baseDecimals);
  out('active curve state:', { status: activeState.status, configId: activeState.configId, feeBps: activeState.currentFeeBps, quoteToken: activeState.quoteToken });
  const swaps = await AmmoraSwapClient.create(client, { deploymentCatalog: { [deployment.chain.id]: deployment } });
  const payer = activeState.creator;
  try {
    await swaps.prepareExactIn({ model: 'dbc', pool: activeCurve, tokenIn: WETH, inputAsset: 'native', amountIn: parseEther('0.01'), payer, recipient: payer, slippageBps: 100 });
    out('native BUY prepareExactIn:', 'SUCCEEDED (registry gate no longer blocking)');
  } catch (e) { out('native BUY prepareExactIn failed as site would show:', (e.shortMessage ?? e.message)); }
  try {
    await swaps.prepareExactIn({ model: 'dbc', pool: activeCurve, tokenIn: activeState.baseToken, outputAsset: 'native', amountIn: 1000000n, payer, recipient: payer, slippageBps: 100 });
    out('native SELL prepareExactIn:', 'SUCCEEDED (registry gate no longer blocking)');
  } catch (e) { out('native SELL prepareExactIn failed as site would show:', (e.shortMessage ?? e.message)); }
  try {
    const q = await curve.quoteExactInput(parseEther('0.01'), false);
    out('fallback quoteExactInput BUY 0.01 (quote-asset in):', { amountOut: q.amountOut, fee: q.fee, amountLeft: q.amountLeft, asOfBlock: q.asOfBlock });
  } catch (e) { out('fallback BUY quote failed:', e.shortMessage ?? e.message); }
  try {
    const q = await curve.quoteExactInput(1000000n, true);
    out('fallback quoteExactInput SELL 1000000 raw base in:', { amountOut: q.amountOut, fee: q.fee, amountLeft: q.amountLeft, asOfBlock: q.asOfBlock });
  } catch (e) { out('fallback SELL quote failed:', e.shortMessage ?? e.message); }
} else out('quote checks skipped:', 'no active curve in recent launches');
if (graduatedCurve) {
  try {
    const q = await new AmmoraV4LaunchCurveClient(client, graduatedCurve, CORE).quoteExactInput(parseEther('0.01'), false);
    out('graduated curve quoteExactInput:', { unexpectedSuccess: true, amountOut: q.amountOut });
  } catch (e) { out('graduated curve quoteExactInput reverts (site explains this case):', e.shortMessage ?? e.message); }
} else out('graduated curve check:', 'none found in scanned range');

// ------------------------------------------------------------------ 4. create launch planning
section('4. CREATE LAUNCH (planner, unsigned)');
const target = qualified[qualified.length - 1];
if (target) {
  out('planner target (newest qualified, as site preselects):', { id: target.id, tokenDecimals: target.cfg.tokenDecimals });
  const block = await client.getBlock();
  const context = await verifyAmmoraPortableDeploymentAtBlock(client, giwaSepoliaAtomicLaunchDeployment, block.number);
  out('deployment verified at block:', context.blockNumber);
  const planner = new AmmoraPortableLifecyclePlanner(context, giwaSepoliaAtomicLaunchTargets);
  const probeAccounts = [...new Set(creators.filter(Boolean))];
  const amounts = [parseEther('0.01'), parseEther('0.001'), parseEther('0.0001'), parseEther('0.00001')];
  let plan = null, lastErr = null;
  outer: for (const probeAccount of probeAccounts) {
    for (const amt of amounts) {
      try {
        plan = await planner.planExistingConfigAtomicFirstBuy({
          account: probeAccount, configId: target.id, expectedConfigHash: target.hash,
          launch: { name: 'Audit Probe', symbol: 'AUDIT', metadataURI: '', creatorMetadataURI: '', tokenDecimals: target.cfg.tokenDecimals },
          firstBuys: [{ includedQuoteAmountRaw: amt, minimumBaseAmountOutRaw: 1n, allowPartialFill: false, recipient: probeAccount }],
          deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
          gas: { maxFeePerGasNativeRaw: (block.baseFeePerGas ?? 1000000000n) * 3n, safetyMarginBps: 2000n },
        });
        out('plan probe succeeded:', { probeAccount, amt: formatEther(amt) });
        break outer;
      } catch (e) { lastErr = e; }
    }
  }
  if (plan) {
    out('plan:', {
      status: plan.status, operation: plan.operation, transactionKind: plan.transactionKind,
      configId: plan.configId, totalQuoteAmountRaw: plan.totalQuoteAmountRaw,
      totalQuoteFormatted: formatEther(plan.totalQuoteAmountRaw ?? 0n),
      estimatedGasUnits: plan.estimatedGasUnits, txTo: plan.transaction?.to,
      approvalRequirements: plan.approvalRequirements,
    });
    out('approval token is WETH:', plan.approvalRequirements?.every((r) => r.token.toLowerCase() === WETH.toLowerCase()));
    out('approval spender is first-buy executor:', plan.approvalRequirements?.every((r) => r.spender.toLowerCase() === FIRST_BUY_EXECUTOR.toLowerCase()));
  } else out('planner attempt failed:', lastErr?.shortMessage ?? lastErr?.message);
} else out('planner check skipped:', 'no qualified config');

// ------------------------------------------------------------------ 6. wallet static checks (headless-verifiable part)
section('6. WALLET (static, headless-verifiable part)');
out('chain id decimal:', 91342);
out('chain id hex used by wallet_addEthereumChain payload:', '0x' + (91342).toString(16).toUpperCase());
try {
  const idHex = await client.transport.request({ method: 'eth_chainId' });
  out('RPC eth_chainId:', idHex);
} catch (e) { out('RPC eth_chainId failed:', e.shortMessage ?? e.message); }
console.log('\nDONE');
