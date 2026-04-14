/**
 * Discord interaction handlers — slash commands and button actions.
 *
 * Register new handlers here via `registerHandlers()`. Each command also
 * needs to be declared in `src/scripts/register-discord-commands.ts` so
 * Discord surfaces it in the slash command picker.
 */

import { PlatformAPIError } from "../platform-api.js";
import { InteractionRegistry, type InteractionContext } from "./interactions.js";

export function registerHandlers(registry: InteractionRegistry): void {
  registry
    .command("setup", handleSetup)
    .command("help", handleHelp)
    .command("unlink", handleUnlink);
  // Component handlers (buttons/menus/modals) go here when we add UI that
  // needs them, e.g.:
  //   .component("my-button:", handleMyButton)
  //   .modal("my-form", handleMyForm);
}

// ── /setup ───────────────────────────────────────────────────────────────────

async function handleSetup(ctx: InteractionContext): Promise<void> {
  // /setup claims a server. Running it in a DM would create a SERVER link
  // with server_id="@me" which is nonsense — reject with clear guidance.
  if (ctx.guildId === "@me") {
    await ctx.respond(
      "Run `/setup` inside a server to link it. For 1:1 DM conversations " +
        "with AutoPilot, just message me in this DM — I'll send you a " +
        "personal link automatically.",
      { ephemeral: true },
    );
    return;
  }

  await ctx.defer({ ephemeral: true });

  try {
    const link = await ctx.api.createLinkToken({
      platform: "discord",
      platformServerId: ctx.guildId,
      platformUserId: ctx.user.id,
      platformUsername: ctx.user.global_name ?? ctx.user.username,
    });

    await ctx.edit(
      `Click to link this server to your AutoGPT account:\n${link.link_url}\n\nThis link expires in 30 minutes. Once linked, everyone here can chat with AutoPilot — all usage bills to your AutoGPT account.`,
    );
  } catch (err) {
    if (err instanceof PlatformAPIError && err.status === 409) {
      await ctx.edit(
        "This server is already linked to an AutoGPT account. Mention me to chat with AutoPilot.",
      );
      return;
    }
    console.error("[bot] /setup error:", err);
    await ctx.edit(
      "Sorry, I couldn't generate a setup link right now. Please try again later.",
    );
  }
}

// ── /help ────────────────────────────────────────────────────────────────────

async function handleHelp(ctx: InteractionContext): Promise<void> {
  await ctx.respond(HELP_TEXT, { ephemeral: true });
}

const HELP_TEXT =
  "**AutoPilot** — Your AutoGPT assistant\n\n" +
  "**Getting started:**\n" +
  "• Run `/setup` to link this server to an AutoGPT account (ephemeral link)\n" +
  "• Once linked, mention me to chat — everyone in the server can use AutoPilot\n" +
  "• Each person gets their own private conversation, all visible in the setup owner's AutoGPT account\n\n" +
  "**Slash commands:**\n" +
  "• `/setup` — link this server (owner claim)\n" +
  "• `/unlink` — manage linked servers\n" +
  "• `/help` — this message";

// ── /unlink ──────────────────────────────────────────────────────────────────

async function handleUnlink(ctx: InteractionContext): Promise<void> {
  // Unlinking requires JWT auth on the backend. Punt to the settings page
  // where the user can review all their linked servers and remove them.
  const base =
    process.env.AUTOGPT_FRONTEND_URL ?? "https://platform.agpt.co";
  const settingsUrl = `${base.replace(/\/$/, "")}/profile/settings`;
  await ctx.respond(
    `To unlink servers, manage them in your AutoGPT settings:\n${settingsUrl}\n\nYou can see all servers billed to your account there and remove any of them.`,
    { ephemeral: true },
  );
}

// ── Button: end session ──────────────────────────────────────────────────────

// No component handlers yet. Add new button/select/modal handlers here and
// register them in registerHandlers() above.
