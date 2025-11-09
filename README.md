# neoland

A simple, full‑stack NFT app for the CARV SVM network. It lets creators deploy a collection, fans mint 1/1 NFTs, and everyone list and trade on a lightweight marketplace. The app is optimized for Backpack wallet and runs on Node.js with a small, fast front‑end.

## Features
- Deploy collections
  - Upload cover image and auto‑pin to IPFS
  - Create an on‑chain collection PDA (proof)
  - Store collection config (price, supply, schedule)
- Mint NFTs
  - One‑click mint of 1/1 NFTs with on‑chain metadata
  - SOL payments; optional CARV token support
  - Explorer links and clear confirmation UI
- Marketplace
  - List, buy, and cancel listings
  - Set price in SOL or CARV token
  - Optional collection‑wide offers (make/cancel)
  - Collection stats: floor, 24h volume, activity
- Wallet UX
  - Backpack connect, address popover, quick copy
  - Balance and approximate USD values
- Clean UI
  - Neobrutalist theme, dark/light toggle, keyboard‑friendly

## Repo Layout
- `public/` – Pages and client JS (no bundler)
- `server.js` – HTTP server + API routes
- `marketplace.js` – Marketplace and offer API/tx builders
- `db.js` – Persistence (SQLite file or Supabase)
- `onchain/market/` – Anchor program for listing/buy/cancel
- `supabase/` – Optional Postgres schema

## Requirements
- Node.js 18+
- A funded wallet private key for the server (deployer)
- A CARV SVM RPC URL

## Quick Start
1. Install deps
   - `npm install`
2. Configure environment
   - Copy your values into `.env` (see Env Vars below)
3. Run locally
   - `npm start`
   - Open `http://localhost:8080`

## Environment Variables (most common)
- `PRIVATE_KEY_BASE58` – Server signer (base58 secret key) used for metadata ATAs and some SPL flows
- `CARV_RPC` – RPC URL (e.g. `https://rpc.testnet.carv.io/rpc`)
- `CARV_NETWORK` – Network label shown in UI (e.g. `carv-testnet`)
- `MARKET_PROGRAM_ID` – Anchor program address for marketplace
- `OFFERS_PROGRAM_ID` – Optional on‑chain offers program address
- `COLLECTION_PROGRAM_ID` – Program that initializes collection PDAs
- `CARV_MINT` – CARV token mint address (for token‑priced listings)
- IPFS/Pinning (optional, for auto‑upload)
  - `PINATA_JWT` or Lighthouse creds via `@lighthouse-web3/sdk`
  - `PINATA_GATEWAY` (e.g. `https://gateway.pinata.cloud`)
- Persistence
  - Default is local JSON/SQLite. For Supabase:
    - `SUPABASE_URL`
    - `SUPABASE_ANON_KEY`

All variables are read by `server.js`. Missing entries will disable related features gracefully (e.g., offers).

## Common Workflows
- Create a collection: `Deploy` page → fill name/symbol, pick image, set price, and (optionally) mint window → confirm wallet actions.
- Mint: `Mint` page → open a collection → click `Mint` and approve the tx.
- List for sale: `Market` → `List Your NFTs` → choose NFT → set price in SOL or CARV → sign list tx → confirm index.
- Buy: Open a collection → click `Buy` on a listing → approve and wait for confirmation.
- Manage: `Manage` page (visible if you’re an owner) → update price, supply, mint window, or pause trading.

## Deployment
- Vercel: `api/index.mjs` wraps `handleRequest` from `server.js`.
- Filesystem storage defaults to `./data.json` / `./data.sqlite`. Override with `DATA_JSON_PATH` / `DATA_SQLITE_PATH` if your host needs writable temp dirs.

## Notes
- Network calls show toasts and safe fallbacks (e.g., explorer links if confirmation is slow).
- Minimum prices: 0.003 SOL or 1 CARV for listings; owners can pause buys for their collection.

If you need deeper internals, see `LOGIC.md`.

