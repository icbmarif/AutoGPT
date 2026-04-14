/**
 * Client for the AutoGPT Platform Linking & Chat APIs.
 *
 * The bot never handles AutoGPT user IDs — it only passes platform server IDs
 * and platform user IDs. The backend resolves the owner internally.
 */

const DEFAULT_TIMEOUT_MS = 30_000;
// Idle timeout: abort only if no data arrives for this long. Backend sends
// `: keepalive\n\n` every 30s, so 90s gives 3 missed keepalives of headroom.
// CoPilot turns can legitimately take many minutes — a hard deadline would kill
// long-running tool calls mid-flight.
const SSE_IDLE_TIMEOUT_MS = 90_000;

export class PlatformAPIError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "PlatformAPIError";
  }
}

export interface ResolveResult {
  linked: boolean;
}

export interface LinkTokenResult {
  token: string;
  expires_at: string;
  link_url: string;
}

export interface LinkTokenStatus {
  status: "pending" | "linked" | "expired";
}

export class PlatformAPI {
  private readonly botApiKey: string;

  constructor(private readonly baseUrl: string) {
    const key = process.env.PLATFORM_BOT_API_KEY;
    if (!key) {
      throw new Error(
        "PLATFORM_BOT_API_KEY is required. Set it in your .env file.",
      );
    }
    this.botApiKey = key;
  }

  /**
   * Check if a platform server is linked to an AutoGPT account.
   * Pass platformUserId in DM contexts so the backend can fall back to
   * owner lookup — prevents re-auth for users already linked via a server.
   */
  async resolve(
    platform: string,
    platformServerId: string,
    platformUserId?: string,
  ): Promise<ResolveResult> {
    const res = await fetch(`${this.baseUrl}/api/platform-linking/resolve`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        platform: platform.toUpperCase(),
        platform_server_id: platformServerId,
        platform_user_id: platformUserId,
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new PlatformAPIError(res.status, await res.text());
    }

    return res.json();
  }

  /**
   * Create a link token for an unlinked server.
   * platform_user_id is the person who triggered the interaction —
   * they become the server owner when they confirm.
   */
  async createLinkToken(params: {
    platform: string;
    platformServerId: string;
    platformUserId: string;
    platformUsername?: string;
    serverName?: string;
    channelId?: string;
  }): Promise<LinkTokenResult> {
    const res = await fetch(`${this.baseUrl}/api/platform-linking/tokens`, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        platform: params.platform.toUpperCase(),
        platform_server_id: params.platformServerId,
        platform_user_id: params.platformUserId,
        platform_username: params.platformUsername,
        server_name: params.serverName,
        channel_id: params.channelId,
      }),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });

    if (!res.ok) {
      throw new PlatformAPIError(res.status, await res.text());
    }

    return res.json();
  }

  /** Check if a link token has been consumed (user completed linking). */
  async getLinkTokenStatus(token: string): Promise<LinkTokenStatus> {
    const res = await fetch(
      `${this.baseUrl}/api/platform-linking/tokens/${encodeURIComponent(token)}/status`,
      {
        headers: this.headers(),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      throw new PlatformAPIError(res.status, await res.text());
    }

    return res.json();
  }

  /**
   * Create a new CoPilot session for a user in a linked server.
   * The session is owned by the server owner's AutoGPT account.
   */
  async createChatSession(
    platform: string,
    platformServerId: string,
    platformUserId: string,
  ): Promise<string> {
    const res = await fetch(
      `${this.baseUrl}/api/platform-linking/chat/session`,
      {
        method: "POST",
        headers: this.headers(),
        body: JSON.stringify({
          platform: platform.toUpperCase(),
          platform_server_id: platformServerId,
          platform_user_id: platformUserId,
          message: "session_init",
        }),
        signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
      },
    );

    if (!res.ok) {
      throw new PlatformAPIError(res.status, await res.text());
    }

    const data = await res.json();
    return data.session_id as string;
  }

  /**
   * Stream a chat message to CoPilot on behalf of a user in a linked server.
   * Yields text chunks from the SSE stream.
   */
  async *streamChat(
    platform: string,
    platformServerId: string,
    platformUserId: string,
    message: string,
    sessionId?: string,
  ): AsyncGenerator<string> {
    const abort = new AbortController();
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const resetIdleTimer = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abort.abort(), SSE_IDLE_TIMEOUT_MS);
    };
    resetIdleTimer();

    let res: Response;
    try {
      res = await fetch(`${this.baseUrl}/api/platform-linking/chat/stream`, {
        method: "POST",
        headers: { ...this.headers(), Accept: "text/event-stream" },
        body: JSON.stringify({
          platform: platform.toUpperCase(),
          platform_server_id: platformServerId,
          platform_user_id: platformUserId,
          message,
          session_id: sessionId,
        }),
        signal: abort.signal,
      });
    } catch (err) {
      if (idleTimer) clearTimeout(idleTimer);
      throw err;
    }

    if (!res.ok) {
      if (idleTimer) clearTimeout(idleTimer);
      throw new PlatformAPIError(res.status, await res.text());
    }

    if (!res.body) {
      if (idleTimer) clearTimeout(idleTimer);
      throw new PlatformAPIError(0, "No response body for SSE stream");
    }

    const decoder = new TextDecoder();
    const reader = res.body.getReader();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        resetIdleTimer();
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;

          const data = line.slice(6).trim();
          if (data === "[DONE]") return;

          try {
            const parsed = JSON.parse(data) as Record<string, unknown>;
            if (parsed.type === "text-delta" && parsed.delta) {
              yield parsed.delta as string;
            } else if (parsed.type === "error" && parsed.content) {
              yield `Error: ${parsed.content as string}`;
            }
          } catch {
            // Non-JSON line — skip
          }
        }
      }
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      reader.releaseLock();
    }
  }

  private headers(): Record<string, string> {
    return {
      "Content-Type": "application/json",
      "X-Bot-API-Key": this.botApiKey,
    };
  }
}
