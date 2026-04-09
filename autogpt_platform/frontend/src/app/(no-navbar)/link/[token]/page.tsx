"use client";

import { Button } from "@/components/atoms/Button/Button";
import { AuthCard } from "@/components/auth/AuthCard";
import { Text } from "@/components/atoms/Text/Text";
import { useSupabase } from "@/lib/supabase/hooks/useSupabase";
import { CheckCircle, LinkBreak, Spinner } from "@phosphor-icons/react";
import { useParams } from "next/navigation";
import { useEffect, useState } from "react";

const PLATFORM_NAMES: Record<string, string> = {
  DISCORD: "Discord",
  TELEGRAM: "Telegram",
  SLACK: "Slack",
  TEAMS: "Teams",
  WHATSAPP: "WhatsApp",
  GITHUB: "GitHub",
  LINEAR: "Linear",
};

type LinkState =
  | { status: "loading" }
  | { status: "not-authenticated" }
  | { status: "ready"; serverName: string | null; platform: string | null }
  | { status: "linking" }
  | { status: "success"; platform: string; serverName: string | null }
  | { status: "error"; message: string };

export default function PlatformLinkPage() {
  const params = useParams();
  const token = params.token as string;
  const { user, isUserLoading, logOut } = useSupabase();

  const [state, setState] = useState<LinkState>({ status: "loading" });

  useEffect(() => {
    if (!token || isUserLoading) return;

    if (!user) {
      setState({ status: "not-authenticated" });
      return;
    }

    void fetchTokenInfo(token).then(({ serverName, platform }) => {
      setState({ status: "ready", serverName, platform });
    });
  }, [token, user, isUserLoading]);

  async function handleLink() {
    const serverName = state.status === "ready" ? state.serverName : null;

    setState({ status: "linking" });

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);

    try {
      const res = await fetch(
        `/api/proxy/api/platform-linking/tokens/${token}/confirm`,
        {
          method: "POST",
          body: JSON.stringify({}),
          headers: { "Content-Type": "application/json" },
          signal: controller.signal,
        },
      );

      if (!res.ok) {
        const data = await res.json().catch(() => null);
        setState({
          status: "error",
          message:
            (data?.detail as string | undefined) ??
            "Failed to complete setup. The link may have expired.",
        });
        return;
      }

      const data = await res.json();
      setState({
        status: "success",
        platform:
          PLATFORM_NAMES[data.platform as string] ?? (data.platform as string),
        serverName: (data.server_name as string | null) ?? serverName,
      });
    } catch (err) {
      setState({
        status: "error",
        message:
          err instanceof DOMException && err.name === "AbortError"
            ? "Request timed out. Please go back to your chat and try again."
            : "Something went wrong. Please try again.",
      });
    } finally {
      clearTimeout(timeout);
    }
  }

  async function handleSwitchAccount() {
    await logOut();
    const loginUrl = `/login?next=${encodeURIComponent(`/link/${token}`)}`;
    window.location.href = loginUrl;
  }

  return (
    <div className="flex h-full min-h-[85vh] flex-col items-center justify-center py-10">
      {state.status === "loading" && <LoadingView />}
      {state.status === "not-authenticated" && (
        <NotAuthenticatedView token={token} />
      )}
      {state.status === "ready" && (
        <ReadyView
          onLink={handleLink}
          onSwitchAccount={handleSwitchAccount}
          serverName={state.serverName}
          platform={state.platform}
          userEmail={user?.email ?? null}
        />
      )}
      {state.status === "linking" && <LinkingView />}
      {state.status === "success" && (
        <SuccessView platform={state.platform} serverName={state.serverName} />
      )}
      {state.status === "error" && <ErrorView message={state.message} />}

      <div className="mt-8 text-center text-xs text-muted-foreground">
        <p>Powered by AutoGPT Platform</p>
      </div>
    </div>
  );
}

async function fetchTokenInfo(
  token: string,
): Promise<{ serverName: string | null; platform: string | null }> {
  try {
    const res = await fetch(
      `/api/proxy/api/platform-linking/tokens/${token}/info`,
      { signal: AbortSignal.timeout(5_000) },
    );
    if (!res.ok) return { serverName: null, platform: null };
    const data = await res.json();
    return {
      serverName: (data.server_name as string | null) ?? null,
      platform:
        PLATFORM_NAMES[(data.platform as string | undefined) ?? ""] ?? null,
    };
  } catch {
    return { serverName: null, platform: null };
  }
}

function LoadingView() {
  return (
    <AuthCard title="Setting up CoPilot">
      <div className="flex flex-col items-center gap-4">
        <Spinner size={48} className="animate-spin text-primary" />
        <Text variant="body-medium" className="text-muted-foreground">
          Loading...
        </Text>
      </div>
    </AuthCard>
  );
}

