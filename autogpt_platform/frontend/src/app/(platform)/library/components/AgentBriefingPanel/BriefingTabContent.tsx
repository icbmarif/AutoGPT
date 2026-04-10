"use client";

import type { CoPilotUsageStatus } from "@/app/api/__generated__/models/coPilotUsageStatus";
import type { LibraryAgent } from "@/app/api/__generated__/models/libraryAgent";
import { useGetV2GetCopilotUsage } from "@/app/api/__generated__/endpoints/chat/chat";
import { UsagePanelContent } from "@/app/(platform)/copilot/components/UsageLimits/UsagePanelContent";
import useCredits from "@/hooks/useCredits";
import { Flag, useGetFlag } from "@/services/feature-flags/use-get-flag";
import { useSitrepItems } from "../SitrepItem/useSitrepItems";
import { SitrepItem } from "../SitrepItem/SitrepItem";
import { useAutoPilotBridge } from "@/contexts/AutoPilotBridgeContext";
import type { AgentStatusFilter } from "../../types";
import { Text } from "@/components/atoms/Text/Text";
import { ContextualActionButton } from "../ContextualActionButton/ContextualActionButton";

interface Props {
  activeTab: AgentStatusFilter;
  agents: LibraryAgent[];
}

export function BriefingTabContent({ activeTab, agents }: Props) {
  if (activeTab === "all") {
    return <UsageSection />;
  }

  if (activeTab === "running" || activeTab === "attention") {
    return <ExecutionListSection activeTab={activeTab} agents={agents} />;
  }

  return <AgentListSection activeTab={activeTab} agents={agents} />;
}

function UsageSection() {
  const { data: usage } = useGetV2GetCopilotUsage({
    query: {
      select: (res) => res.data as CoPilotUsageStatus,
      refetchInterval: 30000,
      staleTime: 10000,
    },
  });

  const isBillingEnabled = useGetFlag(Flag.ENABLE_PLATFORM_PAYMENT);
  const { credits, fetchCredits } = useCredits({ fetchInitialCredits: true });
  const resetCost = usage?.reset_cost;
  const hasInsufficientCredits =
    credits !== null && resetCost != null && credits < resetCost;

  if (!usage?.daily || !usage?.weekly) return null;

  return (
    <div className="mx-auto max-w-md py-2">
      <UsagePanelContent
        usage={usage}
        hasInsufficientCredits={hasInsufficientCredits}
        isBillingEnabled={isBillingEnabled}
        onCreditChange={fetchCredits}
      />
    </div>
  );
}

function ExecutionListSection({
  activeTab,
  agents,
}: {
  activeTab: AgentStatusFilter;
  agents: LibraryAgent[];
}) {
  const allItems = useSitrepItems(agents, 50);
  const { sendPrompt } = useAutoPilotBridge();

  const filtered = allItems.filter((item) => {
    if (activeTab === "running") return item.priority === "running";
    if (activeTab === "attention") return item.priority === "error";
    return false;
  });

  if (filtered.length === 0) {
    return <EmptyMessage />;
  }

  return (
    <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
      {filtered.map((item) => (
        <SitrepItem key={item.id} item={item} onAskAutoPilot={sendPrompt} />
      ))}
    </div>
  );
}

const TAB_STATUS_LABEL: Record<string, string> = {
  listening: "Waiting for trigger event",
  scheduled: "Has a scheduled run",
  idle: "No recent activity",
};

function AgentListSection({
  activeTab,
  agents,
}: {
  activeTab: AgentStatusFilter;
  agents: LibraryAgent[];
}) {
  const filtered = agents.filter((agent) => {
    if (activeTab === "listening") return agent.has_external_trigger;
    if (activeTab === "scheduled") return !!agent.recommended_schedule_cron;
    if (activeTab === "idle")
      return !agent.has_external_trigger && !agent.recommended_schedule_cron;
    return false;
  });

  if (filtered.length === 0) {
    return <EmptyMessage />;
  }

  const status =
    activeTab === "listening"
      ? ("listening" as const)
      : activeTab === "scheduled"
        ? ("scheduled" as const)
        : ("idle" as const);

  return (
    <div className="grid grid-cols-1 gap-1 lg:grid-cols-2">
      {filtered.map((agent) => (
        <div
          key={agent.id}
          className="group flex items-center gap-3 rounded-medium border border-transparent p-3 transition-colors hover:border-zinc-100 hover:bg-zinc-50/50"
        >
          <div className="min-w-0 flex-1">
            <Text variant="body-medium" className="text-zinc-900">
              {agent.name}
            </Text>
            <Text variant="small" className="mt-0.5 text-zinc-500">
              {TAB_STATUS_LABEL[activeTab] ?? ""}
            </Text>
          </div>
          <div className="flex-shrink-0 opacity-0 transition-opacity group-hover:opacity-100">
            <ContextualActionButton status={status} agentID={agent.id} />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyMessage() {
  return (
    <Text variant="body" className="py-4 text-center text-zinc-500">
      No agents in this category.
    </Text>
  );
}
