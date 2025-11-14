# App Logic (High‑Level)

This document explains how the site works end‑to‑end without deep code or cryptography. It focuses on the main flows and what each component is responsible for.

## Stack Overview
- Client: static pages in `public/` using ES modules, no bundler.
- Wallet: Backpack provider (Solana). The UI will try to silently reconnect if you’ve connected before.
- Server: `server.js` (Node 18+) serves pages and JSON APIs, builds unsigned transactions, and pins media to IPFS.
- Persistence: `db.js` uses SQLite/JSON by default, or Supabase Postgres if configured.
- On‑chain programs:
  - Marketplace (Anchor) in `onchain/market/` for list/buy/cancel (+ SPL buy).
  - Collection program (address via `COLLECTION_PROGRAM_ID`) to register a collection PDA.
  - Offers program (optional; address via `OFFERS_PROGRAM_ID`) for collection‑wide offers.
- Discord bot (optional):
  - A separate service in `d.a.t.a/` runs a CARV D.A.T.A‑powered Discord bot.
  - The bot can call this app’s deploy API so new collections can be set up from Discord, but the actual on‑chain transaction and DB records still go through the same flow as the web UI.

## Pages & What They Do
- Home: overview and quick links.
- Deploy: create a new collection (image upload → IPFS, on‑chain PDA init, save config).
- Mint: browse collections and mint a 1/1 NFT into your wallet.
- Market: collections table + list your NFTs; manage your own listings.
- Collection detail (`/market/<slug-or-id>`): view listings, buy, and see activity; make/cancel offers if enabled.
- Manage: for collection owners; update price, supply, mint window, pause trading.

## Collections
- A collection has: name, symbol, image (IPFS), price, supply, optional mint window, optional whitelist (array of allowed minter addresses), optional per‑wallet mint cap (currently fixed at 1), optional royalty percentage (basis points), owner wallet, and optional on‑chain PDA.
- Deploy flow (roughly):
  1) Image is pinned to IPFS via `/api/pin/image`.
  2) Metadata JSON is pinned via `/api/pin/metadata`.
  3) Server builds an unsigned tx to initialize the collection PDA and parent collection NFT in one transaction via `COLLECTION_PROGRAM_ID` (`/api/tx/init-collection`).
  4) After you sign and send that tx, the server records the collection in the DB with its PDA, collection mint, and settings (`/api/deploy/config`).
- Owners can later update: price, supply, start/end time, whitelist, royalty, and pause trading. Updates use a signed‑message nonce flow to prove ownership.

## Minting NFTs (1/1)
- The server constructs an unsigned mint transaction with standard building blocks:
  - Create the mint account and your associated token account
  - Mint exactly 1 token to your account
  - Create on‑chain metadata + master edition (Metaplex Token Metadata program)
  - Optionally transfer update authority to the collection owner so metadata governance is consistent
  - Optionally prepend a payment (SOL or CARV token) so payment and mint happen atomically
  - Enforce whitelist if set on the collection (server-side check)
  - Enforce a per‑wallet mint cap by counting existing mints for that wallet and collection (limit: 1)
- For SOL mints, uses program-mint with lock to update metadata immediately if owner.
- Does not allow a wallet to mint more than once for the same collection (1 per wallet); attempts beyond that are rejected before the transaction is built.
- You sign with Backpack; for direct mints, also sign with a fresh mint key. The client sends, tracks confirmation, and shows explorer links.
- Successful mints are recorded in the DB for activity and collection pages.

