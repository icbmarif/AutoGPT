"use client";

import { Button } from "@/components/atoms/Button/Button";
import {
  EyeIcon,
  ArrowsClockwiseIcon,
  MonitorPlayIcon,
  PlayIcon,
  ArrowCounterClockwiseIcon,
} from "@phosphor-icons/react";
import { useRouter } from "next/navigation";
import type { AgentStatus } from "../../types";

interface Props {
  status: AgentStatus;
  agentID: string;
  executionID?: string;
  className?: string;
}

export function ContextualActionButton({
  status,
  agentID,
  executionID,
  className,
}: Props) {
  const router = useRouter();

  const config = ACTION_CONFIG[status];
  if (!config) return null;

  const Icon = config.icon;

  function handleClick(e: React.MouseEvent) {
    e.preventDefault();
    e.stopPropagation();

    const params = new URLSearchParams();
    if (executionID) params.set("activeItem", executionID);
    const query = params.toString();
    router.push(`/library/agents/${agentID}${query ? `?${query}` : ""}`);
  }

  return (
    <Button
      variant="outline"
      size="small"
      onClick={handleClick}
      leftIcon={<Icon size={14} />}
      className={className}
    >
      {config.label}
    </Button>
  );
}

const ACTION_CONFIG: Record<
  AgentStatus,
  { label: string; icon: typeof EyeIcon }
> = {
  error: { label: "View error", icon: EyeIcon },
  listening: { label: "Reconnect", icon: ArrowsClockwiseIcon },
  running: { label: "Watch live", icon: MonitorPlayIcon },
  idle: { label: "Run now", icon: PlayIcon },
  scheduled: { label: "Run now", icon: ArrowCounterClockwiseIcon },
};
