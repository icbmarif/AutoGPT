"use client";

import { Text } from "@/components/atoms/Text/Text";
import { Emoji } from "@/components/atoms/Emoji/Emoji";
import { cn } from "@/lib/utils";
import type { FleetSummary, AgentStatusFilter } from "../../types";

interface Props {
  summary: FleetSummary;
  activeTab: AgentStatusFilter;
  onTabChange: (tab: AgentStatusFilter) => void;
}

const TILES: {
  label: string;
  key: keyof FleetSummary;
  format?: (v: number) => string;
  filter: AgentStatusFilter;
  emoji: string;
  color: string;
}[] = [
  {
    label: "Spent this month",
    key: "monthlySpend",
    format: (v) => `$${v.toLocaleString()}`,
    filter: "all",
    emoji: "💵",
    color: "text-zinc-700",
  },
  {
    label: "Running now",
    key: "running",
    filter: "running",
    emoji: "🏃",
    color: "text-blue-600",
  },
  {
    label: "Needs attention",
    key: "error",
    filter: "attention",
    emoji: "⚠️",
    color: "text-red-500",
  },
  {
    label: "Listening",
    key: "listening",
    filter: "listening",
    emoji: "👂",
    color: "text-purple-500",
  },
  {
    label: "Scheduled",
    key: "scheduled",
    filter: "scheduled",
    emoji: "📅",
    color: "text-yellow-600",
  },
  {
    label: "Idle",
    key: "idle",
    filter: "idle",
    emoji: "💤",
    color: "text-zinc-400",
  },
];

export function StatsGrid({ summary, activeTab, onTabChange }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
      {TILES.map((tile) => {
        const rawValue = summary[tile.key];
        const value = tile.format ? tile.format(rawValue) : rawValue;
        const isActive = activeTab === tile.filter;
        const isEmpty = rawValue === 0 && tile.filter !== "all";

        return (
          <button
            key={tile.label}
            type="button"
            disabled={isEmpty}
            onClick={() => onTabChange(tile.filter)}
            className={cn(
              "flex flex-col gap-1 rounded-medium border p-3 text-left transition-all",
              isEmpty ? "cursor-default" : "hover:shadow-sm",
              isActive
                ? "border-zinc-900 bg-zinc-50"
                : "border-zinc-100 bg-white",
            )}
          >
            <div className="flex items-center gap-1.5">
              <Emoji text={tile.emoji} size={14} />
              <Text variant="body" className="text-zinc-600">
                {tile.label}
              </Text>
            </div>
            <Text variant="h4">{value}</Text>
          </button>
        );
      })}
    </div>
  );
}
