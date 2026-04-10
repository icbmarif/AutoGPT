"use client";

import { Button } from "@/components/atoms/Button/Button";
import {
  CheckIcon,
  PencilSimpleIcon,
  PlusIcon,
  TrashIcon,
} from "@phosphor-icons/react";
import type { ToolUIPart } from "ai";
import { useEffect, useRef, useState } from "react";
import { useCopilotChatActions } from "../../components/CopilotChatActionsProvider/useCopilotChatActions";
import { MorphingTextAnimation } from "../../components/MorphingTextAnimation/MorphingTextAnimation";
import {
  ContentGrid,
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
  type DecomposeGoalOutput,
} from "./helpers";

// Fallback used only if the backend response omits auto_approve_seconds
// (older sessions). The authoritative value comes from the tool output.
const FALLBACK_COUNTDOWN_SECONDS = 60;
const RADIUS = 15;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/**
 * Compute remaining countdown seconds, deriving elapsed time from the
 * backend-stamped ``created_at`` so the timer reflects real elapsed time
 * when the user reopens the session — instead of restarting from full.
 *
 * Falls back to the full countdown when ``created_at`` is missing (older
 * sessions stored before this field existed) or unparseable. Clamps to
 * ``[0, total]`` to defend against client clock skew producing future
 * timestamps.
 */
function computeRemainingSeconds(
  output: DecomposeGoalOutput | null,
  fallback: number,
): number {
  if (!output || !isDecompositionOutput(output)) return fallback;
  const total = output.auto_approve_seconds ?? fallback;
  if (!output.created_at) return total;
  const createdAtMs = new Date(output.created_at).getTime();
  if (Number.isNaN(createdAtMs)) return total;
  const elapsedSec = (Date.now() - createdAtMs) / 1000;
  return Math.max(0, Math.min(total, Math.round(total - elapsedSec)));
}

interface EditableStep {
  step_id: string;
  description: string;
  action: string;
  block_name?: string | null;
  status: string;
}

interface Props {
  part: ToolUIPart;
  isLastMessage?: boolean;
  // True while the parent assistant message is still streaming. We disable
  // Approve/Modify in this window because the chat session is locked to
  // the in-flight turn — sending a new user message would fail.
  isMessageStreaming?: boolean;
}

