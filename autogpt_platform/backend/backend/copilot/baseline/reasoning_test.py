"""Tests for the baseline reasoning extension module.

Covers the typed OpenRouter delta parser, the stateful emitter, and the
``extra_body`` builder.  The emitter is tested against real
``ChoiceDelta`` pydantic instances so the ``model_extra`` plumbing the
parser relies on is exercised end-to-end.
"""

from openai.types.chat.chat_completion_chunk import ChoiceDelta

from backend.copilot.baseline.reasoning import (
    BaselineReasoningEmitter,
    OpenRouterDeltaExtension,
    ReasoningDetail,
    reasoning_extra_body,
)
from backend.copilot.model import ChatMessage
from backend.copilot.response_model import (
    StreamReasoningDelta,
    StreamReasoningEnd,
    StreamReasoningStart,
)


def _delta(**extra) -> ChoiceDelta:
    """Build a ChoiceDelta with the given extension fields on ``model_extra``."""
    return ChoiceDelta.model_validate({"role": "assistant", **extra})


class TestReasoningDetail:
    def test_visible_text_prefers_text(self):
        d = ReasoningDetail(type="reasoning.text", text="hi", summary="ignored")
        assert d.visible_text == "hi"

    def test_visible_text_falls_back_to_summary(self):
        d = ReasoningDetail(type="reasoning.summary", summary="tldr")
        assert d.visible_text == "tldr"

    def test_visible_text_empty_for_encrypted(self):
        d = ReasoningDetail(type="reasoning.encrypted")
        assert d.visible_text == ""

    def test_unknown_fields_are_ignored(self):
        # OpenRouter may add new fields in future payloads — they shouldn't
        # cause validation errors.
        d = ReasoningDetail.model_validate(
            {"type": "reasoning.future", "text": "x", "signature": "opaque"}
        )
        assert d.text == "x"


class TestOpenRouterDeltaExtension:
    def test_from_delta_reads_model_extra(self):
        delta = _delta(reasoning="step one")
        ext = OpenRouterDeltaExtension.from_delta(delta)
        assert ext.reasoning == "step one"

    def test_visible_text_legacy_string(self):
        ext = OpenRouterDeltaExtension(reasoning="plain text")
        assert ext.visible_text() == "plain text"

    def test_visible_text_deepseek_alias(self):
        ext = OpenRouterDeltaExtension(reasoning_content="alt channel")
        assert ext.visible_text() == "alt channel"

    def test_visible_text_structured_details_concat(self):
        ext = OpenRouterDeltaExtension(
            reasoning_details=[
                ReasoningDetail(type="reasoning.text", text="hello "),
                ReasoningDetail(type="reasoning.text", text="world"),
            ]
        )
        assert ext.visible_text() == "hello world"

    def test_visible_text_skips_encrypted(self):
        ext = OpenRouterDeltaExtension(
            reasoning_details=[
                ReasoningDetail(type="reasoning.encrypted"),
                ReasoningDetail(type="reasoning.text", text="visible"),
            ]
        )
        assert ext.visible_text() == "visible"

    def test_visible_text_empty_when_all_channels_blank(self):
        ext = OpenRouterDeltaExtension()
        assert ext.visible_text() == ""

    def test_empty_delta_produces_empty_extension(self):
        ext = OpenRouterDeltaExtension.from_delta(_delta())
        assert ext.reasoning is None
        assert ext.reasoning_content is None
        assert ext.reasoning_details == []


class TestReasoningExtraBody:
    def test_anthropic_route_returns_fragment(self):
        assert reasoning_extra_body("anthropic/claude-sonnet-4-6", 4096) == {
            "reasoning": {"max_tokens": 4096}
        }

    def test_direct_claude_model_id_still_matches(self):
        assert reasoning_extra_body("claude-3-5-sonnet-20241022", 2048) == {
            "reasoning": {"max_tokens": 2048}
        }

    def test_non_anthropic_route_returns_none(self):
        assert reasoning_extra_body("openai/gpt-4o", 4096) is None
        assert reasoning_extra_body("google/gemini-2.5-pro", 4096) is None


