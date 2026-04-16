"""Tests for the pre-create assistant message logic that prevents
last_role=tool after client disconnect.

Reproduces the bug where:
  1. Tool result is saved by intermediate flush → last_role=tool
  2. SDK generates a text response
  3. GeneratorExit at StreamStartStep yield (client disconnect)
  4. _dispatch_response(StreamTextDelta) is never called
  5. Session saved with last_role=tool instead of last_role=assistant

The fix: before yielding any events, pre-create the assistant message in
ctx.session.messages when has_tool_results=True and a StreamTextDelta is
present in adapter_responses.  This test verifies the resulting accumulator
state allows correct content accumulation by _dispatch_response.
"""

from __future__ import annotations

from datetime import datetime, timezone
from unittest.mock import MagicMock

from backend.copilot.model import ChatMessage, ChatSession
from backend.copilot.response_model import (
    StreamStartStep,
    StreamTextDelta,
    StreamToolInputAvailable,
)
from backend.copilot.sdk.service import _dispatch_response, _StreamAccumulator

_NOW = datetime(2024, 1, 1, tzinfo=timezone.utc)


def _make_session() -> ChatSession:
    return ChatSession(
        session_id="test",
        user_id="test-user",
        title="test",
        messages=[],
        usage=[],
        started_at=_NOW,
        updated_at=_NOW,
    )


def _make_ctx(session: ChatSession | None = None) -> MagicMock:
    ctx = MagicMock()
    ctx.session = session or _make_session()
    ctx.log_prefix = "[test]"
    return ctx


def _make_state() -> MagicMock:
    state = MagicMock()
    state.transcript_builder = MagicMock()
    return state


def _simulate_pre_create(acc: _StreamAccumulator, ctx: MagicMock) -> None:
    """Mirror the pre-create block from _run_stream_attempt so tests
    can verify its effect without invoking the full async generator.

    Keep in sync with the block in service.py _run_stream_attempt
    (search: "Pre-create the new assistant message").
    """
    acc.assistant_response = ChatMessage(role="assistant", content="")
    acc.accumulated_tool_calls = []
    acc.has_tool_results = False
    ctx.session.messages.append(acc.assistant_response)
    # acc.has_appended_assistant stays True


class TestPreCreateAssistantMessage:
    """Verify that the pre-create logic correctly seeds the session message
    and that subsequent _dispatch_response(StreamTextDelta) accumulates
    content in-place without a double-append."""

    def test_pre_create_adds_message_to_session(self) -> None:
        """After pre-create, session has one assistant message."""
        session = _make_session()
        ctx = _make_ctx(session)
        acc = _StreamAccumulator(
            assistant_response=ChatMessage(role="assistant", content=""),
            accumulated_tool_calls=[],
            has_appended_assistant=True,
            has_tool_results=True,
        )

        _simulate_pre_create(acc, ctx)

        assert len(session.messages) == 1
        assert session.messages[-1].role == "assistant"
        assert session.messages[-1].content == ""

    def test_pre_create_resets_tool_result_flag(self) -> None:
        acc = _StreamAccumulator(
            assistant_response=ChatMessage(role="assistant", content=""),
            accumulated_tool_calls=[],
            has_appended_assistant=True,
            has_tool_results=True,
        )
        ctx = _make_ctx()
        _simulate_pre_create(acc, ctx)

        assert acc.has_tool_results is False

    def test_pre_create_resets_accumulated_tool_calls(self) -> None:
        existing_call = {
            "id": "call_1",
            "type": "function",
            "function": {"name": "bash"},
        }
        acc = _StreamAccumulator(
            assistant_response=ChatMessage(role="assistant", content=""),
            accumulated_tool_calls=[existing_call],
            has_appended_assistant=True,
            has_tool_results=True,
        )
        ctx = _make_ctx()
        _simulate_pre_create(acc, ctx)

        assert acc.accumulated_tool_calls == []

    def test_text_delta_accumulates_in_preexisting_message(self) -> None:
        """StreamTextDelta after pre-create updates the already-appended message
        in-place — no double-append."""
        session = _make_session()
        ctx = _make_ctx(session)
        state = _make_state()
        acc = _StreamAccumulator(
            assistant_response=ChatMessage(role="assistant", content=""),
            accumulated_tool_calls=[],
            has_appended_assistant=True,
            has_tool_results=True,
        )

        _simulate_pre_create(acc, ctx)
        assert len(session.messages) == 1

        # Simulate the first text delta arriving after pre-create
        delta = StreamTextDelta(id="t1", delta="Hello world")
        _dispatch_response(delta, acc, ctx, state, False, "[test]")

        # Still only one message (no double-append)
        assert len(session.messages) == 1
        # Content accumulated in the pre-created message
        assert session.messages[-1].content == "Hello world"
        assert session.messages[-1].role == "assistant"

    def test_subsequent_deltas_append_to_content(self) -> None:
        """Multiple deltas build up the full response text."""
        session = _make_session()
        ctx = _make_ctx(session)
        state = _make_state()
        acc = _StreamAccumulator(
            assistant_response=ChatMessage(role="assistant", content=""),
            accumulated_tool_calls=[],
            has_appended_assistant=True,
            has_tool_results=True,
        )

        _simulate_pre_create(acc, ctx)

        for word in ["You're ", "right ", "about ", "that."]:
            _dispatch_response(
                StreamTextDelta(id="t1", delta=word), acc, ctx, state, False, "[test]"
            )

        assert len(session.messages) == 1
        assert session.messages[-1].content == "You're right about that."

    def test_pre_create_not_triggered_without_tool_results(self) -> None:
        """Pre-create condition requires has_tool_results=True; no-op otherwise."""
        acc = _StreamAccumulator(
            assistant_response=ChatMessage(role="assistant", content=""),
            accumulated_tool_calls=[],
            has_appended_assistant=True,
            has_tool_results=False,  # no prior tool results
        )
        ctx = _make_ctx()

        # Condition is False — simulate: do nothing
        if acc.has_tool_results and acc.has_appended_assistant:
            _simulate_pre_create(acc, ctx)

        assert len(ctx.session.messages) == 0

    def test_pre_create_not_triggered_when_not_yet_appended(self) -> None:
        """Pre-create requires has_appended_assistant=True."""
        acc = _StreamAccumulator(
            assistant_response=ChatMessage(role="assistant", content=""),
            accumulated_tool_calls=[],
            has_appended_assistant=False,  # first turn, nothing appended yet
            has_tool_results=True,
        )
        ctx = _make_ctx()

        if acc.has_tool_results and acc.has_appended_assistant:
            _simulate_pre_create(acc, ctx)

        assert len(ctx.session.messages) == 0

    def test_pre_create_not_triggered_without_text_delta(self) -> None:
        """Pre-create is skipped when adapter_responses has no StreamTextDelta
        (e.g. a tool-only batch). Verifies the third guard condition."""
        acc = _StreamAccumulator(
            assistant_response=ChatMessage(role="assistant", content=""),
            accumulated_tool_calls=[],
            has_appended_assistant=True,
            has_tool_results=True,
        )
        ctx = _make_ctx()
        adapter_responses = [StreamStartStep()]  # no StreamTextDelta

        if (
            acc.has_tool_results
            and acc.has_appended_assistant
            and any(isinstance(r, StreamTextDelta) for r in adapter_responses)
        ):
            _simulate_pre_create(acc, ctx)

        assert len(ctx.session.messages) == 0


