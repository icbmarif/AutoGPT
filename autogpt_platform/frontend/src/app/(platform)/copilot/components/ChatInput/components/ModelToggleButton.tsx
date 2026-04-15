"use client";

import { cn } from "@/lib/utils";
import { Cpu } from "@phosphor-icons/react";
import type { CopilotLlmModel } from "../../../store";

interface Props {
  model: CopilotLlmModel;
  onToggle: () => void;
  readOnly?: boolean;
}

export function ModelToggleButton({
  model,
  onToggle,
  readOnly = false,
}: Props) {
  const isAdvanced = model === "advanced";
  return (
    <button
      type="button"
      aria-pressed={isAdvanced}
      disabled={readOnly}
      onClick={readOnly ? undefined : onToggle}
      className={cn(
        "inline-flex min-h-11 min-w-11 items-center justify-center gap-1 rounded-md px-2 py-1 text-xs font-medium transition-colors",
        isAdvanced
          ? "bg-sky-100 text-sky-900 hover:bg-sky-200 disabled:hover:bg-sky-100"
          : "bg-neutral-100 text-neutral-700 hover:bg-neutral-200 disabled:hover:bg-neutral-100",
        readOnly && "cursor-default opacity-70",
      )}
      aria-label={
        readOnly
          ? `${isAdvanced ? "Advanced" : "Standard"} model active for this session`
          : isAdvanced
            ? "Switch to Standard model"
            : "Switch to Advanced model"
      }
      title={
        readOnly
          ? `${isAdvanced ? "Advanced" : "Standard"} model active for this session`
          : isAdvanced
            ? "Advanced model — highest capability (click to switch to Standard)"
            : "Standard model — click to switch to Advanced"
      }
    >
      <Cpu size={14} />
      {isAdvanced ? "Advanced" : "Standard"}
    </button>
  );
}