function NotAuthenticatedView({ token }: { token: string }) {
  const loginUrl = `/login?next=${encodeURIComponent(`/link/${token}`)}`;

  return (
    <AuthCard title="Sign in to continue">
      <div className="flex w-full flex-col items-center gap-6">
        <Text
          variant="body-medium"
          className="text-center text-muted-foreground"
        >
          Sign in to your AutoGPT account to set up CoPilot for your server.
        </Text>
        <Button as="NextLink" href={loginUrl} className="w-full">
          Sign in
        </Button>
        <AuthCard.BottomText
          text="Don't have an account?"
          link={{ text: "Sign up", href: `/signup?next=/link/${token}` }}
        />
      </div>
    </AuthCard>
  );
}

function ReadyView({
  onLink,
  onSwitchAccount,
  serverName,
  platform,
  userEmail,
}: {
  onLink: () => void;
  onSwitchAccount: () => void;
  serverName: string | null;
  platform: string | null;
  userEmail: string | null;
}) {
  const platformLabel = platform ?? "your chat platform";
  const isPersonal = !serverName;
  const title = isPersonal
    ? `Link your ${platformLabel} account`
    : `Set up CoPilot for ${serverName}`;
  const contextLabel = isPersonal
    ? `your ${platformLabel} account`
    : (serverName ?? `this ${platformLabel} group`);

  return (
    <AuthCard title={title}>
      <div className="flex w-full flex-col items-center gap-6">
        <div className="w-full rounded-xl bg-slate-50 p-5 text-left">
          <Text variant="body-medium" className="font-medium">
            What happens when you confirm:
          </Text>
          {isPersonal ? (
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>{contextLabel} will be linked to your AutoGPT account</li>
              <li>You can use CoPilot directly from {platformLabel}</li>
              <li>Your conversations appear in your AutoGPT account</li>
            </ul>
          ) : (
            <ul className="mt-3 space-y-2 text-sm text-muted-foreground">
              <li>{contextLabel} will be connected to your AutoGPT account</li>
              <li>Everyone in the group can chat with CoPilot immediately</li>
              <li>Each person gets their own private conversation</li>
              <li>All conversations appear in your AutoGPT account</li>
            </ul>
          )}
        </div>

        <div className="w-full rounded-xl border border-slate-200 bg-slate-50 p-4">
          <Text variant="small" className="text-muted-foreground">
            Usage from {contextLabel} will be billed to your AutoGPT account.
            You can unlink at any time from your account settings.
          </Text>
        </div>

        <Button onClick={onLink} className="w-full">
          Connect {platformLabel} to AutoGPT
        </Button>

        {userEmail && (
          <div className="flex w-full items-center justify-between">
            <Text variant="small" className="text-muted-foreground">
              Signed in as {userEmail}
            </Text>
            <button
              onClick={onSwitchAccount}
              className="text-xs text-muted-foreground underline underline-offset-2 hover:text-foreground"
            >
              Not you? Sign out
            </button>
          </div>
        )}
      </div>
    </AuthCard>
  );
}

function LinkingView() {
  return (
    <AuthCard title="Connecting...">
      <div className="flex flex-col items-center gap-4">
        <Spinner size={48} className="animate-spin text-primary" />
        <Text variant="body-medium" className="text-muted-foreground">
          Setting up CoPilot for your server...
        </Text>
      </div>
    </AuthCard>
  );
}

function SuccessView({
  platform,
  serverName,
}: {
  platform: string;
  serverName: string | null;
}) {
  const label = serverName ?? `your ${platform} server`;

  return (
    <AuthCard title="CoPilot is ready!">
      <div className="flex w-full flex-col items-center gap-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-green-100">
          <CheckCircle size={40} weight="fill" className="text-green-600" />
        </div>
        <Text
          variant="body-medium"
          className="text-center text-muted-foreground"
        >
          <strong>{label}</strong> is now connected to your AutoGPT account.
          <br />
          Everyone in the server can start using CoPilot right away.
        </Text>
        <Text variant="small" className="text-center text-muted-foreground">
          You can close this page and go back to your chat.
        </Text>
      </div>
    </AuthCard>
  );
}

function ErrorView({ message }: { message: string }) {
  return (
    <AuthCard title="Setup failed">
      <div className="flex w-full flex-col items-center gap-6">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-red-100">
          <LinkBreak size={40} weight="bold" className="text-red-600" />
        </div>
        <Text
          variant="body-medium"
          className="text-center text-muted-foreground"
        >
          {message}
        </Text>
        <Text variant="small" className="text-center text-muted-foreground">
          Go back to your chat and ask the bot for a new setup link.
        </Text>
      </div>
    </AuthCard>
  );
}