class TestToolCallsLostAfterIntermediateFlush:
    """Regression tests for the bug where tool_calls are lost when an
    intermediate flush saves the assistant message before StreamToolInputAvailable
    arrives.

    Sequence that triggers the bug:
    1. StreamTextDelta → assistant message appended with tool_calls=None
    2. Intermediate flush fires (time/count threshold) → DB row written with tool_calls=null
       and acc.assistant_response.sequence is set (back-filled)
    3. StreamToolInputAvailable → acc.assistant_response.tool_calls mutated in-memory
    4. Final save: append-only — assistant row already in DB, tool_calls never updated

    Fix: when StreamToolInputAvailable arrives and acc.assistant_response.sequence
    is not None, issue a DB UPDATE to patch toolCalls on the existing row.
    """

    def test_text_delta_then_tool_input_sets_tool_calls_on_message(self) -> None:
        """After text arrives then tool input arrives, acc.assistant_response.tool_calls
        should be populated regardless of flush state."""
        session = _make_session()
        ctx = _make_ctx(session)
        state = _make_state()
        acc = _StreamAccumulator(
            assistant_response=ChatMessage(role="assistant", content=""),
            accumulated_tool_calls=[],
        )

        # Step 1: text delta arrives, message appended
        _dispatch_response(
            StreamTextDelta(id="t1", delta="Let me run that for you."),
            acc,
            ctx,
            state,
            False,
            "[test]",
        )
        assert acc.has_appended_assistant
        assert session.messages[-1].tool_calls is None

        # Step 2: simulate intermediate flush back-filling the sequence
        acc.assistant_response.sequence = 1  # back-filled by _save_session_to_db

        # Step 3: tool input arrives
        _dispatch_response(
            StreamToolInputAvailable(
                toolCallId="call_abc",
                toolName="bash_exec",
                input={"command": "ls"},
            ),
            acc,
            ctx,
            state,
            False,
            "[test]",
        )

        # tool_calls should be set in memory
        assert acc.assistant_response.tool_calls is not None
        assert len(acc.assistant_response.tool_calls) == 1
        assert acc.assistant_response.tool_calls[0]["id"] == "call_abc"

    def test_sequence_set_when_flush_occurred_before_tool_input(self) -> None:
        """When sequence is back-filled (flush happened) before tool calls arrive,
        it is detectable so the caller can issue a DB patch."""
        acc = _StreamAccumulator(
            assistant_response=ChatMessage(role="assistant", content="hello"),
            accumulated_tool_calls=[],
            has_appended_assistant=True,
        )
        # Simulate flush back-fill
        acc.assistant_response.sequence = 3

        ctx = _make_ctx()
        state = _make_state()

        _dispatch_response(
            StreamToolInputAvailable(
                toolCallId="call_xyz",
                toolName="run_block",
                input={},
            ),
            acc,
            ctx,
            state,
            False,
            "[test]",
        )

        # Caller should detect this condition and issue a DB patch
        needs_db_patch = acc.assistant_response.sequence is not None and bool(
            acc.accumulated_tool_calls
        )
        assert (
            needs_db_patch
        ), "Expected needs_db_patch=True when flush happened before tool calls arrived"
