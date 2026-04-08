"use client";

import { Button } from "@/components/atoms/Button/Button";
import { CheckIcon, PencilSimpleIcon } from "@phosphor-icons/react";
import type { ToolUIPart } from "ai";
import { useCopilotChatActions } from "../../components/CopilotChatActionsProvider/useCopilotChatActions";
import { MorphingTextAnimation } from "../../components/MorphingTextAnimation/MorphingTextAnimation";
import {
  ContentGrid,
  ContentHint,
  ContentMessage,
} from "../../components/ToolAccordion/AccordionContent";
import { ToolAccordion } from "../../components/ToolAccordion/ToolAccordion";
import { ToolErrorCard } from "../../components/ToolErrorCard/ToolErrorCard";
import { StepItem } from "./components/StepItem";
import {
  AccordionIcon,
  getAnimationText,
  getDecomposeGoalOutput,
  isDecompositionOutput,
  isErrorOutput,
  ToolIcon,
} from "./helpers";

interface Props {
  part: ToolUIPart;
}

export function DecomposeGoalTool({ part }: Props) {
  const text = getAnimationText(part);
  const { onSend } = useCopilotChatActions();

  const isStreaming =
    part.state === "input-streaming" || part.state === "input-available";

  const output = getDecomposeGoalOutput(part);

  const isError =
    part.state === "output-error" || (!!output && isErrorOutput(output));

  const isOperating = !output;

  function handleApprove() {
    onSend("Approved. Please build the agent.");
  }

  function handleModify() {
    onSend("I'd like to modify the plan. Here are my changes: ");
  }

  return (
    <div className="py-2">
      {isOperating && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ToolIcon isStreaming={isStreaming} isError={isError} />
          <MorphingTextAnimation
            text={text}
            className={isError ? "text-red-500" : undefined}
          />
        </div>
      )}

      {isError && output && isErrorOutput(output) && (
        <ToolErrorCard
          message={output.message ?? ""}
          fallbackMessage="Failed to analyze the goal. Please try again."
          actions={[
            {
              label: "Try again",
              onClick: () => onSend("Please try decomposing the goal again."),
            },
          ]}
        />
      )}

      {output && isDecompositionOutput(output) && (
        <ToolAccordion
          icon={<AccordionIcon />}
          title={`Build Plan — ${output.step_count} steps`}
          description={output.goal}
          defaultExpanded
        >
          <ContentGrid>
            <ContentMessage>{output.message}</ContentMessage>

            <div className="space-y-0.5 rounded-lg border border-slate-200 bg-white p-3">
              {output.steps.map((step, i) => (
                <StepItem
                  key={step.step_id}
                  index={i}
                  description={step.description}
                  action={step.action}
                  blockName={step.block_name}
                  status={step.status}
                />
              ))}
            </div>

            {output.requires_approval && (
              <div className="flex items-center gap-2 pt-1">
                <Button variant="primary" onClick={handleApprove}>
                  <span className="inline-flex items-center gap-1.5">
                    <CheckIcon size={14} weight="bold" />
                    Approve
                  </span>
                </Button>
                <Button variant="ghost" onClick={handleModify}>
                  <span className="inline-flex items-center gap-1.5">
                    <PencilSimpleIcon size={14} weight="bold" />
                    Modify
                  </span>
                </Button>
              </div>
            )}

            <ContentHint>
              Review the plan above and approve to start building.
            </ContentHint>
          </ContentGrid>
        </ToolAccordion>
      )}
    </div>
  );
}
