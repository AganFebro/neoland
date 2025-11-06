Deploy to Vercel (Node.js 22)

Overview
- This project serves both dynamic API routes and static files from a single Node handler.
- Vercel runs it as a Serverless Function via `api/index.mjs` and routes all paths there.
- Node 22 global `fetch` is used; no `node-fetch` needed.

Prerequisites
- Node.js 22.x locally (you’re already on v22.20.0)
- Vercel account + CLI (`npm i -g vercel`)
- A Solana keypair secret in Base58 for minting: `PRIVATE_KEY_BASE58`

What’s included
- `server.js` exports `handleRequest(req, res)` and only starts an HTTP server locally (not on Vercel).
- `api/index.mjs` forwards all requests to `handleRequest`.
- `vercel.json` routes everything to `/api/index.mjs` and sets the `nodejs22.x` runtime.
- `db.js` supports env overrides so you can use `/tmp/data.json` on Vercel.

Environment variables (Vercel → Project → Settings → Environment Variables)
- Required
  - `PRIVATE_KEY_BASE58` — wallet secret (Base58) used as deployer
  - `CARV_RPC` — Solana RPC endpoint (or set `CARV_SVM_RPC` instead)
- Optional
  - `CARV_NETWORK` — label for UI (e.g., `carv-testnet`)
  - `PINATA_JWT` — to enable image/metadata pinning endpoints
  - `PINATA_GATEWAY` — custom Pinata gateway URL (default: `https://gateway.pinata.cloud`)
  - `CMC_API_KEY` — CoinMarketCap API key for SOL price (optional)
  - `DATA_JSON_PATH` — set to `/tmp/data.json` on Vercel to allow ephemeral file writes
  - `DATA_SQLITE_PATH` — ignored on Vercel (SQLite native module not used in serverless)

Note on persistence
- Vercel serverless filesystem is ephemeral; files in `/tmp` do not persist across cold starts.
- For production persistence, plug in a hosted DB (Vercel Postgres, Turso, etc.). The code already cleanly isolates DB access in `db.js`.

Local development
1) Create `.env` with at least:
   - `PRIVATE_KEY_BASE58=...`
   - `CARV_RPC=...`
2) Run locally: `npm start`
   - The app listens on `http://localhost:8080`.

Deploy with Vercel CLI
1) Login: `vercel login`
2) From the project root: `vercel` (first-time setup)
3) On subsequent deploys: `vercel --prod`

Vercel dashboard setup (alternative)
1) Import the repo in Vercel dashboard
2) Framework preset: “Other”
3) Build & Output settings
   - Build Command: (leave empty)
   - Output Directory: (leave empty)
   - Install Command: (default)
4) Add the environment variables listed above
5) Deploy

Verification checklist
- Open the deployed URL
- Navigate to `/` (home) and `/mint`
- Confirm `/api/collections` responds with JSON
- Test mint flow; deployer must now have sufficient SOL to mint (price enforcement fix included)

Troubleshooting
- 500 errors on cold start often indicate missing env vars (e.g., `PRIVATE_KEY_BASE58`).
- If Pinata endpoints fail, ensure `PINATA_JWT` is set.
- If you need persistent state, move `db.js` to a hosted DB and remove JSON fallback.

