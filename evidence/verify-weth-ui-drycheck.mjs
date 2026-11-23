// Prepare-only dry check for the site's WETH Buy/Sell wiring (no wallet).
// Mirrors src/main.js computeTradeSide exactly: same swap client, same
// AmmoraV4LaunchCurveClient instance, pool passed as curveClient.curve,
// 'erc20' assets, payer = curve creator (the site's keyless reference payer).
// Asserts the prepared transaction targets the curve with value 0 and that
// approval requirements are the exact-amount, curve-as-spender ones.
import {
  AmmoraSwapClient,
  AmmoraV4LaunchCurveClient,
  giwaSepoliaAutoRouteDeployment,
  giwaSepoliaAtomicLaunchDeployment,
} from '@ammora-protocol/sdk';
import { createPublicClient, http, defineChain, parseEther, parseUnits, formatEther, formatUnits, erc20Abi } from 'viem';

const giwaSepolia = defineChain({
  id: 91342,
  name: 'GIWA Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: ['https://sepolia-rpc.giwa.io'] } },
  blockExplorers: { default: { name: 'GIWA Explorer', url: 'https://sepolia-explorer.giwa.io' } },
  testnet: true,
});
const publicClient = createPublicClient({ chain: giwaSepolia, transport: http('https://sepolia-rpc.giwa.io', { timeout: 60_000, retryCount: 3, retryDelay: 1200 }) });

const deployment = giwaSepoliaAutoRouteDeployment;
const WETH = deployment.contracts.tokens.wrappedNative;
const CORE = {
  launchFactory: giwaSepoliaAtomicLaunchDeployment.contracts.launchFactory,
  feePolicy: giwaSepoliaAtomicLaunchDeployment.contracts.feePolicy,
};
// The ZENT curve the site lists (LaunchCreated, config 82, status 1 at last check).
const CURVE = '0xB00bAABd05Fc794b833e76B2E733ABd38Cb7C985';

const block = await publicClient.getBlockNumber();
console.log('Live block:', block.toString());

const curve = new AmmoraV4LaunchCurveClient(publicClient, CURVE, CORE);
const state = await curve.getState();
const baseDecimals = await publicClient.readContract({ address: state.baseToken, abi: erc20Abi, functionName: 'decimals' });
const symbol = await publicClient.readContract({ address: state.baseToken, abi: erc20Abi, functionName: 'symbol' }).catch(() => '?');
console.log('Curve state:', { status: state.status, baseToken: state.baseToken, symbol, baseDecimals, configId: String(state.configId) });
if (state.status !== 1) throw new Error('curve is not active (status 1)');

const swaps = await AmmoraSwapClient.create(publicClient, {
  deploymentCatalog: { [deployment.chain.id]: deployment },
});
const payer = state.creator; // keyless reference payer, exactly as the site does without a wallet

let failures = 0;
const check = (name, ok, extra = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${extra ? ' — ' + extra : ''}`); if (!ok) failures++; };

// ---- BUY: 0.01 WETH in, erc20 input asset (same amount the card defaults to)
const buyAmount = parseEther('0.01');
const buy = await swaps.prepareExactIn({
  model: 'dbc', pool: curve.curve, tokenIn: WETH, inputAsset: 'erc20',
  amountIn: buyAmount, payer, recipient: payer, slippageBps: 100,
});
check('buy prepareExactIn (erc20) returned a transaction', !!buy?.transaction);
check('buy transaction targets the curve contract', buy.transaction.to.toLowerCase() === CURVE.toLowerCase(), buy.transaction.to);
check('buy transaction value is 0', (buy.transaction.value ?? 0n) === 0n, String(buy.transaction.value ?? 0n));
check('buy quote is denominated out in the base token', buy.quote.tokenOut?.toLowerCase() === state.baseToken.toLowerCase(), `${formatUnits(buy.quote.expectedAmountOut, baseDecimals)} ${symbol}`);
const buyAppr = buy.approvalRequirements ?? [];
check('buy has exactly one approval requirement', buyAppr.length === 1, JSON.stringify(buyAppr, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
if (buyAppr.length === 1) {
  check('buy approval token is WETH', buyAppr[0].token.toLowerCase() === WETH.toLowerCase(), buyAppr[0].token);
  check('buy approval spender is the curve', buyAppr[0].spender.toLowerCase() === CURVE.toLowerCase(), buyAppr[0].spender);
  check('buy approval amount is the exact trade amount', buyAppr[0].amount === buyAmount, buyAppr[0].amount.toString());
}

// ---- SELL: 0.01 base tokens in, erc20 output asset (same input field, read as tokens)
const sellAmount = parseUnits('0.01', baseDecimals);
const sell = await swaps.prepareExactIn({
  model: 'dbc', pool: curve.curve, tokenIn: state.baseToken, outputAsset: 'erc20',
  amountIn: sellAmount, payer, recipient: payer, slippageBps: 100,
});
check('sell prepareExactIn (erc20) returned a transaction', !!sell?.transaction);
check('sell transaction targets the curve contract', sell.transaction.to.toLowerCase() === CURVE.toLowerCase(), sell.transaction.to);
check('sell transaction value is 0', (sell.transaction.value ?? 0n) === 0n, String(sell.transaction.value ?? 0n));
check('sell quote pays out in WETH', sell.quote.tokenOut?.toLowerCase() === WETH.toLowerCase(), `${formatEther(sell.quote.expectedAmountOut)} WETH`);
const sellAppr = sell.approvalRequirements ?? [];
check('sell has exactly one approval requirement', sellAppr.length === 1, JSON.stringify(sellAppr, (k, v) => (typeof v === 'bigint' ? v.toString() : v)));
if (sellAppr.length === 1) {
  check('sell approval token is the base token', sellAppr[0].token.toLowerCase() === state.baseToken.toLowerCase(), sellAppr[0].token);
  check('sell approval spender is the curve', sellAppr[0].spender.toLowerCase() === CURVE.toLowerCase(), sellAppr[0].spender);
  check('sell approval amount is the exact trade amount', sellAppr[0].amount === sellAmount, sellAppr[0].amount.toString());
}

console.log(failures ? `\nDRY CHECK: ${failures} failure(s)` : '\nDRY CHECK: all checks passed');
process.exit(failures ? 1 : 0);