export function DecomposeGoalTool({
  part,
  isLastMessage,
  isMessageStreaming,
}: Props) {
  const text = getAnimationText(part);
  const { onSend } = useCopilotChatActions();

  const isStreaming =
    part.state === "input-streaming" || part.state === "input-available";

  const output = getDecomposeGoalOutput(part);
  const isError =
    part.state === "output-error" || (!!output && isErrorOutput(output));
  const isPending = !output && !isError;

  const showActions =
    !!isLastMessage &&
    !!output &&
    isDecompositionOutput(output) &&
    output.requires_approval;

  // The Approve/Modify buttons are visible (so the user knows what's
  // coming) but click-disabled while the assistant is still streaming
  // its summary text after the tool call. The countdown ring keeps
  // ticking so it stays in sync with the server-side timer.
  const actionsEnabled = showActions && !isMessageStreaming;

  // Authoritative countdown comes from the backend tool response so the
  // server-side fallback timer and the client are guaranteed to agree.
  const countdownSeconds =
    (output && isDecompositionOutput(output) && output.auto_approve_seconds) ||
    FALLBACK_COUNTDOWN_SECONDS;

  // Lazy initializer: runs once on mount and seeds remaining time from the
  // backend ``created_at`` so reopening a session resumes the countdown
  // instead of restarting it.
  const [secondsLeft, setSecondsLeft] = useState(() =>
    computeRemainingSeconds(output, FALLBACK_COUNTDOWN_SECONDS),
  );
  // timerActive becomes false when the user clicks Modify — stops countdown and auto-approve.
  const [timerActive, setTimerActive] = useState(true);
  const [isEditing, setIsEditing] = useState(false);
  const [editableSteps, setEditableSteps] = useState<EditableStep[]>([]);

  const approvedRef = useRef(false);
  const onSendRef = useRef(onSend);
  const isEditingRef = useRef(isEditing);
  const editableStepsRef = useRef(editableSteps);
  onSendRef.current = onSend;
  isEditingRef.current = isEditing;
  editableStepsRef.current = editableSteps;

  function buildMessage() {
    if (isEditingRef.current && editableStepsRef.current.length > 0) {
      const filledSteps = editableStepsRef.current.filter((s) =>
        s.description.trim(),
      );
      const list = filledSteps
        .map((s, i) => `${i + 1}. ${s.description}`)
        .join("; ");
      return `Approved with modifications. Please build the agent following these steps: ${list}`;
    }
    return "Approved. Please build the agent.";
  }

  function approve() {
    if (approvedRef.current) return;
    approvedRef.current = true;
    setIsEditing(false);
    onSendRef.current(buildMessage());
  }

  function handleModify() {
    if (approvedRef.current) return;
    if (!output || !isDecompositionOutput(output)) return;
    setTimerActive(false);
    setIsEditing(true);
    setEditableSteps(output.steps.map((s) => ({ ...s })));
  }

  function handleStepChange(index: number, description: string) {
    setEditableSteps((prev) =>
      prev.map((s, i) => (i === index ? { ...s, description } : s)),
    );
  }

  function handleStepDelete(index: number) {
    setEditableSteps((prev) => prev.filter((_, i) => i !== index));
  }

  // Insert a blank step after the given index (-1 = prepend).
  function handleStepInsert(afterIndex: number) {
    setEditableSteps((prev) => {
      const next = [...prev];
      next.splice(afterIndex + 1, 0, {
        step_id: `step_new_${Date.now()}`,
        description: "",
        action: "add_block",
        status: "pending",
      });
      return next;
    });
  }

  // If a new message arrives while editing, exit edit mode so the user is not stuck.
  useEffect(() => {
    if (!showActions && isEditing) {
      setIsEditing(false);
    }
  }, [showActions, isEditing]);

  // Tick down only while the timer is active.
  useEffect(() => {
    if (!showActions || !timerActive) return;
    const interval = setInterval(() => {
      setSecondsLeft((s) => Math.max(0, s - 1));
    }, 1000);
    return () => clearInterval(interval);
  }, [showActions, timerActive, part.toolCallId]);

  // Auto-approve when countdown reaches 0 — but only after the assistant
  // has finished streaming its summary text. Firing during streaming would
  // hit the same locked-session failure as a manual click. If the timer
  // hits 0 mid-stream, this effect re-runs when actionsEnabled flips true.
  // approve() is stable via approvedRef — safe to omit from deps.
  useEffect(() => {
    if (secondsLeft === 0 && timerActive && actionsEnabled) {
      approve();
    }
  }, [secondsLeft, timerActive, actionsEnabled]); // approve reads refs only — safe to omit

  const progress = secondsLeft / countdownSeconds;
  const dashOffset = CIRCUMFERENCE * (1 - progress);
  const stepCount = isEditing
    ? editableSteps.length
    : output && isDecompositionOutput(output)
      ? output.step_count
      : 0;

  return (
    <div className="py-2">
      {isPending && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <ToolIcon isStreaming={isStreaming} isError={isError} />
          <MorphingTextAnimation
            text={text}
            className={isError ? "text-red-500" : undefined}
          />
        </div>
      )}

      {isError && (
        <ToolErrorCard
          message={
            output && isErrorOutput(output) ? (output.message ?? "") : ""
          }
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
          title={`Build Plan — ${stepCount} steps`}
          description={output.goal}
          defaultExpanded
        >
          <ContentGrid>
            <ContentMessage>{output.message}</ContentMessage>

            <div className="rounded-lg border border-border bg-card p-3">
              {isEditing ? (
                <div className="flex flex-col">
                  {/* Insert before the first step */}
                  <InsertButton onClick={() => handleStepInsert(-1)} />

                  {editableSteps.map((step, i) => (
                    <div key={step.step_id} className="flex flex-col">
                      <div className="flex items-start gap-2 py-1">
                        <span className="w-5 shrink-0 pt-1 text-xs text-muted-foreground">
                          {i + 1}.
                        </span>
                        <textarea
                          ref={(el) => {
                            if (el) {
                              el.style.height = "auto";
                              el.style.height = `${el.scrollHeight}px`;
                            }
                          }}
                          value={step.description}
                          onChange={(e) => handleStepChange(i, e.target.value)}
                          rows={1}
                          className="flex-1 resize-none overflow-hidden rounded border border-border px-2 py-1 text-sm focus:border-neutral-400 focus:outline-none"
                          placeholder="Step description"
                        />
                        <button
                          type="button"
                          onClick={() => handleStepDelete(i)}
                          className="mt-1 text-muted-foreground hover:text-red-500"
                          aria-label="Remove step"
                        >
                          <TrashIcon size={14} />
                        </button>
                      </div>
                      {/* Insert after each step */}
                      <InsertButton onClick={() => handleStepInsert(i)} />
                    </div>
                  ))}
                </div>
              ) : (
                <div className="space-y-0.5">
                  {output.steps.map((step, i) => (
                    <StepItem
                      key={step.step_id}
                      index={i}
                      description={step.description}
                      blockName={step.block_name}
                      status={step.status}
                    />
                  ))}
                </div>
              )}
            </div>

            {showActions && (
              <div className="flex items-center gap-2 pt-1">
                {isEditing ? (
                  <Button
                    variant="primary"
                    onClick={approve}
                    disabled={!actionsEnabled}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <CheckIcon size={14} weight="bold" />
                      Approve
                    </span>
                  </Button>
                ) : (
                  <>
                    {/* Primary CTA — encourages user to run the agent */}
                    <Button
                      variant="primary"
                      size="small"
                      onClick={approve}
                      disabled={!actionsEnabled}
                    >
                      <span className="group/label inline-flex items-center gap-2">
                        <span className="inline-flex items-center gap-1.5 group-hover/label:hidden">
                          Starting in
                          <span className="relative inline-flex h-6 w-6 items-center justify-center">
                            <svg
                              width="24"
                              height="24"
                              viewBox="0 0 34 34"
                              className="absolute -rotate-90"
                            >
                              <circle
                                cx="17"
                                cy="17"
                                r={RADIUS}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                className="text-white/30"
                              />
                              <circle
                                cx="17"
                                cy="17"
                                r={RADIUS}
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeDasharray={CIRCUMFERENCE}
                                strokeDashoffset={dashOffset}
                                className="text-white transition-[stroke-dashoffset] duration-1000 ease-linear"
                              />
                            </svg>
                            <span className="relative z-10 text-[11px] font-semibold tabular-nums text-white">
                              {secondsLeft}
                            </span>
                          </span>
                        </span>
                        <span className="hidden group-hover/label:inline">
                          Start now
                        </span>
                      </span>
                    </Button>
                    <Button
                      variant="ghost"
                      size="small"
                      onClick={handleModify}
                      disabled={!actionsEnabled}
                    >
                      <span className="inline-flex items-center gap-1.5">
                        <PencilSimpleIcon size={14} weight="bold" />
                        Modify
                      </span>
                    </Button>
                  </>
                )}
              </div>
            )}

            {output.requires_approval && !showActions && (
              <ContentMessage>
                Review the plan above and approve to start building.
              </ContentMessage>
            )}
          </ContentGrid>
        </ToolAccordion>
      )}
    </div>
  );
}

function InsertButton({ onClick }: { onClick: () => void }) {
  return (
    <div className="group flex items-center gap-1 py-0.5">
      <div className="h-px flex-1 bg-border group-hover:bg-neutral-300" />
      <button
        type="button"
        onClick={onClick}
        className="flex items-center gap-0.5 rounded px-1 text-xs text-muted-foreground hover:text-foreground focus:outline-none"
        aria-label="Insert step here"
      >
        <PlusIcon size={10} weight="bold" />
      </button>
      <div className="h-px flex-1 bg-border group-hover:bg-neutral-300" />
    </div>
  );
}
