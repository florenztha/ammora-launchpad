# Florenz Launchpad

A static token launchpad built with the **Ammora SDK** (`@ammora-protocol/sdk@0.3.9`) on the
**GIWA Sepolia testnet** (chain 91342). Built for the Ammora Builder mission
("Ship an exchange or launchpad with the Ammora SDK").

**Live site:** https://florenztha.github.io/ammora-launchpad/
(requires GitHub Pages to be enabled once: Settings → Pages → deploy from branch `main`, folder `/docs`)

## What it does

- **Live network panel (no wallet needed):** chain id, latest block and the Ammora V4
  auto-route deployment catalog (launch factory, config registry, first-buy executor,
  native router, native execution registry, token-lock factory, and the curves'
  protocol-internal quote asset), read through the SDK plus a viem public client.
- **Latest launches:** scans `LaunchCreated` events of the Ammora V4 LaunchFactory and
  reads each curve's state through the SDK's `AmmoraV4LaunchCurveClient`.
- **Create a launch:** enumerates the on-chain Config registry and offers only *qualified*
  templates — enabled, `migrationBaseThreshold == 0`, and never Config #6, which the Ammora
  graduation readiness notice quarantines for new launches. Plans are generated with the
  SDK's portable lifecycle planner (`planExistingConfigAtomicFirstBuy`) against a
  deployment verified at a confirmed block (`verifyAmmoraPortableDeploymentAtBlock`).
  The planner never signs: an `APPROVAL_REQUIRED` plan is sent as a WETH approval through
  the visitor's wallet, then the plan is regenerated and the `READY` atomic
  create + first-buy transaction is sent the same way.
  **SDK 0.3.9 limitation:** the atomic first buy is the one step that still settles in
  the protocol quote asset (WETH) — the planner has no native-ETH variant and never
  wraps ETH ("ETH funds gas and poolCreationFee; WETH funds the first buy"). The site
  labels this honestly instead of relabelling WETH amounts as ETH. See
  `evidence/verify-native-eth-output.txt` for the live proof.
- **Curve quote (native ETH):** quotes go through the SDK's `AmmoraSwapClient`
  (`prepareExactIn`, model `dbc`) and the deployment's native router: a buy sends
  native GIWA Sepolia ETH as transaction value with no ERC-20 approval, a sell pays
  native ETH back out. The router wraps/unwraps internally; the curve itself custodies
  its quote asset (WETH), so the panel also shows the curve's own reference quote
  (`AmmoraV4LaunchCurveClient.quoteExactInput`) clearly labelled as denominated in
  that protocol-internal asset. Native routing is gated on Ammora registering the
  curve in the native execution registry; for unregistered curves the SDK fails
  closed and the panel says so (verified live in the native evidence run).

No private keys exist anywhere in this project. All sends happen in the visitor's own
browser wallet on testnet.

## Layout

- `index.html`, `src/main.js` — the site source
- `docs/` — the built site (esbuild bundle), served by GitHub Pages
- `evidence/` — keyless verification scripts and their live outputs:
  `verify-read.mjs` / `verify-read-output.txt` (catalog values, live block, registry
  enumeration with readiness filtering, a real launch + curve quote, and a full
  planner-generated `APPROVAL_REQUIRED` plan) and
  `verify-native-eth.mjs` / `verify-native-eth-output.txt` (every native-ETH surface
  of SDK 0.3.9 attempted live: swap-client native buy/sell, aggregation route quotes,
  ALC aggregation quote, and the planner's first-buy plan)

## Develop

```bash
npm ci
npm run build   # bundles src/main.js into docs/ (and dist/)
```

Requires Node 22 or 24. RPC: https://sepolia-rpc.giwa.io (CORS-open, used directly from the browser).

## Notes

- The GIWA RPC caps `eth_getLogs` at 10,000 blocks per call; the launch scan pages backwards
  in 9,999-block chunks.
- Graduated curves (status 3) no longer answer pre-graduation quotes; the quote panel
  explains this when a quote reverts.
- Testnet assets have no value. Nothing here is financial advice.
