"""DecomposeGoalTool - Breaks agent-building goals into sub-instructions."""

import logging
from typing import Any

from backend.copilot.model import ChatSession

from .base import BaseTool
from .models import (
    DecompositionStepModel,
    ErrorResponse,
    TaskDecompositionResponse,
    ToolResponseBase,
)

logger = logging.getLogger(__name__)

MAX_STEPS = 10


class DecomposeGoalTool(BaseTool):
    """Tool for decomposing an agent goal into sub-instructions."""

    @property
    def name(self) -> str:
        return "decompose_goal"

    @property
    def description(self) -> str:
        return (
            "Break down an agent-building goal into logical sub-instructions. "
            "Each step maps to one task (e.g. add a block, wire connections, "
            "configure settings). ALWAYS call this before create_agent to show "
            "the user your plan and get approval."
        )

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "goal": {
                    "type": "string",
                    "description": "The user's agent-building goal.",
                },
                "steps": {
                    "type": "array",
                    "items": {
                        "type": "object",
                        "properties": {
                            "description": {
                                "type": "string",
                                "description": "Human-readable step description.",
                            },
                            "action": {
                                "type": "string",
                                "description": (
                                    "Action type: 'add_block', 'connect_blocks', "
                                    "'configure', 'add_input', 'add_output'."
                                ),
                            },
                            "block_name": {
                                "type": "string",
                                "description": "Block name if adding a block.",
                            },
                        },
                        "required": ["description", "action"],
                    },
                    "description": "List of sub-instructions for the plan.",
                },
                "require_approval": {
                    "type": "boolean",
                    "description": "Whether to ask user for approval (default: true).",
                    "default": True,
                },
            },
            "required": ["goal", "steps"],
        }

    async def _execute(
        self,
        user_id: str | None,
        session: ChatSession,
        goal: str | None = None,
        steps: list[dict[str, Any]] | None = None,
        require_approval: bool = True,
        **kwargs,
    ) -> ToolResponseBase:
        session_id = session.session_id if session else None

        if not goal:
            return ErrorResponse(
                message="Please provide a goal to decompose.",
                error="missing_goal",
                session_id=session_id,
            )

        if not steps:
            return ErrorResponse(
                message="Please provide at least one step in the plan.",
                error="missing_steps",
                session_id=session_id,
            )

        if len(steps) > MAX_STEPS:
            return ErrorResponse(
                message=f"Too many steps ({len(steps)}). Keep the plan to {MAX_STEPS} steps max.",
                error="too_many_steps",
                session_id=session_id,
            )

        decomposition_steps = [
            DecompositionStepModel(
                step_id=f"step_{i + 1}",
                description=step.get("description", ""),
                action=step.get("action", "add_block"),
                block_name=step.get("block_name"),
                status="pending",
            )
            for i, step in enumerate(steps)
        ]

        return TaskDecompositionResponse(
            message=f"Here's the plan to build your agent ({len(decomposition_steps)} steps):",
            goal=goal,
            steps=decomposition_steps,
            step_count=len(decomposition_steps),
            requires_approval=require_approval,
            session_id=session_id,
        )
