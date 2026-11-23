// Native-ETH verification for the Ammora SDK integration on GIWA Sepolia.
// Question: can SDK 0.3.9 quote / plan in native ETH (not WETH) for this site's flows?
// Keyless and read-only: no keys, no signing, no sending. Every native surface the
// SDK exposes for these flows is attempted against the live chain and the verbatim
// outcome is recorded, including the failures.
import {
  AMMORA_NATIVE_TOKEN,
  AmmoraRouteClient,
  AmmoraSwapClient,
  AmmoraV4LaunchCurveClient,
  AmmoraPortableLifecyclePlanner,
  discoverAmmoraPools,
  giwaSepoliaAutoRoute,
  giwaSepoliaAutoRouteCatalog,
  giwaSepoliaAutoRouteDeploymentCatalog,
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaAtomicLaunchDeployment,
  giwaSepoliaAtomicLaunchTargets,
  ammoraLaunchConfigRegistryV4Abi,
  ammoraLaunchFactoryV4Abi,
  ammoraAggregationExecutionRegistryAbi,
  quoteAmmoraAlcAggregationPool,
  verifyAmmoraAlcAggregationPool,
  verifyAmmoraPortableDeploymentAtBlock,
} from '@ammora-protocol/sdk';
import { createPublicClient, http, defineChain, parseEther, formatEther } from 'viem';

const big = (k, v) => (typeof v === 'bigint' ? v.toString() : v);
const out = (label, value) => console.log(label, typeof value === 'object' ? JSON.stringify(value, big, 1) : value);
const errText = (e) => (e.shortMessage ?? e.message) + (e.code ? ` [${e.code}]` : '');

const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: 'https://sepolia-explorer.giwa.io' } },
  testnet: true,
});
const client = createPublicClient({ chain: giwaSepolia, transport: http('https://sepolia-rpc.giwa.io', { timeout: 60_000, retryCount: 5, retryDelay: 1500 }) });

const deployment = giwaSepoliaAutoRouteDeployment;
const WETH = deployment.contracts.tokens.wrappedNative;
const FACTORY = deployment.contracts.launch.factory;
const CORE = {
  launchFactory: giwaSepoliaAtomicLaunchDeployment.contracts.launchFactory,
  feePolicy: giwaSepoliaAtomicLaunchDeployment.contracts.feePolicy,
};

// --- 0. What the SDK catalog itself declares about the assets ---
out('Atomic deployment nativeAsset:', giwaSepoliaAtomicLaunchDeployment.nativeAsset);
out('Atomic deployment quoteAsset:', giwaSepoliaAtomicLaunchDeployment.quoteAsset);
out('Auto-route native router:', deployment.contracts.routers.native);
out('Auto-route execution registry (swap-client preflight):', deployment.contracts.routers.executionRegistry);
out('AMMORA_NATIVE_TOKEN is the SDK native sentinel:', typeof AMMORA_NATIVE_TOKEN === 'string' && AMMORA_NATIVE_TOKEN.length === 42);

const block = await client.getBlock();
out('Live block:', block.number);

// --- 1. Find recent launches and one active curve (status 1) ---
const event = ammoraLaunchFactoryV4Abi.find((x) => x.type === 'event' && x.name === 'LaunchCreated');
let launchLogs = [];
let chunkFrom = 0n;
let chunkTo = 0n;
for (let end = block.number; end > deployment.startBlock && !launchLogs.length; end -= 9999n) {
  const from = end - 9999n < deployment.startBlock ? deployment.startBlock : end - 9999n;
  const logs = await client.getLogs({ address: FACTORY, event, fromBlock: from, toBlock: end });
  if (logs.length) { launchLogs = logs; chunkFrom = from; chunkTo = end; }
}
out('Recent launches found:', launchLogs.map((l) => ({ token: l.args.token, curve: l.args.curve, creator: l.args.creator, configId: l.args.configId })));

let activeCurve = null;
let activeState = null;
for (const l of [...launchLogs].reverse()) {
  try {
    const c = new AmmoraV4LaunchCurveClient(client, l.args.curve, CORE);
    const s = await c.getState();
    if (s.status === 1) { activeCurve = l.args.curve; activeState = s; break; }
  } catch { /* try next */ }
}
if (!activeCurve) { console.log('No active curve among recent launches; native attempts need one. DONE'); process.exit(0); }
out('Active curve used below:', activeCurve);
out('Active curve state (quote token is the curve-internal asset):', {
  status: activeState.status, baseToken: activeState.baseToken, quoteToken: activeState.quoteToken,
  configId: activeState.configId, creator: activeState.creator,
});
const PROBE = activeState.creator;

