// Keyless verification of the Ammora SDK integration against live GIWA Sepolia.
// Reads only: no keys, no signing, no sending.
import {
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaTokenLockDeployment,
  giwaSepoliaAtomicLaunchDeployment,
  giwaSepoliaAtomicLaunchTargets,
  ammoraLaunchConfigRegistryV4Abi,
  ammoraLaunchFactoryV4Abi,
  ALCClient,
  AmmoraV4LaunchCurveClient,
  verifyAmmoraPortableDeploymentAtBlock,
  AmmoraPortableLifecyclePlanner,
} from '@ammora-protocol/sdk';
import { createPublicClient, http, defineChain, parseEther, formatEther } from 'viem';

const big = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
const out = (label, value) => console.log(label, typeof value === 'object' ? JSON.stringify(value, big, 1) : value);

// --- 1. Deployment catalog (SDK quickstart example) ---
const deployment = giwaSepoliaAutoRouteDeployment;
if (deployment.chain.id !== 91342) throw new Error('GIWA Sepolia required');
if (deployment.contracts.launch.protocolVersion !== 4) throw new Error('V4 Launch deployment required');
out('Catalog slot:', deployment.slot);
out('Chain:', deployment.chain.id);
out('Config registry:', deployment.contracts.launch.configRegistry);
out('Launch factory:', deployment.contracts.launch.factory);
out('First buy executor:', deployment.contracts.launch.firstBuyExecutor);
out('Launch protocol version:', deployment.contracts.launch.protocolVersion);
out('Token lock (vesting) factory:', giwaSepoliaTokenLockDeployment.contracts?.factory ?? giwaSepoliaTokenLockDeployment);

// --- 2. Live chain reads through viem public client ---
const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: 'https://sepolia-explorer.giwa.io' } },
  testnet: true,
});
const client = createPublicClient({ chain: giwaSepolia, transport: http('https://sepolia-rpc.giwa.io', { timeout: 60_000, retryCount: 5, retryDelay: 1500 }) });
const chainId = await client.getChainId();
const block = await client.getBlock();
out('Live chain id:', chainId);
out('Latest block:', block.number);
out('Latest block hash:', block.hash);
out('Block base fee (wei):', block.baseFeePerGas);

for (const [label, addr] of [
  ['factory', deployment.contracts.launch.factory],
  ['configRegistry', deployment.contracts.launch.configRegistry],
  ['firstBuyExecutor', deployment.contracts.launch.firstBuyExecutor],
]) {
  const code = await client.getCode({ address: addr });
  out(`Bytecode present at ${label} ${addr}:`, !!code && code !== '0x');
}

// --- 3. Config registry: enumerate templates, apply docs readiness rules ---
const registry = deployment.contracts.launch.configRegistry;
const nextId = await client.readContract({ address: registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'nextConfigId' });
out('Registry nextConfigId:', nextId);
const QUARANTINED_ID = 6n; // Graduation readiness notice: Config 6 on this registry must not be used for new launches.
const qualified = [];
for (let id = 1n; id < nextId && id <= 64n; id++) {
  try {
    const [enabled, hash, cfg] = await Promise.all([
      client.readContract({ address: registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'enabled', args: [id] }),
      client.readContract({ address: registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'configHash', args: [id] }),
      client.readContract({ address: registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'get', args: [id] }),
    ]);
    const row = {
      id: id.toString(),
      enabled,
      configHash: hash,
      quoteToken: cfg.quoteToken,
      totalSupply: cfg.totalSupply,
      migrationQuoteThreshold: cfg.migrationQuoteThreshold,
      migrationBaseThreshold: cfg.migrationBaseThreshold,
      note: id === QUARANTINED_ID ? 'QUARANTINED by docs graduation readiness notice: never use for new launches' : undefined,
    };
    out('Config:', row);
    // Docs readiness rule applied: enabled AND migrationBaseThreshold == 0 AND not the quarantined #6.
    if (enabled && cfg.migrationBaseThreshold === 0n && id !== QUARANTINED_ID) qualified.push({ id, hash, cfg });
  } catch (e) {
    out(`Config ${id} read failed:`, e.shortMessage ?? e.message);
  }
}
out('Qualified template configs (enabled, migrationBaseThreshold=0, not #6):', qualified.map((q) => q.id));

// --- 4. Find a real launched curve from factory events, then quote it via ALCClient ---
// NOTE: this RPC rejects eth_getLogs ranges above 10,000 blocks, so scan in 9,999-block chunks.
const factory = deployment.contracts.launch.factory;
let curve = null;
let launchArgs = null;
let launchLogs = [];
let launchCreators = [];
const latest = block.number;
for (let end = latest; end > deployment.startBlock && !curve; end -= 9999n) {
  const from = end - 9999n < deployment.startBlock ? deployment.startBlock : end - 9999n;
  try {
    const logs = await client.getLogs({ address: factory, event: ammoraLaunchFactoryV4Abi.find((x) => x.type === 'event' && x.name === 'LaunchCreated'), fromBlock: from, toBlock: end });
    if (logs.length) {
      const last = logs[logs.length - 1];
      launchArgs = last.args;
      launchLogs = logs;
      launchCreators = logs.map((l) => l.args?.creator).filter(Boolean);
      curve = last.args.curve ?? null;
      out(`LaunchCreated logs in [${from}, ${end}]:`, logs.length);
      out('Latest LaunchCreated args:', last.args);
      out('LaunchCreated block:', last.blockNumber);
    }
  } catch (e) {
    out(`Log scan [${from}, ${end}] failed:`, e.shortMessage ?? e.message);
    break;
  }
}

