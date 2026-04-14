/**
 * Discord interaction dispatcher.
 *
 * Provides a uniform handler API for:
 *   - slash commands (`/setup`, `/help`, ...)
 *   - message components (button clicks, select menus)
 *   - modal submissions
 *
 * Handlers receive an `InteractionContext` with helpers that wrap Discord's
 * callback API, so individual handlers never touch raw HTTP.
 *
 * Works with both deployment modes:
 *   - Standalone (Gateway WS → forwarded to our webhook as GATEWAY_INTERACTION_CREATE)
 *   - Serverless (Discord posts signed interaction directly — Chat SDK verifies,
 *     we intercept before SDK drops non-message events)
 */

import type { PlatformAPI } from "../platform-api.js";
import {
  InteractionType,
  ResponseType,
  MessageFlag,
  type Component,
  type DiscordInteraction,
  type DiscordUser,
} from "./types.js";

const DISCORD_API = "https://discord.com/api/v10";

/**
 * Fetch helper that never throws but surfaces non-2xx Discord responses in
 * logs so 429s, invalid tokens, expired interactions, etc. are visible
 * instead of silently swallowed.
 */
async function discordFetch(
  url: string,
  init: RequestInit,
  label: string,
): Promise<void> {
  try {
    const res = await fetch(url, init);
    if (res.ok) return;
    const body = await res.text().catch(() => "<unreadable>");
    console.error(
      `[bot] Discord ${label} ${init.method ?? "GET"} ${url} failed: ` +
        `${res.status} ${res.statusText} — ${body.slice(0, 500)}`,
    );
  } catch (err) {
    console.error(
      `[bot] Discord ${label} ${init.method ?? "GET"} ${url} threw:`,
      err,
    );
  }
}

export interface InteractionContext {
  /** Raw Discord interaction payload (escape hatch). */
  readonly raw: DiscordInteraction;
  /** The user who triggered this interaction. */
  readonly user: DiscordUser;
  /** Guild ID, or "@me" for DMs. */
  readonly guildId: string;
  /** Channel where the interaction happened. */
  readonly channelId: string | undefined;
  /** Backend API client. */
  readonly api: PlatformAPI;

  /** For components: the custom_id of the clicked button/menu. */
  readonly customId?: string;
  /** For slash commands: the command name (without leading slash). */
  readonly commandName?: string;

  /** Send an immediate response (within 3s of Discord sending the interaction). */
  respond(content: string, opts?: RespondOpts): Promise<void>;
  /** ACK now, edit the response later. Required if the handler takes >2s. */
  defer(opts?: DeferOpts): Promise<void>;
  /** Edit the original (deferred or sent) response. 15 min window. */
  edit(content: string, opts?: EditOpts): Promise<void>;
  /** For message components: update the clicked message in place. */
  update(content: string, opts?: EditOpts): Promise<void>;
  /** Send an extra message as a followup. */
  followup(content: string, opts?: RespondOpts): Promise<void>;
}

export interface RespondOpts {
  ephemeral?: boolean;
  components?: Component[];
}

export interface DeferOpts {
  ephemeral?: boolean;
}

export interface EditOpts {
  components?: Component[];
}

export type CommandHandler = (ctx: InteractionContext) => Promise<void>;
export type ComponentHandler = (ctx: InteractionContext) => Promise<void>;
export type ModalHandler = (ctx: InteractionContext) => Promise<void>;

/**
 * Registry of handlers. Component handlers can use either an exact custom_id
 * or a prefix (ending with ':') to match dynamic IDs like "end-session:{sid}".
 */
export class InteractionRegistry {
  private commands = new Map<string, CommandHandler>();
  private componentExact = new Map<string, ComponentHandler>();
  private componentPrefix = new Map<string, ComponentHandler>();
  private modals = new Map<string, ModalHandler>();

  command(name: string, handler: CommandHandler): this {
    this.commands.set(name, handler);
    return this;
  }

  /**
   * Register a button/select handler.
   * `customId` ending with ':' matches any custom_id starting with that prefix.
   */
  component(customId: string, handler: ComponentHandler): this {
    if (customId.endsWith(":")) this.componentPrefix.set(customId, handler);
    else this.componentExact.set(customId, handler);
    return this;
  }

  modal(customId: string, handler: ModalHandler): this {
    this.modals.set(customId, handler);
    return this;
  }

  resolveCommand(name: string): CommandHandler | undefined {
    return this.commands.get(name);
  }

  resolveComponent(customId: string): ComponentHandler | undefined {
    const exact = this.componentExact.get(customId);
    if (exact) return exact;
    for (const [prefix, handler] of this.componentPrefix) {
      if (customId.startsWith(prefix)) return handler;
    }
    return undefined;
  }

  resolveModal(customId: string): ModalHandler | undefined {
    return this.modals.get(customId);
  }
}

/**
 * Attempt to handle an incoming webhook request as a Gateway-forwarded Discord
 * interaction. Returns a Response if handled, null to let the Chat SDK's
 * default handler process the request.
 */