// --- 2. Baseline: the curve client's own quote (protocol quote asset denomination) ---
try {
  const c = new AmmoraV4LaunchCurveClient(client, activeCurve, CORE);
  const q = await c.quoteExactInput(parseEther('0.01'), false);
  out('BASELINE curve quoteExactInput(0.01, buy): denominated in the curve quote token (WETH for every config on this registry):', q);
} catch (e) {
  out('Baseline curve quote failed:', errText(e));
}

// --- 3. Native attempt A: AmmoraSwapClient, model dbc, inputAsset/outputAsset 'native' ---
try {
  const swaps = await AmmoraSwapClient.create(client, { deploymentCatalog: { [deployment.chain.id]: deployment } });
  try {
    const prepared = await swaps.prepareExactIn({
      model: 'dbc', pool: activeCurve, tokenIn: WETH, inputAsset: 'native',
      amountIn: parseEther('0.01'), payer: PROBE, recipient: PROBE, slippageBps: 100,
    });
    out('A. NATIVE BUY via AmmoraSwapClient SUCCEEDED:', {
      quote: prepared.quote,
      transaction: { to: prepared.transaction.to, value: prepared.transaction.value },
      approvalRequirements: prepared.approvalRequirements,
    });
  } catch (e) {
    out('A. NATIVE BUY via AmmoraSwapClient failed:', errText(e));
  }
  try {
    const preparedSell = await swaps.prepareExactIn({
      model: 'dbc', pool: activeCurve, tokenIn: activeState.baseToken, outputAsset: 'native',
      amountIn: 1000000000000000n, payer: PROBE, recipient: PROBE, slippageBps: 100,
    });
    out('A2. NATIVE SELL via AmmoraSwapClient SUCCEEDED:', {
      quote: preparedSell.quote,
      transaction: { to: preparedSell.transaction.to, value: preparedSell.transaction.value },
      approvalRequirements: preparedSell.approvalRequirements,
    });
  } catch (e) {
    out('A2. NATIVE SELL via AmmoraSwapClient failed:', errText(e));
  }
} catch (e) {
  out('A. AmmoraSwapClient.create failed:', errText(e));
}

// --- 4. Native attempt B: aggregation route client with AMMORA_NATIVE_TOKEN ---
try {
  const aggRegistry = '0xCCa3e38eAa4F00e43599646a75CcA164B97cC4eB'; // aggregation execution registry (docs: giwa-auto-routing.md)
  const [factoryCfg, poolCfg] = await Promise.all([
    client.readContract({ address: aggRegistry, abi: ammoraAggregationExecutionRegistryAbi, functionName: 'factoryConfig', args: [FACTORY] }),
    client.readContract({ address: aggRegistry, abi: ammoraAggregationExecutionRegistryAbi, functionName: 'individualPoolConfig', args: [activeCurve] }),
  ]);
  out('B. Aggregation execution registry factoryConfig(auto-route factory):', factoryCfg);
  out('B. Aggregation execution registry individualPoolConfig(active curve):', poolCfg);

  const pools = await discoverAmmoraPools({
    clients: [client],
    deployment: { ...giwaSepoliaAutoRoute, factories: giwaSepoliaAutoRoute.factories.filter((f) => f.kind === 'dbc') },
    fromBlock: chunkFrom, toBlock: chunkTo, initialWindow: 9999n, maximumWindow: 9999n,
  });
  const routes = await AmmoraRouteClient.create({
    client, routeCatalog: giwaSepoliaAutoRouteCatalog,
    deploymentCatalog: giwaSepoliaAutoRouteDeploymentCatalog,
    aggregationPools: pools, verificationBlock: block.number,
  });
  for (const [label, tokenIn] of [['native ETH (AMMORA_NATIVE_TOKEN)', AMMORA_NATIVE_TOKEN], ['WETH (contrast)', WETH]]) {
    try {
      const quote = await routes.quoteExactIn({ tokenIn, tokenOut: activeState.baseToken, amountIn: parseEther('0.01'), slippageBps: 100, recipient: PROBE });
      out(`B. Route quote with ${label} SUCCEEDED:`, { expectedAmountOut: quote.expectedAmountOut, executionTarget: quote.executionTarget, approvals: quote.approvals });
    } catch (e) {
      out(`B. Route quote with ${label} failed:`, errText(e));
    }
  }
} catch (e) {
  out('B. Route-client attempt failed early:', errText(e));
}

