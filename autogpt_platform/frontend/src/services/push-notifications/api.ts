import { environment } from "@/services/environment";

const API_BASE = environment.getAGPTServerBaseUrl();

export async function fetchVapidPublicKey(): Promise<string | null> {
  try {
    const response = await fetch(`${API_BASE}/api/push/vapid-key`);
    if (!response.ok) return null;
    const data = await response.json();
    return data.public_key || null;
  } catch {
    return null;
  }
}

export async function sendSubscriptionToServer(
  subscription: PushSubscription,
  accessToken: string,
): Promise<boolean> {
  const json = subscription.toJSON();
  try {
    const response = await fetch(`${API_BASE}/api/push/subscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({
        endpoint: json.endpoint,
        keys: {
          p256dh: json.keys?.p256dh ?? "",
          auth: json.keys?.auth ?? "",
        },
        user_agent: navigator.userAgent,
      }),
    });
    return response.ok || response.status === 204;
  } catch {
    return false;
  }
}

export async function removeSubscriptionFromServer(
  endpoint: string,
  accessToken: string,
): Promise<boolean> {
  try {
    const response = await fetch(`${API_BASE}/api/push/unsubscribe`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify({ endpoint }),
    });
    return response.ok || response.status === 204;
  } catch {
    return false;
  }
}