class TestBaselineReasoningEmitter:
    def test_first_text_delta_emits_start_then_delta(self):
        emitter = BaselineReasoningEmitter()
        events = emitter.on_delta(_delta(reasoning="thinking"))

        assert len(events) == 2
        assert isinstance(events[0], StreamReasoningStart)
        assert isinstance(events[1], StreamReasoningDelta)
        assert events[0].id == events[1].id
        assert events[1].delta == "thinking"
        assert emitter.is_open is True

    def test_subsequent_deltas_reuse_block_id_without_new_start(self):
        emitter = BaselineReasoningEmitter()
        first = emitter.on_delta(_delta(reasoning="a"))
        second = emitter.on_delta(_delta(reasoning="b"))

        assert any(isinstance(e, StreamReasoningStart) for e in first)
        assert all(not isinstance(e, StreamReasoningStart) for e in second)
        assert len(second) == 1
        assert isinstance(second[0], StreamReasoningDelta)
        assert first[0].id == second[0].id

    def test_empty_delta_emits_nothing(self):
        emitter = BaselineReasoningEmitter()
        assert emitter.on_delta(_delta(content="hello")) == []
        assert emitter.is_open is False

    def test_close_emits_end_and_rotates_id(self):
        emitter = BaselineReasoningEmitter()
        emitter.on_delta(_delta(reasoning="x"))
        first_id = emitter._block_id  # pyright: ignore[reportPrivateUsage]

        events = emitter.close()
        assert len(events) == 1
        assert isinstance(events[0], StreamReasoningEnd)
        assert events[0].id == first_id
        assert emitter.is_open is False
        # Next reasoning uses a fresh id.
        new_events = emitter.on_delta(_delta(reasoning="y"))
        assert isinstance(new_events[0], StreamReasoningStart)
        assert new_events[0].id != first_id

    def test_close_is_idempotent(self):
        emitter = BaselineReasoningEmitter()
        assert emitter.close() == []
        emitter.on_delta(_delta(reasoning="x"))
        assert len(emitter.close()) == 1
        assert emitter.close() == []

    def test_structured_details_round_trip(self):
        emitter = BaselineReasoningEmitter()
        events = emitter.on_delta(
            _delta(
                reasoning_details=[
                    {"type": "reasoning.text", "text": "plan: "},
                    {"type": "reasoning.summary", "summary": "do the thing"},
                ]
            )
        )
        deltas = [e for e in events if isinstance(e, StreamReasoningDelta)]
        assert len(deltas) == 1
        assert deltas[0].delta == "plan: do the thing"


class TestReasoningPersistence:
    """The persistence contract: without ``role="reasoning"`` rows in
    session.messages, useHydrateOnStreamEnd overwrites the live-streamed
    reasoning parts and the Reasoning collapse vanishes.  Every delta
    must be reflected in the persisted row the moment it's emitted."""

    def test_session_row_appended_on_first_delta(self):
        session: list[ChatMessage] = []
        emitter = BaselineReasoningEmitter(session)

        assert session == []
        emitter.on_delta(_delta(reasoning="hi"))
        assert len(session) == 1
        assert session[0].role == "reasoning"
        assert session[0].content == "hi"

    def test_subsequent_deltas_mutate_same_row(self):
        session: list[ChatMessage] = []
        emitter = BaselineReasoningEmitter(session)

        emitter.on_delta(_delta(reasoning="part one "))
        emitter.on_delta(_delta(reasoning="part two"))

        assert len(session) == 1
        assert session[0].content == "part one part two"

    def test_close_keeps_row_in_session(self):
        session: list[ChatMessage] = []
        emitter = BaselineReasoningEmitter(session)

        emitter.on_delta(_delta(reasoning="thought"))
        emitter.close()

        assert len(session) == 1
        assert session[0].content == "thought"

    def test_second_reasoning_block_appends_new_row(self):
        session: list[ChatMessage] = []
        emitter = BaselineReasoningEmitter(session)

        emitter.on_delta(_delta(reasoning="first"))
        emitter.close()
        emitter.on_delta(_delta(reasoning="second"))

        assert len(session) == 2
        assert [m.content for m in session] == ["first", "second"]

    def test_no_session_means_no_persistence(self):
        """Emitter without attached session list emits wire events only."""
        emitter = BaselineReasoningEmitter()
        events = emitter.on_delta(_delta(reasoning="pure wire"))
        assert len(events) == 2  # start + delta, no crash
        # Nothing else to assert — just proves None session is supported.
