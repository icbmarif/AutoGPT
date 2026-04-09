/**
 * Discord Gateway cron endpoint.
 * Vercel route: GET /api/gateway/discord
 *
 * Discord's Gateway WebSocket requires a persistent connection to receive
 * regular messages. In serverless, this endpoint is called by a cron job
 * every 9 minutes (see vercel.json). It connects, listens for up to 9 minutes,
 * then returns — the next cron invocation picks up immediately.
 *
 * waitUntil is passed so background tasks started by the listener are
 * kept alive until the function returns.
 */

import { getBotInstance } from "../_bot.js";

export const maxDuration = 800; // Vercel max for Pro plan

export async function GET(request: Request): Promise<Response> {
  // Verify cron secret to prevent unauthorized gateway connections
  const authHeader = request.headers.get("authorization");
  if (
    process.env.CRON_SECRET &&
    authHeader !== `Bearer ${process.env.CRON_SECRET}`
  ) {
    return new Response("Unauthorized", { status: 401 });
  }

  const bot = await getBotInstance();
  await bot.initialize();

  const discord = (bot as any).getAdapter("discord");
  if (!discord) {
    return new Response("Discord adapter not configured", { status: 404 });
  }

  const baseUrl = process.env.WEBHOOK_BASE_URL ?? "http://localhost:3000";
  const webhookUrl = `${baseUrl}/api/webhooks/discord`;
  const durationMs = 9 * 60 * 1000; // 9 minutes — matches cron schedule

  // Pass the request context so background tasks stay alive
  return discord.startGatewayListener(request, durationMs, undefined, webhookUrl);
}
