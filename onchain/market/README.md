# Minimal NFT Marketplace (Anchor)

This is a small, trustless marketplace program for 1/1 NFTs:
- `list(mint, price)` moves the NFT to a PDA-owned escrow ATA.
- `cancel(mint)` returns the NFT to the seller and closes escrow.
- `buy(mint)` transfers SOL buyer→seller and NFT escrow→buyer, then closes escrow.

No marketplace fees. No royalties.

## Configure and Deploy (CARV SVM testnet)

1) Replace the program ID in code and config:
   - programs/market/src/lib.rs: change `declare_id!(...)` to your program ID.
   - Anchor.toml: set `[programs.localnet].market` to the same program ID.
2) Generate a keypair and program ID (once):
   - `anchor keys list` (or `anchor keys sync` to write new IDs)
3) Build + deploy:
   - `anchor build`
   - `anchor deploy --provider.cluster custom --provider.url <your CARV RPC>`

Then set in your .env used by the server:
- `MARKET_PROGRAM_ID=YourProgramIdHere`
- `CARV_SVM_RPC=https://rpc.testnet.carv.io/rpc` (or your CARV endpoint)

The server builds client‑signable transactions targeting this program.
