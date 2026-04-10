"use client";

import { useGetV1ListAllExecutions } from "@/app/api/__generated__/endpoints/graphs/graphs";
import { AgentExecutionStatus } from "@/app/api/__generated__/models/agentExecutionStatus";
import type { GraphExecutionMeta } from "@/app/api/__generated__/models/graphExecutionMeta";
import type { LibraryAgent } from "@/app/api/__generated__/models/libraryAgent";
import { okData } from "@/app/api/helpers";
import { useMemo } from "react";
import type { SitrepItemData, SitrepPriority } from "./SitrepItem";

const SEVENTY_TWO_HOURS_MS = 72 * 60 * 60 * 1000;

export function useSitrepItems(
  agents: LibraryAgent[],
  maxItems: number,
): SitrepItemData[] {
  const { data: executions } = useGetV1ListAllExecutions({
    query: { select: okData },
  });

  return useMemo(() => {
    if (!executions || agents.length === 0) return [];

    const graphIdToAgent = new Map(agents.map((a) => [a.graph_id, a]));
    const agentExecutions = groupByAgent(executions, graphIdToAgent);
    const items: SitrepItemData[] = [];

    for (const [agent, execs] of agentExecutions) {
      const item = buildSitrepFromExecutions(agent, execs);
      if (item) items.push(item);
    }

    const order: Record<SitrepPriority, number> = {
      error: 0,
      running: 1,
      stale: 2,
      success: 3,
    };
    items.sort((a, b) => order[a.priority] - order[b.priority]);

    return items.slice(0, maxItems);
  }, [agents, executions, maxItems]);
}

function groupByAgent(
  executions: GraphExecutionMeta[],
  graphIdToAgent: Map<string, LibraryAgent>,
): Map<LibraryAgent, GraphExecutionMeta[]> {
  const map = new Map<LibraryAgent, GraphExecutionMeta[]>();

  for (const exec of executions) {
    const agent = graphIdToAgent.get(exec.graph_id);
    if (!agent) continue;
    const list = map.get(agent);
    if (list) {
      list.push(exec);
    } else {
      map.set(agent, [exec]);
    }
  }

  return map;
}

function buildSitrepFromExecutions(
  agent: LibraryAgent,
  executions: GraphExecutionMeta[],
): SitrepItemData | null {
  const active = executions.find((e) => isActive(e.status));
  if (active) {
    return {
      id: `${agent.id}-${active.id}`,
      agentID: agent.id,
      agentName: agent.name,
      executionID: active.id,
      priority: "running",
      message:
        active.stats?.activity_status ??
        runningMessage(active.status, active.started_at),
      status: "running",
    };
  }

  const cutoff = Date.now() - SEVENTY_TWO_HOURS_MS;
  const recent = executions
    .filter((e) => endedAfter(e, cutoff))
    .sort((a, b) => toEndTime(b) - toEndTime(a));

  const lastFailed = recent.find((e) => isFailed(e.status));
  if (lastFailed) {
    const errorMsg =
      lastFailed.stats?.error ??
      lastFailed.stats?.activity_status ??
      "Execution failed";
    return {
      id: `${agent.id}-${lastFailed.id}`,
      agentID: agent.id,
      agentName: agent.name,
      executionID: lastFailed.id,
      priority: "error",
      message: typeof errorMsg === "string" ? errorMsg : "Execution failed",
      status: "error",
    };
  }

  const lastCompleted = recent.find(
    (e) => e.status === AgentExecutionStatus.COMPLETED,
  );
  if (lastCompleted) {
    const summary =
      lastCompleted.stats?.activity_status ?? "Completed successfully";
    return {
      id: `${agent.id}-${lastCompleted.id}`,
      agentID: agent.id,
      agentName: agent.name,
      executionID: lastCompleted.id,
      priority: "success",
      message: typeof summary === "string" ? summary : "Completed successfully",
      status: "idle",
    };
  }

  return null;
}

function isActive(status: AgentExecutionStatus): boolean {
  return (
    status === AgentExecutionStatus.RUNNING ||
    status === AgentExecutionStatus.QUEUED ||
    status === AgentExecutionStatus.REVIEW
  );
}

function isFailed(status: AgentExecutionStatus): boolean {
  return (
    status === AgentExecutionStatus.FAILED ||
    status === AgentExecutionStatus.TERMINATED
  );
}

function runningMessage(
  status: AgentExecutionStatus,
  startedAt?: string | Date | null,
): string {
  if (status === AgentExecutionStatus.QUEUED) return "Queued for execution";
  if (status === AgentExecutionStatus.REVIEW) return "Awaiting review";
  if (!startedAt) return "Currently executing";
  const ms =
    Date.now() -
    (startedAt instanceof Date
      ? startedAt.getTime()
      : new Date(startedAt).getTime());
  return `Running for ${formatRelativeDuration(ms)}`;
}

function formatRelativeDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return "a few seconds";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMin = minutes % 60;
  if (hours < 24)
    return remainingMin > 0 ? `${hours}h ${remainingMin}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

function endedAfter(exec: GraphExecutionMeta, cutoff: number): boolean {
  if (!exec.ended_at) return false;
  return toEndTime(exec) > cutoff;
}

function toEndTime(exec: GraphExecutionMeta): number {
  if (!exec.ended_at) return 0;
  return exec.ended_at instanceof Date
    ? exec.ended_at.getTime()
    : new Date(exec.ended_at).getTime();
}