export async function tryDispatchInteraction(
  request: Request,
  registry: InteractionRegistry,
  api: PlatformAPI,
): Promise<Response | null> {
  const bodyText = await request.clone().text();
  let event: { type?: string; data?: DiscordInteraction };
  try {
    event = JSON.parse(bodyText);
  } catch {
    return null;
  }

  if (event.type !== "GATEWAY_INTERACTION_CREATE" || !event.data) {
    return null;
  }

  const interaction = event.data;
  // Fire-and-forget so the forwarder gets a 200 immediately. If dispatch
  // throws we can't let it vanish — try to post a best-effort error
  // response to Discord so the invoker sees something instead of a silent
  // "application did not respond" or partial UI state.
  void (async () => {
    try {
      await dispatch(interaction, registry, api);
    } catch (err) {
      console.error("[bot] Interaction dispatch error:", err);
      await discordFetch(
        `${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: ResponseType.ChannelMessageWithSource,
            data: {
              content: "Something went wrong handling that interaction. Please try again.",
              flags: MessageFlag.Ephemeral,
            },
          }),
        },
        "dispatch-error-fallback",
      );
    }
  })();
  return new Response(JSON.stringify({ ok: true }), { status: 200 });
}

async function dispatch(
  interaction: DiscordInteraction,
  registry: InteractionRegistry,
  api: PlatformAPI,
): Promise<void> {
  const ctx = buildContext(interaction, api);

  switch (interaction.type) {
    case InteractionType.ApplicationCommand: {
      const name = interaction.data?.name;
      const handler = name ? registry.resolveCommand(name) : undefined;
      if (!handler) {
        await ctx.respond(`Unknown command: /${name}`, { ephemeral: true });
        return;
      }
      console.log(
        `[bot] /${name} invoked in server ${ctx.guildId} by ${ctx.user.id}`,
      );
      await handler({ ...ctx, commandName: name });
      return;
    }
    case InteractionType.MessageComponent: {
      const customId = interaction.data?.custom_id ?? "";
      const handler = registry.resolveComponent(customId);
      if (!handler) {
        await ctx.respond("This button is no longer active.", { ephemeral: true });
        return;
      }
      console.log(
        `[bot] component "${customId}" clicked in server ${ctx.guildId} by ${ctx.user.id}`,
      );
      await handler({ ...ctx, customId });
      return;
    }
    case InteractionType.ModalSubmit: {
      const customId = interaction.data?.custom_id ?? "";
      const handler = registry.resolveModal(customId);
      if (!handler) {
        await ctx.respond("This form is no longer active.", { ephemeral: true });
        return;
      }
      await handler({ ...ctx, customId });
      return;
    }
    default:
      // Autocomplete (4) and anything else — always respond so Discord
      // doesn't show "application did not respond" to the invoker.
      console.warn(`[bot] Unhandled interaction type: ${interaction.type}`);
      await ctx
        .respond("This interaction type isn't supported yet.", {
          ephemeral: true,
        })
        .catch((err) =>
          console.error(
            "[bot] Failed to respond to unhandled interaction:",
            err,
          ),
        );
  }
}

function buildContext(
  interaction: DiscordInteraction,
  api: PlatformAPI,
): InteractionContext {
  const user = interaction.member?.user ?? interaction.user;
  if (!user) throw new Error("Interaction has no user");

  const guildId = interaction.guild_id ?? "@me";
  const channelId = interaction.channel_id;

  const callbackUrl = `${DISCORD_API}/interactions/${interaction.id}/${interaction.token}/callback`;
  const webhookUrl = `${DISCORD_API}/webhooks/${interaction.application_id}/${interaction.token}`;

  return {
    raw: interaction,
    user,
    guildId,
    channelId,
    api,

    async respond(content, opts = {}) {
      await discordFetch(
        callbackUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: ResponseType.ChannelMessageWithSource,
            data: {
              content,
              flags: opts.ephemeral ? MessageFlag.Ephemeral : 0,
              components: opts.components,
            },
          }),
        },
        "respond",
      );
    },

    async defer(opts = {}) {
      await discordFetch(
        callbackUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: ResponseType.DeferredChannelMessageWithSource,
            data: { flags: opts.ephemeral ? MessageFlag.Ephemeral : 0 },
          }),
        },
        "defer",
      );
    },

    async edit(content, opts = {}) {
      await discordFetch(
        `${webhookUrl}/messages/@original`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            components: opts.components,
          }),
        },
        "edit",
      );
    },

    async update(content, opts = {}) {
      await discordFetch(
        callbackUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            type: ResponseType.UpdateMessage,
            data: { content, components: opts.components },
          }),
        },
        "update",
      );
    },

    async followup(content, opts = {}) {
      await discordFetch(
        webhookUrl,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content,
            flags: opts.ephemeral ? MessageFlag.Ephemeral : 0,
            components: opts.components,
          }),
        },
        "followup",
      );
    },
  };
}
