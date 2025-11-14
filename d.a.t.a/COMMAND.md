# neobot – Discord Command Guide

This file documents how to talk to **neobot** inside Discord and which natural‑language patterns it understands.

---

## 1. General Chatting Rules

- neobot reacts when:
  - You **DM** the bot, or
  - You **mention** it in a server message (e.g. `@neobot`).
- For public replies, neobot automatically **tags the requesting user** at the start of each message.
- When it shows sensitive data (like your wallet address), it sends that to you via **DM** and only posts a short confirmation in the channel.

---

## 2. Wallet Commands

Ask neobot for **your own** minting wallet:

- **Get wallet address**
  - `@neobot what is my wallet address?`
  - `@neobot what is my wallet?`

Behavior:

- neobot resolves/creates a per‑Discord wallet, then:
  - Sends the full address to your **DM** in character.
  - Posts a short confirmation in the channel (no address shown).

Privacy rule:

- If you ask for **another user’s** wallet, e.g.  
  `@neobot what is @someone wallet address?` or  
  `@neobot what is discord id 123... wallet address?`  
  neobot refuses and explains it only reveals **your** wallet, never other people’s.

---

## 3. Deploy Commands (Create a Collection)

neobot expects a **natural language** deploy request that includes:

- `name` – collection name  
- `symbol` – short ticker  
- `mint price` – in SOL (e.g. `0.01 SOL`)  
- `supply` – total number of NFTs  
- Optional: an attached image in Discord (used as collection art / metadata)

Examples:

- Deploy with explicit parameters:

```text
@neobot deploy this image as NFT collection, name it Neo Badge, symbol NEOB, price 0.01 SOL, supply 10000
```

- Deploy with casual phrasing:

```text
@neobot set up a cheap community badge, 0.005 SOL, call it Dev Badge, symbol DEVBDG, use the image I attached
```

If neobot cannot see all required fields, it will ask (via Deepseek) for the missing info, e.g.:

- `name`
- `symbol`
- `mint price (SOL)`
- `supply`

On success, it replies with a short AI‑generated summary and a **mint link**.

---

## 4. Collection ID Lookup

You can ask neobot for the **collection id** by name:

- Single collection or unknown:

```text
@neobot what is the collection id for CATTO SCREAM?
```

Behavior:

- neobot searches your backend (`/api/collections/search`) by name.
- If no collection matches, it explains that nothing was found.
- If one collection matches, it replies with:
  - The collection id in backticks
  - The name + symbol
- If multiple collections match, it lists each id with name/symbol so you can choose.

---

## 5. Mint Commands (Mint NFTs from a Collection)

### 5.1 Basic SOL mint

Use collection id directly:

```text
@neobot mint 1 from collection id 6z6dfl69
@neobot please mint this collection id 6z6dfl69, thanks!
```

Defaults:

- If you don’t specify a quantity, neobot assumes **1**.
- If you don’t specify a token, it defaults to **SOL**.

neobot internally:

- Resolves/creates your Discord wallet.
- Calls `/api/discord/mint` on your backend with:
  - `id` = collection id
  - `discord_user_id` = your Discord ID
  - `quantity` = requested (default 1)
  - `currency` = `"SOL"` unless you explicitly say CARV

On success, it:

- Tags you in the channel.
- Uses Deepseek to summarize:
  - How many NFTs were minted
  - From which collection id
  - Which currency (SOL/CARV)
  - Which wallet paid
  - The last minted mint address

### 5.2 CARV token mint

Explicitly pay with CARV:

```text
@neobot please mint this collection id 6z6dfl69 using CARV tokens
@neobot mint 2 from collection id 6z6dfl69 with CARV
```

neobot:

- Converts the SOL price into CARV using price oracles.
- Builds a CARV SPL‑token payment on your CARV SVM network.

### 5.3 Error handling (no balance, bad id, etc.)

If the backend responds with **insufficient funds / balance**, neobot:

- Detects this and asks Deepseek to write a friendly message, e.g.:
  - “Mint failed because your wallet doesn’t have enough SOL/CARV; top up and try again.”

If the collection id is invalid or the backend returns `404 collection not found`:

- It responds (via LLM) that the collection id looks wrong or may not exist yet and suggests checking the id or pinging the devs.

---

## 6. Quick Reference – Example Messages

- Get your wallet address (via DM):
  - `@neobot what is my wallet address?`

- Deploy an NFT collection:
  - `@neobot deploy this image as NFT collection, name Neo Badge, symbol NEOB, price 0.01 SOL, supply 10000`

- Look up collection id by name:
  - `@neobot what is the collection id for CATTO SCREAM?`

- Mint 1 NFT with SOL:
  - `@neobot mint from collection id 6z6dfl69`

- Mint multiple NFTs with CARV:
  - `@neobot mint 3 from collection id 6z6dfl69 using CARV tokens`

These are **examples**, not strict slash‑commands—neobot uses Deepseek to understand natural language variants as long as the intent and key parameters are clear.
