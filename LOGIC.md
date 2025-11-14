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
- Discord agent – **neobot** (optional but first‑class):
  - A separate Go service in `d.a.t.a/` runs `neobot`, a CARV D.A.T.A‑powered Discord agent.
  - neobot talks in Discord like a teammate and turns natural‑language messages into calls to your neoland backend.
  - It can deploy collections, look up collection ids by name, show the caller’s wallet, and mint NFTs (SOL or CARV) via dedicated Discord APIs.

## Pages & What They Do
- Home: overview and quick links.
- Deploy: create a new collection (image upload → IPFS, on‑chain PDA init, save config).
- Mint: browse collections and mint a 1/1 NFT into your wallet.
- Market: collections table + list your NFTs; manage your own listings.
- Collection detail (`/market/<slug-or-id>`): view listings, buy, and see activity; make/cancel offers if enabled.
- Manage: for collection owners; update price, supply, mint window, pause trading.

## neobot (Discord Agent)

neobot is an AI agent that lives in your Discord server and uses the same backend that powers the web app. It does not talk directly to the blockchain; instead, it calls HTTP endpoints hosted by your neoland server.

- Service: Go app in `d.a.t.a/` (see `d.a.t.a/README.md`).
- Frameworks:
  - CARV D.A.T.A for agent orchestration and memory.
  - An LLM provider (e.g., DeepSeek/OpenAI) for natural‑language understanding and responses.
- Config:
  - `.env` and `src/config/config.yaml` under `d.a.t.a/` hold LLM keys, CARV keys, Discord token, and backend URLs.
  - `src/config/character_data_agent.json` defines tone, examples, and how to extract parameters from messages.

At a high level, neobot:

1) Listens to Discord DMs and mentions (e.g. `@neobot ...`).
2) Uses the LLM + character config to decide whether the message is a wallet, deploy, lookup, or mint request.
3) Calls the appropriate neoland backend API.
4) Responds in Discord with a friendly summary, and sends sensitive details (like wallet addresses) via DM when needed.

### Wallet Management Flow

- When you ask for your wallet (e.g., “what is my wallet address?”), neobot:
  1) Resolves or creates a wallet record for your Discord user (stored by the backend / D.A.T.A service).
  2) Returns the address to you via **DM** only, and posts a short, non‑sensitive confirmation in the channel.
- If you ask for another user’s wallet, neobot refuses and explains that it only reveals your own wallet for privacy reasons.

### Deploy Flow (from Discord)

When you ask neobot to deploy a collection with natural language:

1) neobot extracts:
   - `name` (collection name)
   - `symbol`
   - `mint price` (in SOL)
   - `supply`
   - Optional: attached image (used as collection art / metadata)
2) It calls the same deploy API used by the web UI (configurable; typically `/api/tx/init-collection` plus a follow‑up config call on your backend).
3) The backend performs the normal deploy steps:
   - Pin image and metadata to IPFS.
   - Build and submit the on‑chain tx to create the collection PDA and parent NFT.
   - Store the collection in the DB with its PDA, mint, and settings.
4) neobot replies in Discord with:
   - A short summary of what was deployed.
   - A mint link / collection link for your community.

If required parameters are missing, neobot uses the LLM to ask follow‑up questions until it has enough info to safely call the API.

### Collection Lookup Flow

When you ask for a collection id by name:

1) neobot calls a search endpoint on your backend (e.g. `/api/collections/search`) with the name string.
2) The backend returns zero, one, or many matches.
3) neobot responds:
   - No matches → explains nothing was found.
   - One match → shows the id, name, and symbol.
   - Multiple matches → lists ids with names/symbols so you can pick the right one.

This keeps Discord users in sync with collection identifiers used on the web and on‑chain.

### Mint Flow (from Discord)

For mint requests like “mint 2 from collection id X”:

1) neobot parses:
   - `collection id`
   - `quantity` (default 1)
   - `currency` (“SOL” by default, or “CARV” if requested)
2) It ensures you have a mapped wallet (creating one if needed).
3) neobot calls a dedicated Discord mint endpoint on your backend (e.g. `/api/discord/mint`) with:
   - `id` – collection id
   - `discord_user_id` – your Discord ID
   - `quantity`
   - `currency` – `"SOL"` or `"CARV"`
4) The backend:
   - Runs the normal mint logic and enforces per‑wallet limits, whitelists, and pricing.
   - Handles SOL or CARV token settlement on‑chain.
5) On success, neobot replies in Discord summarizing:
   - How many NFTs were minted.
   - Which collection id they came from.
   - Which currency was used.
   - The wallet that paid and the last minted mint address.

If the backend reports insufficient balance, a bad collection id, or other errors, neobot converts these into friendly explanations (e.g. “your wallet doesn’t have enough SOL/CARV” or “that collection id may not exist yet”).

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