// --- 5. Native attempt C: standalone ALC aggregation quote with the native sentinel ---
try {
  await verifyAmmoraAlcAggregationPool(client, giwaSepoliaAutoRoute, { pool: activeCurve, baseToken: activeState.baseToken, quoteToken: WETH }, block.number);
  console.log('C. verifyAmmoraAlcAggregationPool: OK');
} catch (e) {
  out('C. verifyAmmoraAlcAggregationPool failed:', errText(e));
}
try {
  const q = await quoteAmmoraAlcAggregationPool(client, giwaSepoliaAutoRoute, { pool: activeCurve, baseToken: activeState.baseToken, quoteToken: WETH }, AMMORA_NATIVE_TOKEN, parseEther('0.01'), block.number);
  out('C. ALC aggregation quote with AMMORA_NATIVE_TOKEN SUCCEEDED:', q);
} catch (e) {
  out('C. ALC aggregation quote with AMMORA_NATIVE_TOKEN failed:', errText(e));
}

// --- 6. First buy: the portable planner has no native variant; record what it produces ---
try {
  const registry = deployment.contracts.launch.configRegistry;
  const nextId = await client.readContract({ address: registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'nextConfigId' });
  const qualified = [];
  for (let id = 1n; id < nextId && id <= 200n; id++) {
    try {
      const [enabled, hash, cfg] = await Promise.all([
        client.readContract({ address: registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'enabled', args: [id] }),
        client.readContract({ address: registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'configHash', args: [id] }),
        client.readContract({ address: registry, abi: ammoraLaunchConfigRegistryV4Abi, functionName: 'get', args: [id] }),
      ]);
      if (enabled && cfg.migrationBaseThreshold === 0n && id !== 6n) qualified.push({ id, hash, cfg });
    } catch { /* skip unreadable */ }
  }
  const target = qualified[qualified.length - 1];
  out('D. Planner target config:', target ? { id: target.id, quoteToken: target.cfg.quoteToken, tokenDecimals: target.cfg.tokenDecimals } : null);
  if (target) {
    const context = await verifyAmmoraPortableDeploymentAtBlock(client, giwaSepoliaAtomicLaunchDeployment, block.number);
    const planner = new AmmoraPortableLifecyclePlanner(context, giwaSepoliaAtomicLaunchTargets);
    const probeAccounts = [...new Set(launchLogs.map((l) => l.args.creator).filter(Boolean))];
    const amounts = [parseEther('0.01'), parseEther('0.001'), parseEther('0.0001'), parseEther('0.00001')];
    let plan = null;
    let lastErr = null;
    outer: for (const probeAccount of probeAccounts) {
      for (const amt of amounts) {
        try {
          plan = await planner.planExistingConfigAtomicFirstBuy({
            account: probeAccount,
            configId: target.id,
            expectedConfigHash: target.hash,
            launch: { name: 'Native Evidence Probe', symbol: 'NPROBE', metadataURI: '', creatorMetadataURI: '', tokenDecimals: target.cfg.tokenDecimals },
            firstBuys: [{ includedQuoteAmountRaw: amt, minimumBaseAmountOutRaw: 1n, allowPartialFill: false, recipient: probeAccount }],
            deadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
            gas: { maxFeePerGasNativeRaw: (block.baseFeePerGas ?? 1000000000n) * 3n, safetyMarginBps: 2000n },
          });
          break outer;
        } catch (e) { lastErr = e; }
      }
    }
    if (plan) {
      out('D. planExistingConfigAtomicFirstBuy result (the only first-buy plan the SDK produces):', {
        status: plan.status,
        operation: plan.operation,
        transactionKind: plan.transactionKind,
        totalQuoteAmountRaw: plan.totalQuoteAmountRaw,
        totalFirstBuyFormatted: `${formatEther(plan.totalQuoteAmountRaw)} (quote asset = WETH ${WETH})`,
        approvalRequirements: plan.approvalRequirements,
        approvalTokenIsWETH: plan.approvalRequirements?.every((r) => r.token.toLowerCase() === WETH.toLowerCase()),
        wrapPrerequisites: plan.wrapPrerequisites,
        transactionValue: plan.transaction?.value,
        transactionTo: plan.transaction?.to,
      });
    } else {
      out('D. Planner attempt produced no plan:', lastErr ? errText(lastErr) : 'unknown');
    }
  }
} catch (e) {
  out('D. Planner attempt failed:', errText(e));
}

console.log('VERDICT:');
console.log('- Atomic first buy: WETH-only in SDK 0.3.9 (planner has no native parameter; docs: "WETH funds the first buy", "neither planner wraps automatically").');
console.log('- Direct curve quote: denominated in the curve quote token (WETH on every config of this registry).');
console.log('- SDK native-router / aggregation native paths exist but are gated on Ammora-side execution-registry registrations that are absent for this factory and its curves today (see A/B/C outcomes above).');
console.log('DONE');