if (curve) {
  try {
    const core = {
      launchFactory: giwaSepoliaAtomicLaunchDeployment.contracts.launchFactory,
      feePolicy: giwaSepoliaAtomicLaunchDeployment.contracts.feePolicy,
    };
    const v4curve = new AmmoraV4LaunchCurveClient(client, curve, core);
    const state = await v4curve.getState();
    out('V4 curve state (latest launch):', state);
    // The latest curve may already be graduated (status 3), where pre-graduation quotes
    // revert by design. Scan the other recent launches for an active curve (status 1)
    // and quote that one instead.
    let quoted = false;
    const candidates = [...new Set([curve, ...launchLogs.map((l) => l.args?.curve).filter(Boolean)])];
    for (const cand of candidates) {
      const c = new AmmoraV4LaunchCurveClient(client, cand, core);
      try {
        const s = await c.getState();
        if (s.status !== 1) continue;
        const quote = await c.quoteExactInput(parseEther('0.01'), false);
        out(`V4 curve quote on active curve ${cand}: 0.01 WETH in (quote -> base):`, quote);
        quoted = true;
        break;
      } catch { /* try next candidate */ }
    }
    if (!quoted) out('V4 curve quote:', 'no active (status 1) curve among recent launches right now');
  } catch (e) {
    out('V4 curve read failed:', e.shortMessage ?? e.message);
  }
} else {
  out('ALC quote:', 'no LaunchCreated curve found in scanned range; quote panel will accept a user-supplied curve address');
}

// --- 5. Planning path proof: existing-config atomic first buy plan (unsigned, read-only) ---
// Use the Config that real launches actually used (from the LaunchCreated event) when it is
// qualified; otherwise fall back to the newest qualified template. Token decimals come from
// the on-chain Config itself (GIWA configs use 9), never assumed.
let planTarget = null;
if (launchArgs?.configId != null) {
  try {
    const [enabled, hash, cfg] = await Promise.all([
      client.readContract({ address: registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'enabled', args: [launchArgs.configId] }),
      client.readContract({ address: registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'configHash', args: [launchArgs.configId] }),
      client.readContract({ address: registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'get', args: [launchArgs.configId] }),
    ]);
    out('Config used by latest real launch:', { id: launchArgs.configId, enabled, hash, tokenDecimals: cfg.tokenDecimals, migrationBaseThreshold: cfg.migrationBaseThreshold });
    if (enabled && cfg.migrationBaseThreshold === 0n && launchArgs.configId !== QUARANTINED_ID) planTarget = { id: launchArgs.configId, hash, cfg };
  } catch (e) {
    out('Launch config read failed:', e.shortMessage ?? e.message);
  }
}
if (!planTarget && qualified.length) {
  const q = qualified[qualified.length - 1];
  planTarget = { id: q.id, hash: q.hash, cfg: q.cfg };
}
if (planTarget) {
  try {
    const context = await verifyAmmoraPortableDeploymentAtBlock(client, giwaSepoliaAtomicLaunchDeployment, block.number);
    out('Portable deployment verified at block:', context.blockNumber);
    const planner = new AmmoraPortableLifecyclePlanner(context, giwaSepoliaAtomicLaunchTargets);
    // Try recent real launch creators as read-only probe accounts, shrinking the first buy
    // until one passes the planner's balance validation. Planning never signs or sends.
    const probeAccounts = [...new Set([launchArgs?.creator, ...launchCreators].filter(Boolean))];
    const amounts = [parseEther('0.01'), parseEther('0.001'), parseEther('0.0001'), parseEther('0.00001')];
    let plan = null;
    let lastErr = null;
    outer: for (const probeAccount of probeAccounts) {
      for (const amt of amounts) {
        try {
          plan = await planner.planExistingConfigAtomicFirstBuy({
            account: probeAccount,
            configId: planTarget.id,
            expectedConfigHash: planTarget.hash,
            launch: { name: 'Evidence Probe', symbol: 'PROBE', metadataURI: '', creatorMetadataURI: '', tokenDecimals: planTarget.cfg.tokenDecimals },
            firstBuys: [{ includedQuoteAmountRaw: amt, minimumBaseAmountOutRaw: 1n, allowPartialFill: false, recipient: probeAccount }],
            deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
            gas: { maxFeePerGasNativeRaw: (block.baseFeePerGas ?? 1000000000n) * 3n, safetyMarginBps: 2000n },
          });
          out('Plan probe succeeded with account / first-buy amount:', { probeAccount, amt });
          break outer;
        } catch (e) {
          lastErr = e;
        }
      }
    }
    if (!plan) throw lastErr ?? new Error('no probe produced a plan');
    out('Existing-config atomic first-buy plan:', {
      status: plan.status,
      operation: plan.operation,
      transactionKind: plan.transactionKind,
      configId: plan.configId,
      predictedToken: plan.predictedToken,
      predictedCurve: plan.predictedCurve,
      totalQuoteAmountRaw: plan.totalQuoteAmountRaw,
      estimatedGasUnits: plan.estimatedGasUnits,
      approvalRequirements: plan.approvalRequirements,
      txTo: plan.transaction?.to,
    });
  } catch (e) {
    out('Planner attempt failed (expected if probe account lacks WETH balance/allowance):', e.shortMessage ?? e.message);
  }
}
console.log('DONE');
