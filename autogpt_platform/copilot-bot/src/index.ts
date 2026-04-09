/**
 * CoPilot Bot — Standalone entry point (self-hosted / local dev).
 *
 * For Vercel deployment, use src/api/ instead.
 * This runner starts an HTTP server for webhook handling and connects
 * to the Discord Gateway for receiving regular messages.
 */

// Load .env BEFORE any other imports
import { config } from "dotenv";
config();

import { loadConfig } from "./config.js";
import { createBot } from "./bot.js";

const PORT = parseInt(process.env.PORT ?? "3001", 10);

async function main() {
  console.log("🤖 CoPilot Bot starting...\n");

  const cfg = loadConfig();

  const enabled = [
    cfg.discord && "Discord",
    cfg.telegram && "Telegram",
    cfg.slack && "Slack",
  ].filter(Boolean);

  console.log(`📡 Adapters: ${enabled.join(", ") || "none"}`);
  console.log(`🔗 API:      ${cfg.autogptApiUrl}`);
  console.log(`💾 State:    ${cfg.redisUrl ? "Redis" : "In-memory"}`);
  console.log(`🌐 Port:     ${PORT}\n`);

  let stateAdapter;
  if (cfg.redisUrl) {
    const { createRedisState } = await import("@chat-adapter/state-redis");
    stateAdapter = createRedisState({ url: cfg.redisUrl });
  } else {
    const { createMemoryState } = await import("@chat-adapter/state-memory");
    stateAdapter = createMemoryState();
  }

  const bot = await createBot(cfg, stateAdapter);

  // Start HTTP server for webhook requests
  await startServer(bot, PORT);

  // Connect Discord Gateway if enabled
  if (cfg.discord) {
    await bot.initialize();
    // getAdapter() returns the initialized adapter instance with gateway methods;
    // bot.adapters gives the raw config objects which don't have startGatewayListener.
    const discord = (bot as any).getAdapter("discord");

    if (discord?.startGatewayListener) {
      const webhookUrl = `http://localhost:${PORT}/api/webhooks/discord`;
      console.log(`🔌 Discord Gateway → ${webhookUrl}`);

      // Run in background, reconnect on disconnect
      void runGatewayLoop(discord, webhookUrl);
    }
  }

  console.log("\n✅ CoPilot Bot ready.\n");

  process.on("SIGINT", () => { console.log("\n🛑 Shutting down..."); process.exit(0); });
  process.on("SIGTERM", () => { console.log("\n🛑 Shutting down..."); process.exit(0); });
}

async function runGatewayLoop(discord: NonNullable<Awaited<ReturnType<typeof createBot>>["adapters"]["discord"]>, webhookUrl: string) {
  while (true) {
    try {
      const pendingTasks: Promise<unknown>[] = [];
      const waitUntil = (task: Promise<unknown>) => { pendingTasks.push(task); };

      await discord.startGatewayListener(
        { waitUntil },
        10 * 60 * 1000, // 10 minute window
        undefined,
        webhookUrl,
      );

      if (pendingTasks.length > 0) {
        await Promise.allSettled(pendingTasks);
      }

      console.log("[gateway] Session ended, reconnecting...");
    } catch (err) {
      console.error("[gateway] Error, retrying in 5s:", err);
      await new Promise((r) => setTimeout(r, 5000));
    }
  }
}

async function startServer(bot: Awaited<ReturnType<typeof createBot>>, port: number) {
  const { createServer } = await import("http");

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://localhost:${port}`);

    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (v) headers.set(k, Array.isArray(v) ? v[0] : v);
    }

    const request = new Request(url.toString(), {
      method: req.method ?? "POST",
      headers,
      body: req.method !== "GET" && req.method !== "HEAD" ? body : undefined,
    });

    // Route: /api/webhooks/{platform}
    const platform = url.pathname.split("/").pop();
    const handler = platform
      ? (bot.webhooks as Record<string, ((r: Request) => Promise<Response>) | undefined>)[platform]
      : undefined;

    if (!handler) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }

    try {
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
    } catch (err) {
      console.error(`[http] Error on ${url.pathname}:`, err);
      res.writeHead(500);
      res.end("Internal error");
    }
  });

  server.listen(port, () => {
    console.log(`🌐 HTTP server listening on http://localhost:${port}`);
  });

  return server;
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