## Marketplace (list, buy, cancel)
- Program: `onchain/market/programs/market/src/lib.rs` (Anchor) with four key instructions:
  - `list(price, payment_mint)` – moves the NFT from seller to a listing‑owned escrow account and stores the price. `payment_mint` is `Pubkey::default()` for SOL or an SPL mint (e.g., CARV) for token‑settled listings.
  - `cancel()` – returns the NFT from escrow back to the seller and closes the escrow token account.
  - `buy(royalty_bps, creator)` – SOL settlement: calculates royalty (price * royalty_bps / 10000), transfers royalty to creator, remainder to seller, then NFT from escrow → buyer, and closes escrow.
  - `buy_spl(royalty_bps, creator)` – SPL settlement (e.g., CARV): calculates royalty, transfers royalty tokens to creator ATA (creates if needed), remainder to seller, then NFT from escrow → buyer, and closes escrow.
- Client flow:
  - List: UI asks your price (SOL or CARV). Server builds the unsigned list tx (`/api/market/tx/list`). You sign and send. Then the server indexes the listing (`/api/market/list`).
  - Cancel: Server builds the unsigned cancel tx (`/api/market/tx/cancel`). You sign and send. Then the server marks it cancelled (`/api/market/cancel`).
  - Buy: Server builds the unsigned buy tx (`/api/market/tx/buy` or `/buy-spl` for token listings), fetching collection royalty settings. You sign and send. Then the server marks it sold (`/api/market/sold`).
- Guardrails:
  - Minimum price: 0.003 SOL or 1 CARV.
  - Buy is blocked if the collection owner paused trading.
  - The server checks escrow still holds the NFT before building a buy tx to reduce failed sends.
  - Royalties are enforced on-chain; for CARV, server creates creator ATA if missing (funded by `PRIVATE_KEY_BASE58`).

## Offers (optional)
- If `OFFERS_PROGRAM_ID` is set, the app supports collection‑wide offers:
  - Configure: set the registry owner for the collection to enable offers (`/api/offers/tx/configure`).
  - Make offer: lock SOL into a program vault and create an offer PDA tied to the collection PDA and your wallet (`/api/offers/tx/make`).
  - Cancel offer: release funds and close your offer PDA (`/api/offers/tx/cancel`).
  - Accept offer (seller): transfers SOL → seller and NFT → bidder (`/api/offers/tx/accept`).
- The UI shows the current best on‑chain offer by scanning accounts for the collection’s PDA.
- Activity entries are stored off‑chain for offer created/cancelled/accepted so the collection page has a clear timeline.

## Prices & Explorer
- Server fetches USD quotes for SOL and CARV (if an API key is present) and exposes:
  - `/api/sol-price` → `{ usd }`
  - `/api/prices` → `{ solUsd, carvUsd, carvPerSol }`
- The client uses these for approximate USD/CARV conversions and explorer links are built from the configured RPC so they point to the right cluster.

## Persistence Model
- Local (default): JSON/SQLite files store collections (with whitelists), mints, listings, offers (if enabled), and activity.
- Supabase (optional): same shapes in Postgres; `db.js` maps to tables defined in `supabase/schema.sql`.

## Auth & Safety
- Admin updates: an `/api/admin/nonce` + signed message proves you control the owner wallet before changes (price, supply, schedule, pause) are applied.
- CSP and caching: HTML served with a tight Content‑Security‑Policy; static assets get reasonable caching headers.
- Transactions are unsigned when sent to the client; your wallet signs locally. Some SPL edge cases may require a server co‑signature (e.g., creating a recipient ATA for token payments), which the server adds as a partial signature only when needed.

## What to Configure
- RPC and network badge (`CARV_RPC`, `CARV_NETWORK`).
- Program IDs: `MARKET_PROGRAM_ID`, `COLLECTION_PROGRAM_ID`, and optional `OFFERS_PROGRAM_ID` (for collection-wide offers).
- IPFS pinning (Pinata or Lighthouse) if you want to upload media via the UI.
- Persistence (defaults are file‑based). For Supabase, set `SUPABASE_URL` and `SUPABASE_ANON_KEY` and run the schema in `supabase/schema.sql`.
- Royalties: Set per collection by the creator (basis points); no global default is applied.

That’s it — this should give you a solid mental model without diving into code.
