"use client";

import {
  CheckCircleIcon,
  CircleDashedIcon,
  ListChecksIcon,
  SpinnerGapIcon,
  WarningDiamondIcon,
  XCircleIcon,
} from "@phosphor-icons/react";
import type { ToolUIPart } from "ai";
import { ScaleLoader } from "../../components/ScaleLoader/ScaleLoader";

interface DecompositionStep {
  step_id: string;
  description: string;
  action: string;
  block_name?: string | null;
  status: string;
}

export interface TaskDecompositionOutput {
  type: string;
  message: string;
  goal: string;
  steps: DecompositionStep[];
  step_count: number;
  requires_approval: boolean;
}

export interface DecomposeErrorOutput {
  type: string;
  error?: string;
  message?: string;
}

export type DecomposeGoalOutput =
  | TaskDecompositionOutput
  | DecomposeErrorOutput;

function parseOutput(output: unknown): DecomposeGoalOutput | null {
  if (!output) return null;
  if (typeof output === "string") {
    const trimmed = output.trim();
    if (!trimmed) return null;
    try {
      return parseOutput(JSON.parse(trimmed) as unknown);
    } catch {
      return null;
    }
  }
  if (typeof output === "object") {
    if ("steps" in output && "goal" in output) {
      return output as TaskDecompositionOutput;
    }
    if ("error" in output) {
      return output as DecomposeErrorOutput;
    }
  }
  return null;
}

export function getDecomposeGoalOutput(
  part: unknown,
): DecomposeGoalOutput | null {
  if (!part || typeof part !== "object") return null;
  return parseOutput((part as { output?: unknown }).output);
}

export function isDecompositionOutput(
  output: DecomposeGoalOutput,
): output is TaskDecompositionOutput {
  return "steps" in output && "goal" in output;
}

export function isErrorOutput(
  output: DecomposeGoalOutput,
): output is DecomposeErrorOutput {
  return "error" in output;
}

export function getAnimationText(part: {
  state: ToolUIPart["state"];
  output?: unknown;
}): string {
  switch (part.state) {
    case "input-streaming":
    case "input-available":
      return "Analyzing your goal...";
    case "output-available": {
      const output = parseOutput(part.output);
      if (output && isDecompositionOutput(output))
        return `Plan ready (${output.step_count} steps)`;
      return "Analyzing your goal...";
    }
    case "output-error":
      return "Error analyzing goal";
    default:
      return "Analyzing your goal...";
  }
}

export function ToolIcon({
  isStreaming,
  isError,
}: {
  isStreaming?: boolean;
  isError?: boolean;
}) {
  if (isError) {
    return (
      <WarningDiamondIcon size={14} weight="regular" className="text-red-500" />
    );
  }
  if (isStreaming) {
    return <ScaleLoader size={14} />;
  }
  return (
    <ListChecksIcon size={14} weight="regular" className="text-neutral-400" />
  );
}

export function AccordionIcon() {
  return <ListChecksIcon size={32} weight="light" />;
}

export function StepStatusIcon({ status }: { status: string }) {
  switch (status) {
    case "completed":
      return (
        <CheckCircleIcon size={18} weight="fill" className="text-emerald-500" />
      );
    case "in_progress":
      return (
        <SpinnerGapIcon
          size={18}
          weight="bold"
          className="animate-spin text-blue-500"
        />
      );
    case "failed":
      return <XCircleIcon size={18} weight="fill" className="text-red-500" />;
    default:
      return (
        <CircleDashedIcon
          size={18}
          weight="regular"
          className="text-neutral-400"
        />
      );
  }
}
