import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  fetchVapidPublicKey,
  removeSubscriptionFromServer,
  sendSubscriptionToServer,
} from "./api";

vi.mock("@/services/environment", () => ({
  environment: {
    getAGPTServerBaseUrl: () => "http://localhost:8006",
  },
}));

describe("fetchVapidPublicKey", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns public key on success", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ public_key: "BFakeKey123" }),
    } as Response);

    const key = await fetchVapidPublicKey();

    expect(key).toBe("BFakeKey123");
    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8006/api/push/vapid-key",
    );
  });

  it("returns null when response is not ok", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const key = await fetchVapidPublicKey();

    expect(key).toBeNull();
  });

  it("returns null when public_key is missing from response", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({}),
    } as Response);

    const key = await fetchVapidPublicKey();

    expect(key).toBeNull();
  });

  it("returns null on network error", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

    const key = await fetchVapidPublicKey();

    expect(key).toBeNull();
  });
});

describe("sendSubscriptionToServer", () => {
  const mockSubscription = {
    toJSON: () => ({
      endpoint: "https://push.example.com/sub/123",
      keys: { p256dh: "key-p256dh", auth: "key-auth" },
    }),
  } as unknown as PushSubscription;

  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends correct payload with auth header", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await sendSubscriptionToServer(mockSubscription, "test-token");

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8006/api/push/subscribe",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          endpoint: "https://push.example.com/sub/123",
          keys: { p256dh: "key-p256dh", auth: "key-auth" },
          user_agent: navigator.userAgent,
        }),
      },
    );
  });

  it("returns true on 200 response", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      status: 200,
    } as Response);

    const result = await sendSubscriptionToServer(
      mockSubscription,
      "test-token",
    );

    expect(result).toBe(true);
  });

  it("returns true on 204 response", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 204,
    } as Response);

    const result = await sendSubscriptionToServer(
      mockSubscription,
      "test-token",
    );

    expect(result).toBe(true);
  });

  it("returns false on failure", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const result = await sendSubscriptionToServer(
      mockSubscription,
      "test-token",
    );

    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

    const result = await sendSubscriptionToServer(
      mockSubscription,
      "test-token",
    );

    expect(result).toBe(false);
  });

  it("handles missing keys gracefully", async () => {
    const subWithoutKeys = {
      toJSON: () => ({
        endpoint: "https://push.example.com/sub/123",
        keys: undefined,
      }),
    } as PushSubscription;

    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await sendSubscriptionToServer(subWithoutKeys, "test-token");

    const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]?.body as string);
    expect(body.keys).toEqual({ p256dh: "", auth: "" });
  });
});

describe("removeSubscriptionFromServer", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sends endpoint with auth header", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    await removeSubscriptionFromServer(
      "https://push.example.com/sub/123",
      "test-token",
    );

    expect(fetch).toHaveBeenCalledWith(
      "http://localhost:8006/api/push/unsubscribe",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer test-token",
        },
        body: JSON.stringify({
          endpoint: "https://push.example.com/sub/123",
        }),
      },
    );
  });

  it("returns true on success", async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as Response);

    const result = await removeSubscriptionFromServer(
      "https://push.example.com/sub/123",
      "test-token",
    );

    expect(result).toBe(true);
  });

  it("returns true on 204 response", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 204,
    } as Response);

    const result = await removeSubscriptionFromServer(
      "https://push.example.com/sub/123",
      "test-token",
    );

    expect(result).toBe(true);
  });

  it("returns false on failure", async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      status: 500,
    } as Response);

    const result = await removeSubscriptionFromServer(
      "https://push.example.com/sub/123",
      "test-token",
    );

    expect(result).toBe(false);
  });

  it("returns false on network error", async () => {
    vi.mocked(fetch).mockRejectedValue(new Error("Network error"));

    const result = await removeSubscriptionFromServer(
      "https://push.example.com/sub/123",
      "test-token",
    );

    expect(result).toBe(false);
  });
});
