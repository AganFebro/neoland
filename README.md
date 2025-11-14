# neoland

A simple, full‑stack NFT app for the CARV SVM network. It lets creators deploy a collection, fans mint 1/1 NFTs, and everyone list and trade on a lightweight marketplace. The app is optimized for Backpack wallet and runs on Node.js with a small, fast front‑end.

## Features
- Deploy collections
  - Upload cover image and auto‑pin to IPFS
  - Create an on‑chain collection PDA and parent collection NFT in one transaction
  - Store collection config (price, supply, schedule, optional whitelist)
- Mint NFTs
  - One‑click mint of 1/1 NFTs with on‑chain metadata
  - Enforced limit of 1 mint per wallet per collection
  - SOL or CARV token payments
  - Whitelist enforcement for restricted collections
  - Explorer links and clear confirmation UI
- Marketplace
  - List, buy, and cancel listings
  - Set price in SOL or CARV token
  - Automatic creator royalties on secondary sales (configurable per collection)
  - Optional collection‑wide offers (make/cancel/accept)
  - Collection stats: floor, 24h volume, activity, best offer
- Wallet UX
  - Backpack connect, address popover, quick copy
  - Balance and approximate USD values
- Clean UI
  - Neobrutalist theme, dark/light toggle, keyboard‑friendly
- Discord + agents (optional)
  - Discord bot powered by the CARV D.A.T.A framework living in `d.a.t.a/`
  - Lets you trigger collection deployment flows directly from Discord while reusing the same on‑chain deploy API as the web app

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
- Royalties
  - `DEFAULT_ROYALTY_BPS` – Royalty is now set per collection by the creator

All variables are read by `server.js`. Missing entries will disable related features gracefully (e.g., offers).

## Common Workflows
- Create a collection: `Deploy` page → fill name/symbol, pick image, set price, royalty %, and (optionally) mint window/whitelist → confirm wallet actions.
- Mint: `Mint` page → open a collection → select SOL/CARV, click `Mint` (batch if desired) and approve the tx (whitelist enforced if set).
- List for sale: `Market` → `List Your NFTs` → choose NFT → set price in SOL or CARV → sign list tx → confirm index.
- Buy: Open a collection → click `Buy` on a listing → approve and wait for confirmation (royalty automatically paid to creator).
- Make/cancel offers: Collection page → enter offer price → sign tx to lock/unlock SOL.
- Accept offers: As seller, accept on-chain offers to transfer NFT for locked SOL.
- Manage: `Manage` page (visible if you’re an owner) → update price, supply, mint window, whitelist, royalty, or pause trading.

## Deployment
- Vercel: `api/index.mjs` wraps `handleRequest` from `server.js`.
- Filesystem storage defaults to `./data.json` / `./data.sqlite`. Override with `DATA_JSON_PATH` / `DATA_SQLITE_PATH` if your host needs writable temp dirs.

## Notes
- Network calls show toasts and safe fallbacks (e.g., explorer links if confirmation is slow).
- Minimum prices: 0.003 SOL or 1 CARV for listings; owners can pause buys for their collection.
- Whitelists restrict minting to specified wallets; managed via `Manage` page with signed updates.
- Royalties are automatically enforced on-chain for secondary sales; creators receive SOL or CARV directly.

If you need deeper internals, see `LOGIC.md`.
