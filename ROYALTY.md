## How Creator Royalties Work in NFT Marketplaces

Creator royalties ensure original NFT creators earn a percentage of secondary sales. When an NFT is resold, the marketplace automatically deducts and forwards a royalty fee (e.g., 5%) to the creator, while the rest goes to the seller. This is enforced on-chain to prevent bypasses.

In standard NFT ecosystems (like Ethereum's ERC-721 with EIP-2981), royalties are set in the NFT's metadata. However, since your marketplace uses a custom on-chain program, we'll implement royalties directly in the buy instructions to guarantee enforcement.

## Implementation Steps for Your Codebase

1. **Add Royalty Configuration to Collections**:
   - Introduce `royaltyBps` (basis points, e.g., 500 = 5%) to collection schema.
   - Default to 0 or a standard like 500.
   - Creator recipient: Use collection owner's wallet (deployer/creator collection).

2. **Update Database and APIs**:
   - Modify collection storage to include royalty fields.
   - Update deploy/config endpoint to accept and store royalties.

3. **Modify On-Chain Buy Instructions**:
   - In `onchain/market/src/lib.rs`, update `buy` and `buy_spl` functions.
   - Calculate royalty: `royalty_amount = price * royalty_bps / 10000`.
   - Transfer royalty to creator's ATA, remainder to seller.

4. **Update Transaction Builders**:
   - In `marketplace.js`, modify `/api/market/tx/buy` to include royalty logic and pass collection data.

5. **Frontend Updates**:
   - Add royalty input in deploy form.
   - Display royalty info in listings (e.g., "5% royalty to creator").

6. **Testing and Deployment**:
   - Test buy flows with royalties enabled.
   - Deploy updated on-chain program.

## Specific Code Changes Needed

### Database Schema (`db.js`, `supabase/schema.sql`)
- Add `royalty_bps integer not null default 0` to collections table.
- Update migration scripts to add the column.

### Server (`server.js`)
- In `/api/deploy/config`: Accept `royaltyBps` param, store in DB.
- In buy tx builders (`/api/market/tx/buy`, `/api/market/tx/buy-spl`): Fetch collection royalty, include in tx. For CARV buys, check creator ATA existence; if missing, add ATA creation instruction with server partial signature (using `PRIVATE_KEY_BASE58`).

### On-Chain Program (`onchain/market/src/lib.rs`)
- Modify `Buy` and `BuySpl` structs to include royalty fields (royalty_bps, creator pubkey).
- In `buy` instruction (SOL):
  ```rust
  let royalty_amount = (price * royalty_bps) / 10000;
  // Transfer royalty_amount to creator pubkey
  // Transfer (price - royalty_amount) to seller
  ```
- In `buy_spl` instruction (CARV):
  ```rust
  let royalty_amount = (price * royalty_bps) / 10000;
  // Check if creator ATA exists; if not, create it (rent funded by server partial sig "PRIVATE_KEY_BASE58")
  // Transfer royalty_amount tokens to creator ATA
  // Transfer remaining tokens to seller
  ```

### Frontend (`public/deploy.html`, `public/market-collection.js`)
- Deploy form: Add `<input type="number" id="depRoyalty" placeholder="Royalty % (e.g., 5)">`.
- Market UI: Show "Includes 5% royalty" in listing details.

### APIs (`marketplace.js`)
- Update buy tx endpoint to query collection royalty and build split transfers.

## Technical Architecture Overview

```
Buyer Pays Price → On-Chain Buy Instruction
    ↓
Calculate Royalty (price * bps / 10000)
    ↓
For SOL: Transfer Royalty → Creator Wallet
For CARV: Check/Create Creator ATA (funded by server if needed) → Transfer Royalty
    ↓
Transfer Remainder → Seller ATA
    ↓
NFT from Escrow → Buyer
```

This ensures royalties are trustless and automatic. For CARV royalties, if the creator lacks an Associated Token Account (ATA) for CARV, the server creates it using `PRIVATE_KEY_BASE58` to fund the rent-exempt account creation (via a partial signature in the buy tx). The server wallet covers the SOL rent cost for ATA creation, ensuring smooth royalty distribution.