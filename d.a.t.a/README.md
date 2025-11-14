# neobot – Discord NFT Deploy Bot (CARV D.A.T.A)

> A Discord bot that lets you deploy NFT collections to your neoland backend using natural language, powered by the CARV D.A.T.A framework.

This folder contains a small Go service that runs an AI agent called **neobot**. The bot lives in your Discord server, talks like a friendly dev teammate, and turns messages such as “deploy a 10k collection at 0.01 SOL” into calls to your neoland deploy API.

---

## 🔍 What neobot Does

- Listens to messages in the Discord server where the bot is installed.
- Uses an LLM (DeepSeek/OpenAI, configurable) plus CARV D.A.T.A to understand deploy requests.
- Calls your neoland backend deploy endpoint (`/api/tx/init-collection`) with the parameters it extracted.
- Replies in Discord with a short summary and a link to the mint page when the deploy succeeds (or a friendly error when it fails).
- Stores minimal state in a local SQLite database (`./data/agent.db`) so the agent has memory across runs.

The behaviour and personality of the bot are described in `src/config/character_data_agent.json` and wired through `src/config/config.yaml`.

---

## ✅ Requirements

- Go **1.21+**
- `make`
- A Discord application + bot token
- CARV D.A.T.A API key (CarvID)
- An LLM API key (DeepSeek or another supported provider)
- A running neoland backend you can reach from this service

---

## ⚙️ Configuration

neobot reads configuration from:

- `.env` (recommended for secrets)
- `src/config/config.yaml`
- `src/config/character_data_agent.json`

### 1. Environment file (`.env`)

Create (or edit) `d.a.t.a/.env`:

```env
# LLM configuration
LLM_API_KEY=your-llm-api-key
LLM_PROVIDER=deepseek            # or openai, etc.

# CARV / D.A.T.A
CARV_DATA_BASE_URL=https://api.carv.io
CARV_DATA_API_KEY=your-carv-api-key

# Discord bot
DISCORD_API_TOKEN=your-discord-bot-token

# Optional socials
TWITTER_API_KEY=...
TWITTER_API_KEY_SECRET=...
TWITTER_ACCESS_TOKEN=...
TWITTER_TOKEN_SECRET=...
TELEGRAM_BOT_TOKEN=...

# Deploy API (your neoland backend)
DEPLOY_API_BASE_URL=https://your-neoland-host        # e.g. http://localhost:8080 or https://febro.fun
DEPLOY_API_KEY=                                      # if your backend expects a bearer token
DEPLOY_API_PATH=/api/tx/init-collection
DEPLOY_PAYER=your-payer-wallet-address
DEPLOY_OWNER=your-owner-wallet-address
DEPLOY_OWNER_SECRET=your-owner-secret-key

SAVE_PIN_IMAGES=true
PIN_IMAGE_SAVE_DIR=./data/tmp
```

> Keep this file **out of version control**; it contains secrets.

### 2. Agent + runtime config (`src/config/config.yaml`)

Important sections you may want to edit:

- `character`  
  - `name: "neobot"` – the internal name of the agent.
- `llm_config`  
  - `provider`, `api_key`, `base_url`, `model` – should match what you put in `.env` (or you can leave this as a fallback).
- `data.carvid`  
  - `url`, `api_key` – your CARV data endpoint and key.
- `deploy`  
  - `base_url` – same as `DEPLOY_API_BASE_URL` (your neoland server).  
  - `path` – relative path to the deploy endpoint, usually `/api/tx/init-collection`.  
  - `payer`, `owner`, `owner_secret` – default wallet config used when the backend requires it.
- `social.discord.api_token`  
  - Discord bot token (you can put it here or only in `.env` – choose one place and keep it consistent).
- `web.port`  
  - Port for the small internal web UI / health endpoints (default `8000`).

### 3. Character file (`src/config/character_data_agent.json`)

This file defines **how neobot talks and behaves**:

- `name`: `"neobot"`
- `system`: high-level description of the bot.
- `message_examples`: examples of how users talk to the bot and how it should respond.
- `task_instructions`: how to detect deploy requests, what parameters to extract, and how to present results.

You generally don’t need to edit this unless you want to change the bot’s tone or capabilities.

---

## 🤖 Setting up the Discord Bot

1. **Create a Discord application**
   - Go to the [Discord Developer Portal](https://discord.com/developers/applications).
   - Create a new application (e.g., `neobot`).
   - Add a **Bot** to the application and copy the **Bot Token**.

2. **Enable required intents**
   - Under the Bot settings, enable:
     - `MESSAGE CONTENT INTENT`
     - `SERVER MEMBERS INTENT` (optional, but often useful)

3. **Invite the bot to your server**
   - Under **OAuth2 → URL Generator** select:
     - `bot` scope
     - Permissions such as `Send Messages`, `Read Message History`
   - Open the generated URL and add the bot to your Discord server.

4. **Wire the token into neobot**
   - Put the Bot Token in `.env` as `DISCORD_API_TOKEN=...`  
     **or** into `src/config/config.yaml` under `social.discord.api_token`.

Once the service is running, the bot will use the character file to detect messages that look like deploy requests and call your neoland API.

---

## 🛠 Build and Run

From the `d.a.t.a` directory:

### Install dependencies

```bash
make tidy
```

### Run in development

```bash
make run
```

This compiles and runs the agent from `./src/cmd/agent`. You should see logs indicating:

- LLM + CARV connections initialised
- Discord bot logged in
- Web server listening on the configured port

### Build a binary

```bash
make build
```

This produces a binary named `d.a.t.a` in the `d.a.t.a` folder. You can then run it directly:

```bash
./d.a.t.a
```

Use this for production or when running under a process manager (systemd, pm2, Docker, etc.).

---

## 💬 Using neobot in Discord

Once running and online in your server, you can talk to neobot like this:

- `@neobot deploy this image as NFT collection, name it Neo Badge, symbol NEOB, price 0.01 SOL, supply 10000`
- `@neobot set up a cheap community badge, 0.005 SOL, call it Dev Badge, symbol DEVBDG, use the image I attached`

neobot will:

1. Parse your message and extract **name**, **symbol**, **mint price**, **supply**, and the image.
2. Call the configured neoland deploy API.
3. Reply with:
   - A short confirmation of the parameters it used.
   - A mint link / collection link once everything is saved.

If something fails (RPC error, bad config, API offline), neobot will answer with a friendly explanation and suggest what to fix.

---

## 📮 Support / Notes

This bot is built on top of CARV’s D.A.T.A framework but customised for the **neoland** NFT app. For deeper framework docs, see:

- D.A.T.A documentation: https://docs.carv.io/d.a.t.a.-ai-framework/introduction

For issues in this project, prefer tracking them in your main neoland repo.
