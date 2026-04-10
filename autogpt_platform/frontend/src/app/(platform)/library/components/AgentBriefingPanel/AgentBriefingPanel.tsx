"use client";

import { Text } from "@/components/atoms/Text/Text";
import { Button } from "@/components/atoms/Button/Button";
import { CaretUpIcon, CaretDownIcon } from "@phosphor-icons/react";
import type { LibraryAgent } from "@/app/api/__generated__/models/libraryAgent";
import { useState } from "react";
import type { FleetSummary, AgentStatusFilter } from "../../types";
import { BriefingTabContent } from "./BriefingTabContent";
import { StatsGrid } from "./StatsGrid";

interface Props {
  summary: FleetSummary;
  agents: LibraryAgent[];
}

export function AgentBriefingPanel({ summary, agents }: Props) {
  const [isCollapsed, setIsCollapsed] = useState(false);
  const defaultTab: AgentStatusFilter = summary.running > 0 ? "running" : "all";
  const [activeTab, setActiveTab] = useState<AgentStatusFilter>(defaultTab);

  return (
    <div className="rounded-large border border-zinc-100 bg-white p-5 shadow-sm">
      <div className="flex items-center justify-between">
        <Text variant="h5">Agent Briefing</Text>
        <Button
          variant="ghost"
          size="icon"
          onClick={() => setIsCollapsed(!isCollapsed)}
          aria-label={isCollapsed ? "Expand briefing" : "Collapse briefing"}
        >
          {isCollapsed ? (
            <CaretDownIcon size={16} />
          ) : (
            <CaretUpIcon size={16} />
          )}
        </Button>
      </div>

      {!isCollapsed && (
        <div className="mt-4 space-y-5">
          <StatsGrid
            summary={summary}
            activeTab={activeTab}
            onTabChange={setActiveTab}
          />
          <BriefingTabContent activeTab={activeTab} agents={agents} />
        </div>
      )}
    </div>
  );
}
