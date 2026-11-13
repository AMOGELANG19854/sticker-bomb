# Sepolia payout configuration

Set these runtime values on the Sites Worker.

- `SEPOLIA_RPC_URL` is an HTTPS Sepolia JSON-RPC endpoint.
- `SEPOLIA_ESCROW_ADDRESS` is the deployed CampaignEscrow address.
- `SEPOLIA_USDT_ADDRESS` is the six-decimal Sepolia test USDT contract passed to CampaignEscrow.
- `SEPOLIA_ESCROW_START_BLOCK` is the escrow deployment block for receipt recovery.
- `SEPOLIA_SIGNER_KEY` is a runtime secret for a dedicated Sepolia-only campaign company signer. Fund its gas balance with Sepolia ETH. Never use a mainnet signer or a worker's recovery phrase.

Before payout, fund the matching escrow campaign from that signer using the bytes32
identifier `ethers.id('Sticker Bomb campaign:' + siteCampaignId)`. The existing
contract's QR format is index 0. Use the published sticker count and the intended
test printer address. The escrow contract prevents settling the same stop twice.
The app requires a successful receipt with the matching escrow event and token transfer
before it displays paid. Workers can use **Check payout** to refresh or retry.
