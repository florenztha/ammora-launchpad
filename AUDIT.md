# Audit Report — Florenz Launchpad (pre-submission)

- **Date:** 2026-11-23
- **Site:** https://florenztha.github.io/ammora-launchpad/
- **Repo:** florenztha/ammora-launchpad
- **Scope:** (A) the reported bug "wallet connect only works with OKX, never MetaMask",
  root-caused and fixed; (B) a full audit of every system and feature before any
  submission. Nothing was posted to X and nothing was submitted to ammora.org.
- **Live evidence:** `evidence/audit-live.mjs` / `evidence/audit-live-output.txt`
  (chain reads at blocks 42,063,232–42,063,266), `evidence/wallet-sim-test.mjs` /
  `evidence/wallet-sim-switch.txt` / `evidence/wallet-sim-add.txt` (headless wallet
  simulation against the built bundle).

Status key: **WORKS** · **FIXED** (defect found and fixed in this audit) ·
**BLOCKED-BY-PROTOCOL** (Ammora-side gate, site presents it honestly) ·
**NEEDS-BROWSER-TEST** (code verified as far as headless allows; final proof needs
the user's real browser).

---

## 1. The MetaMask bug: root cause and fix

**Symptom.** With MetaMask and OKX Wallet both installed, Connect Wallet only ever
opened OKX. MetaMask could not be connected at all.

**Root cause.** The old `connectWallet()` in `src/main.js` used the legacy
`window.ethereum` object for *everything*: `eth_requestAccounts`, `eth_chainId`,
`wallet_switchEthereumChain`, `wallet_addEthereumChain`, the viem wallet-client
transport (`custom(window.ethereum)`), and the `accountsChanged` / `chainChanged`
listeners. When several wallets are installed, `window.ethereum` belongs to
whichever wallet claimed it — and OKX Wallet claims it, while MetaMask is then
only addressable through its EIP-6963 announcement. Every request therefore went
to OKX *by construction*; MetaMask was never contacted.

**Proof, not just theory.** The pre-fix bundle was run in a simulated browser
with OKX owning `window.ethereum` and MetaMask present only as an EIP-6963
announcement (the user's exact setup). Clicking Connect sent
`eth_requestAccounts`, `eth_chainId` and `wallet_switchEthereumChain` to OKX,
**zero** requests to MetaMask, and the button showed "Connected" — to OKX.

**Ruled out.** The chain payload was never the problem, because it was never
delivered to MetaMask at all. For the record: 91342 = `0x164CE`; the old code's
lowercase `'0x164ce'` is valid (JSON-RPC hex is case-insensitive), and the
add-chain payload was complete (chainName, `nativeCurrency` ETH/18, `rpcUrls`,
`blockExplorerUrls`). The code now uses the canonical `0x164CE` anyway.

**Fix (commit `00acb449`).**
- EIP-6963 discovery: an `eip6963:announceProvider` listener plus
  `eip6963:requestProvider` dispatches (at load and on every Connect click).
- Providers identified by `info.rdns` (`io.metamask` → MetaMask,
  `com.okex.wallet` → OKX Wallet), with provider-flag fallbacks.
- A wallet picker appears when more than one wallet is installed; with exactly
  one, it connects directly. Legacy fallback (`window.okxwallet`, then
  `window.ethereum`) is used only when no wallet announces itself.
- **All** wallet interactions go through the selected provider: account request,
  chain switch/add, the viem wallet client (`custom(selectedProvider)`), and the
  `accountsChanged` / `chainChanged` listeners (previously bound to
  `window.ethereum` and handled by full page reload; now handled in place).
- Added the previously missing **disconnect**: clears local session state and
  makes a best-effort `wallet_revokePermissions` call.

**Verification.** `evidence/wallet-sim-test.mjs` loads the *built* bundle under
the exact bug condition and drives the real UI flow. Scenario "switch" (chain
switch succeeds): **11/11 checks pass**. Scenario "add" (switch throws 4902):
**16/16 checks pass**, including: picker offers both wallets, no wallet is
contacted before the user picks, OKX receives **zero** requests, MetaMask
receives the account request, the add-chain payload is exactly
`chainId 0x164CE`, chainName "GIWA Sepolia", `nativeCurrency {Ether, ETH, 18}`,
`rpcUrls [https://sepolia-rpc.giwa.io]`,
`blockExplorerUrls [https://sepolia-explorer.giwa.io]`, the header shows
"MetaMask · 0x… · balance ETH" (real balance read), and disconnect restores the
initial state. The final click-test in the user's real MetaMask is still
required — see section 4.

---

## 2. Feature audit

| # | Feature | Status | Evidence (audit run, 2026-11-23) |
|---|---------|--------|-----------------------------------|
| 1 | Network panel | **WORKS** | chainId 91342; block advanced 42,063,232 → 42,063,239 in 7 s (the panel auto-refreshes every 30 s and on Refresh); bytecode present at factory, config registry, first-buy executor, native router, execution registry, token-lock factory and WETH; catalog slot `v4-auto-route-20260917`, protocol V4, `nextConfigId` 82. All rows are SDK catalog values plus live reads. |
| 2 | Latest launches | **WORKS** | The site's scan algorithm, reproduced headlessly, found 6 launches in the newest chunk; per-curve state read for each (4 Active / status 1, 2 Graduated / status 3); graduated curves render with the Graduated pill; the quote panel is prefilled with the first *active* curve (`0x6B9C77E553b348b193eF3eC15797DD7f1E3EC74e`). Scan respects the RPC's 10,000-block `eth_getLogs` cap using 9,999-block chunks. By design it shows the newest 8 from the most recent non-empty chunk. |
| 3 | Config selection | **WORKS** | Full registry enumeration (ids 1–81) with the site's exact filter (enabled ∧ `migrationBaseThreshold == 0` ∧ id ≠ 6) yields 13 qualified configs: 1, 2, 3, 4, 5, 10, 11, 36, 41, 48, 50, 76, 78. Config 6 is disabled on-chain **and** its hash equals the docs-quarantined hash `0x60489087…667`; it is also hard-excluded by id in code (defense in depth — its `migrationBaseThreshold` is 0, so the threshold test alone would not exclude it). Supply, thresholds and `tokenDecimals` (9 for every qualified config) are read from chain at page load; the only hardcoded config value is the quarantined id from the Ammora docs readiness notice. |
| 4 | Create Launch | **WORKS** (plan path) · **NEEDS-BROWSER-TEST** (send path) | Form validation reviewed: name/symbol required, first buy must parse and be > 0, minimum-out must be a raw integer. Planner reproduced live end-to-end: deployment verified at block 42,063,266; plan for the newest qualified config (78) = `APPROVAL_REQUIRED` with exactly one WETH approval of the first-buy amount to the first-buy executor `0x1a19a3b0e69b33db3a2f9b2487866b4be04dd451`, estimated gas 46,523 — matching the site's plan rendering and its "Send approval → regenerate → Send launch transaction" flow. The send step uses the wallet client bound to the selected provider; wallet-signed sends can only be proven in the browser (section 4, optional step 8). |
| 5 | Quote panel | **BLOCKED-BY-PROTOCOL** (native path) · **WORKS** (fallback) | Native buy and native sell via `AmmoraSwapClient.prepareExactIn` both still fail today with `AMMORA_SDK_UNVERIFIED_DEPLOYMENT` ("the selected Factory or pool is not enabled by the reviewed native execution registry") on the active curve — the gate is Ammora's operator-side registry, not site code. The panel shows that error verbatim with an explanation and never silently falls back. The clearly labeled protocol-denominated fallback quote works in both directions (buy 0.01 → `amountOut 1008064516144899`, fee `5050505050506`; sell likewise), and a graduated curve's `quoteExactInput` reverts (error `0x48e8f5d8`), which the panel explains. Amount parsing verified: ETH at 18 decimals; base-token amounts use decimals read from chain (9). |
| 6 | Wallet | **FIXED** · **NEEDS-BROWSER-TEST** | See section 1. Connect/disconnect, picker, per-provider client, in-place account/chain change handling; ETH balance in the header and WETH balance inside the Create panel are read for the connected account (simulation showed the test account's real 47.33 ETH in the header). Real-extension behavior still needs the manual test in section 4. |
| 7 | Content accuracy | **WORKS** (2 fixes applied) | Every label re-checked against protocol facts: the SDK 0.3.9 first-buy WETH limitation note (catalog `quoteAsset` = WETH, `nativeAsset.kind` = `WRAPPED_ERC20`, planner has no native variant — accurate); testnet badge and chain 91342 (accurate); config option wording "graduation threshold … (protocol quote asset)" (accurate — every config's `quoteToken` on this registry is WETH); "Curve quote asset (protocol-internal)" row (accurate). Fixes in this audit: (a) the quote-panel intro implied native routing simply works — it now states native routing applies to Ammora-registered curves and unregistered curves fail closed; (b) the README said GitHub Pages "requires enabling once" — Pages is live; corrected, and the README now documents the EIP-6963 wallet behavior. |
| 8 | Build / deploy hygiene | **WORKS** | `npm run build` clean; after build, `docs/` and `dist/` are byte-identical and `docs/index.html` matches `index.html`. Baseline: before this audit the live Pages bundle was byte-identical to the repo's `docs/bundle.js`. After the fix pushes, the Pages run for the new HEAD completed successfully and the live bundle is byte-identical to the new `docs/bundle.js` (md5 `ff34bb4108ac2c5b982f5ccc050ac1e4`, 1,787,219 bytes); the live index contains the wallet picker and the corrected quote wording. Secret scan of all tracked text files: no tokens, private keys, mnemonics or credential surrogates, and no key-like 64-hex strings in src/HTML/README (config hashes in evidence outputs are public on-chain data). No keys exist in this project by design — all sends happen in the visitor's own wallet. |

**Counts (8 areas):** WORKS 4 (1, 2, 3, 8) · WORKS after fixes 1 (7) ·
FIXED in code, final proof in browser 1 (6) · mixed WORKS / BLOCKED-BY-PROTOCOL 1
(5) · plan path WORKS, send path NEEDS-BROWSER-TEST 1 (4).

---

## 3. Changes shipped in this audit

| Commit | File(s) | Change |
|--------|---------|--------|
| `00acb449` | `src/main.js` | EIP-6963 discovery + picker + selected-provider wallet client + disconnect + in-place change events; canonical `0x164CE` |
| `716d5634` | `index.html` | Wallet picker container/styles; quote intro wording correction |
| `650e3340`, `96d776e9` | `docs/` | Rebuilt site |
| `14cbf7cb` | `README.md` | EIP-6963 wallet documentation; Pages-live correction; audit pointers |
| `42c59198` … `bf83ead2` | `evidence/` | `audit-live` script + output; wallet simulation test + both scenario outputs |

## 4. Manual browser test steps (do these before submitting anywhere)

**MetaMask connect test — the critical one:**

1. In Chrome with **both** MetaMask and OKX Wallet installed and enabled, open
   https://florenztha.github.io/ammora-launchpad/ and hard-refresh
   (Ctrl+Shift+R) so the new bundle loads.
2. Click **Connect Wallet**. Expected: a "Choose a wallet:" row appears with
   **MetaMask** and **OKX Wallet** buttons. (If a wallet is missing, check that
   its extension is enabled; the site can only offer wallets that announce
   themselves.)
3. Click **MetaMask**. Expected: the connection prompt opens in **MetaMask**,
   not OKX. Approve it.
4. If MetaMask is on another network, approve the switch to GIWA Sepolia; if
   the chain is unknown, approve the add-network prompt (GIWA Sepolia, chain ID
   91342, RPC `https://sepolia-rpc.giwa.io`, ETH).
5. Expected result: the header shows "MetaMask · 0x… · \<balance\> ETH", the
   button becomes **Disconnect**, and **Generate plan** is enabled.
6. Click **Disconnect**: the header clears and the button returns to
   **Connect Wallet** (MetaMask may show a permission-revoke confirmation).
7. Repeat steps 2–5 choosing **OKX Wallet**, to confirm the picker also routes
   OKX correctly.
8. *Optional, testnet only (needs a little GIWA Sepolia ETH + WETH in the
   wallet):* in "Create a launch", Generate plan → expect an
   `APPROVAL_REQUIRED` plan naming a WETH approval → Send approval → regenerate
   → Send launch transaction → rescan launches and confirm the new token
   appears. Then open the quote panel on the prefilled active curve: expect
   the native-ETH section to report the registry error (protocol-side) and the
   labeled protocol reference quote to return numbers.

## 5. Known limitations (unchanged by this audit)

- Native-ETH trading is gated by Ammora's execution registry (operator-side,
  timelocked registration). No site change can enable it; the site says so
  instead of faking a WETH trade as a native one.
- The atomic first buy is WETH-only in SDK 0.3.9 by protocol design; the site
  labels it plainly.
- The launches list shows the newest launches from the most recent non-empty
  scan chunk (max 8 displayed).

---

## Addendum — UI simplification (2026-11-23, after the audit above)

At the site owner's request, the presentation layer was rebuilt for
non-technical visitors. This changed **only** the UI; every audited mechanism
in sections 1–5 is unchanged underneath and was re-verified after the rebuild:

- **New main flow:** header with one compact status line (network + live
  block); a **Create Token** card (name, symbol, total supply, first buy, one
  button) that auto-selects the qualified Config (closest total supply on a
  log scale; Config 78, the evidence-proven config, wins ties and is the
  default), then chains planner → approval (only if the plan requires it) →
  launch send as one plain-language progress sequence; and a **Buy / Sell**
  card (clickable token list, one amount, both-direction estimates shown
  before acting, native execution when the curve is registered, otherwise the
  curve-quote estimate plus a plain sentence that trading settles in WETH for
  that token). Main-flow errors are plain language; raw protocol errors are
  logged in Advanced.
- **Moved, not deleted:** the full deployment catalog, config list with
  parameters, raw planner (Generate plan / Send plan step), raw curve quote
  panel and a new raw-error log now live in a collapsed **Advanced** section,
  closed by default, running the identical code paths.
- **Re-verification after the rebuild:** `evidence/wallet-sim-test.mjs`
  passes unchanged against the new bundle (switch 11/11, add 16/16, outputs
  refreshed in `evidence/wallet-sim-switch.txt` / `wallet-sim-add.txt`);
  `evidence/verify-read.mjs` and `evidence/audit-live.mjs` re-run clean
  against the live chain (qualified config list unchanged, Config 78 still
  qualified, planner still returns the same `APPROVAL_REQUIRED` plan shape,
  native buy/sell still registry-blocked exactly as documented in section 5).
- The manual browser test steps in section 4 still apply; in the simple flow,
  step 8's launch can equivalently be run from the Create Token card with a
  single button.

---

## Addendum — WETH Buy/Sell enabled (2026-11-23, after the UI simplification)

A follow-up verification narrowed one conclusion of section 5. The native-ETH
path is still registry-blocked, exactly as documented there. But the block is
narrower than the audit assumed: in SDK 0.3.9 the deployment-registry check
runs only for `native` assets. With `inputAsset`/`outputAsset` set to
`erc20`, `AmmoraSwapClient.prepareExactIn` skips the registry and prepares a
`swapExactInput` transaction directly against the token's own curve contract,
with an exact-amount ERC-20 approval per trade (buy: WETH to the curve; sell:
the base token to the curve) and transaction value 0.

Evidence: `evidence/verify-weth-path.mjs` and
`evidence/verify-weth-path-decode.mjs` (output in
`evidence/verify-weth-path-output.txt`). Keyless prepare plus `eth_call`
simulations with balance/allowance state overrides matched the SDK quotes
exactly, in both directions, on the site's ZENT curve and on a second live
curve; control runs without the overrides reverted, as expected. Two real
third-party trades on the same path (2026-11-21) were also confirmed via RPC.

Change made: the simple Buy / Sell card now prepares trades with `erc20`
assets, so its Buy and Sell buttons execute real WETH trades through the
visitor's own wallet (one exact-amount approval, then the swap; the result
message links the transaction on the explorer). The card states plainly that
trades run in WETH, that a WETH balance is needed, and that ETH only pays
gas. It does not claim ETH trading. Curve-quote estimates remain as the
fallback if a prepare ever fails, with the buttons off in that case.
Graduated tokens stay non-tradable. The Advanced native quote panel is
unchanged and still reports the registry block, which remains true for the
native path.

Re-verification after the change: `evidence/wallet-sim-test.mjs` still
passes in full against the new bundle (switch 11/11, add 16/16);
`evidence/verify-weth-ui-drycheck.mjs` mirrors the card's exact prepare call
keylessly and asserts the prepared transaction targets the curve with value
0 and exact-amount, curve-as-spender approvals (all checks passed);
`evidence/live-check-trade.mjs` loads the built bundle and confirms the card
renders the ZENT token with live prepared WETH quotes in both directions.
