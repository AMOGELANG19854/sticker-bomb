# StickerBomb wallet integration

Vanilla JavaScript, Vite, Reown AppKit 1.8.24, Ethers adapter 1.8.24 and ethers 6.15.0. No React migration. Existing campaign, QR/PDF, maps, placement photos, analytics and localStorage data format are preserved in `public/app.js`.

## Configure and run

1. Run `npm ci`, copy `.env.example` to `.env.local`, and set `VITE_REOWN_PROJECT_ID` to your own public Reown project ID from https://dashboard.reown.com. Do not supply a secret, seed phrase or private key. Add the exact deployed HTTPS origin (and localhost for development) to the Reown project's origin allowlist.
2. Run `npm run dev`. Default network is Sepolia, including production builds. Set `VITE_DEFAULT_CHAIN_ID=1` only to explicitly default connections to mainnet. Both networks remain selectable. Optional RPC variables must contain public browser-safe URLs, not secret API credentials.
3. Run `npm run build:release` before publishing `dist`. This checks the ID format, tests the state machine and builds. It cannot verify project ownership or the Reown allowlist. `npm run build` permits an unconfigured review build whose campaign tools work but whose wallet button reports missing configuration.

This is a static site: VITE_* variables are consumed at build time. Setting only Sites runtime environment variables after the build has no effect. Rebuild after changing configuration. No project ID was available during this implementation, so the saved version is an unconfigured review build and is NOT deployed.

## Behaviour

- AppKit supplies the Connect Wallet and Account modals, WalletConnect QR/deep/universal links, EIP-6963 discovery, legacy EIP-1193 injected wallets and Coinbase connector. The full wallet directory is enabled, including MetaMask, Trust, Rainbow and Coinbase. No custom wallet URL guessing or mandatory browser change.
- SDK initialization happens before the connect click so wallet selection can retain a user gesture. Mobile users approve in their wallet and return to their original Chrome/Safari tab. OS/browser/wallet versions may require a manual return; automatic return is not guaranteed.
- AppKit manages session persistence/reconnection. App code only re-reads accounts/chain on page visibility and bfcache resume. It never automatically repeats a signing or transaction request.
- Header shows status, shortened address and explicit testnet/mainnet label. Network control confirms mainnet before switching and checks the provider's actual chain afterward. Automatic unsupported-network switching is disabled.
- Account and chain events invalidate stale state immediately. Out-of-order asynchronous reads cannot overwrite a newer account/provider or undo disconnect. Disconnect clears AppKit's session; injected wallet site permissions may also be revoked in the wallet itself.
- All original demo tools work without a wallet. No signature is requested on page load or connect. No seed/private-key entry fields, storage or logging are introduced. AppKit itself manages WalletConnect protocol session material, which is distinct from wallet private keys. Optional SDK analytics are disabled; Reown may still send mandatory SDK events.
- The opt-in connection-check transaction sends zero ETH to the connected account on Sepolia only, after UI confirmation and wallet approval. It costs testnet gas. Chain/account are re-read before submission; writes are serialized and never retried automatically. A returned hash is shown as submitted, not confirmed. A read-only RPC receipt lookup on submission/return marks confirmed/reverted only when a receipt exists; the explorer link is always available.
- There is no deployed StickerBomb contract integration in the original app. Campaign payments, NFT profiles and BOMB rewards remain demos. Mainnet connection support does not turn them into real transactions.

## Validation performed on 2026-11-13

| Check | Result |
| --- | --- |
| Vite production bundle | Passed (upstream chunk-size and annotation warnings) |
| Node tests with mocked EIP-1193 provider | 14 passed |
| JavaScript syntax checks | Passed |
| Desktop Chrome: missing-config message | Passed |
| Desktop Chrome: create campaign without wallet | Passed |
| Desktop Chrome: analytics and campaign survives reload | Passed |
| Release gate without project ID | Correctly blocks release |
| Real desktop injected-wallet/WalletConnect QR connection | Not run: no project ID or test wallet |
| Android Chrome: wallet selection, handoff, return | Not run: no physical Android wallet test session |
| iOS Safari: wallet selection, handoff, return | Not run: no physical iOS wallet test session |
| MetaMask in-app browser | Not run: no MetaMask browser test session |
| Real Sepolia transaction/receipt | Not run: no configured test wallet/project ID |

Mock tests are not evidence of real wallet interoperability. Do not call this cross-device validated until the following matrix is executed.

## Device acceptance checklist

For Android Chrome and iOS Safari, test MetaMask, Trust, Rainbow and Coinbase individually: fresh connection, rejection, timeout/cancel, approval and manual/automatic return; refresh after return; background/foreground; account change; network change; disconnect and reload; expired/deleted wallet session. Verify no forced navigation of the original browser to a wallet browser and no repeated signing prompt.

For desktop Chrome, test two installed EIP-6963 wallets together, a legacy injected provider separately, WalletConnect QR with a real phone, and Coinbase. For MetaMask's in-app browser, confirm injected selection without a redundant WalletConnect handoff.

On each platform, select Sepolia, fund a dedicated test account with test ETH, open Wallet connection check and approve its zero-value self-transfer. Record browser/OS/wallet versions, date, transaction hash and successful explorer receipt. Repeat declining the request, switching to mainnet before confirmation, switching accounts before confirmation, and double-clicking. Verify test sends stay disabled on mainnet. Confirm campaign creation, PDF download, map selection and photo placement still work disconnected.

If a mobile tab is killed before the transaction hash is returned, the app intentionally does not resubmit. Check wallet activity before manually trying again.

## Official references

- https://docs.reown.com/appkit/javascript/core/installation
- https://docs.reown.com/appkit/javascript/core/options
- https://docs.reown.com/appkit/javascript/core/actions
