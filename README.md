# Florenz Launchpad

A static token launchpad built with the **Ammora SDK** (`@ammora-protocol/sdk@0.3.9`) on the
**GIWA Sepolia testnet** (chain 91342). Built for the Ammora Builder mission
("Ship an exchange or launchpad with the Ammora SDK").

**Live site:** https://florenztha.github.io/ammora-launchpad/
(requires GitHub Pages to be enabled once: Settings → Pages → deploy from branch `main`, folder `/docs`)

## What it does

- **Live network panel (no wallet needed):** chain id, latest block and the Ammora V4
  auto-route deployment catalog (launch factory, config registry, first-buy executor,
  WETH, token-lock factory), read through the SDK plus a viem public client.
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
- **Curve quote:** read-only exact-input quotes via `AmmoraV4LaunchCurveClient.quoteExactInput`.

No private keys exist anywhere in this project. All sends happen in the visitor's own
browser wallet on testnet.

## Layout

- `index.html`, `src/main.js` — the site source
- `docs/` — the built site (esbuild bundle), served by GitHub Pages
- `evidence/` — keyless verification script and its live output
  (`verify-read.mjs` / `verify-read-output.txt`): catalog values, live block, registry
  enumeration with readiness filtering, a real launch + curve quote, and a full
  planner-generated `APPROVAL_REQUIRED` plan, all read from the live chain

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
