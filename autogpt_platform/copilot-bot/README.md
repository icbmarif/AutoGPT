# CoPilot Bot

Multi-platform bot service for AutoGPT CoPilot / AutoPilot, built on the [Chat SDK](https://chat-sdk.dev).

Deploys AutoPilot to Discord, Telegram, and Slack from a single codebase.

## How it works

1. User runs `/setup` on a Discord server (or messages the bot on Telegram)
2. Bot DMs / replies ephemerally with a one-time link URL
3. User logs in to AutoGPT → confirms → server is linked to their account
4. Anyone in that server can then mention the bot, each with their own CoPilot session
5. All usage bills to the owner's AutoGPT account

## Setup

```bash
npm install
cp .env.example .env          # fill in DISCORD_BOT_TOKEN, PLATFORM_BOT_API_KEY, REDIS_URL, etc.
npm run register-commands     # one-time: publish slash commands to Discord
npm run dev                   # start the bot
```

## Architecture

```text
src/
├── index.ts            # Entry point — HTTP server + Gateway loop
├── config.ts           # Environment-based configuration
├── bot.ts              # Core bot logic (Chat SDK handlers)
├── platform-api.ts     # AutoGPT platform API client
├── discord/            # Discord interaction module
│   ├── types.ts        # Discord API types
│   ├── components.ts   # Button / row builders
│   ├── interactions.ts # Registry + dispatcher for slash commands, buttons, modals
│   └── handlers.ts     # Handler implementations
└── scripts/
    └── register-discord-commands.ts   # One-time slash command registration
```

## Deployment

Long-running Node process. Runs anywhere you can run a container or a Node process:

```bash
npm run build
npm start
```

Requirements:
- Node 20+
- Redis for state persistence (optional for dev, required for production)
- Network access to the AutoGPT platform API
- A public URL if you want Discord's native Interactions Endpoint (slash commands). Without it, the bot uses the Gateway WebSocket for everything and the interception layer handles slash commands via Gateway forwarding.

Typical setups: Docker container in your existing cluster, Fly.io / Railway, or bare VPS with PM2.

## Commands

- `/setup` — link the current server to an AutoGPT account (ephemeral)
- `/unlink` — open AutoGPT settings to manage linked servers
- `/help` — show usage info

## Dependencies

- [Chat SDK](https://chat-sdk.dev) — cross-platform bot abstraction
- AutoGPT Platform API — account linking + CoPilot chat streaming
