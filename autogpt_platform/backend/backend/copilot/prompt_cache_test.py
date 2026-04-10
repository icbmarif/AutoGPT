"""Unit tests for the cacheable system prompt building logic.

These tests verify that _build_system_prompt:
- Returns the static _CACHEABLE_SYSTEM_PROMPT when no user_id is given
- Returns the static prompt + understanding when user_id is given
- Falls through to _CACHEABLE_SYSTEM_PROMPT when Langfuse is not configured
- Returns the Langfuse-compiled prompt when Langfuse is configured
- Handles DB errors and Langfuse errors gracefully
"""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_SVC = "backend.copilot.service"


class TestBuildSystemPrompt:
    @pytest.mark.asyncio
    async def test_no_user_id_returns_static_prompt(self):
        """When user_id is None, no DB lookup happens and the static prompt is returned."""
        with (patch(f"{_SVC}._is_langfuse_configured", return_value=False),):
            from backend.copilot.service import (
                _CACHEABLE_SYSTEM_PROMPT,
                _build_system_prompt,
            )

            prompt, understanding = await _build_system_prompt(None)

        assert prompt == _CACHEABLE_SYSTEM_PROMPT
        assert understanding is None

    @pytest.mark.asyncio
    async def test_with_user_id_fetches_understanding(self):
        """When user_id is provided, understanding is fetched and returned alongside prompt."""
        fake_understanding = MagicMock()
        mock_db = MagicMock()
        mock_db.get_business_understanding = AsyncMock(return_value=fake_understanding)

        with (
            patch(f"{_SVC}._is_langfuse_configured", return_value=False),
            patch(f"{_SVC}.understanding_db", return_value=mock_db),
        ):
            from backend.copilot.service import (
                _CACHEABLE_SYSTEM_PROMPT,
                _build_system_prompt,
            )

            prompt, understanding = await _build_system_prompt("user-123")

        assert prompt == _CACHEABLE_SYSTEM_PROMPT
        assert understanding is fake_understanding
        mock_db.get_business_understanding.assert_called_once_with("user-123")

    @pytest.mark.asyncio
    async def test_db_error_returns_prompt_with_no_understanding(self):
        """When the DB raises an exception, understanding is None and prompt is still returned."""
        mock_db = MagicMock()
        mock_db.get_business_understanding = AsyncMock(
            side_effect=RuntimeError("db down")
        )

        with (
            patch(f"{_SVC}._is_langfuse_configured", return_value=False),
            patch(f"{_SVC}.understanding_db", return_value=mock_db),
        ):
            from backend.copilot.service import (
                _CACHEABLE_SYSTEM_PROMPT,
                _build_system_prompt,
            )

            prompt, understanding = await _build_system_prompt("user-456")

        assert prompt == _CACHEABLE_SYSTEM_PROMPT
        assert understanding is None

    @pytest.mark.asyncio
    async def test_langfuse_compiled_prompt_returned(self):
        """When Langfuse is configured and returns a prompt, the compiled text is returned."""
        fake_understanding = MagicMock()
        mock_db = MagicMock()
        mock_db.get_business_understanding = AsyncMock(return_value=fake_understanding)

        langfuse_prompt_text = "You are a Langfuse-sourced assistant."
        mock_prompt_obj = MagicMock()
        mock_prompt_obj.compile.return_value = langfuse_prompt_text

        mock_langfuse = MagicMock()
        mock_langfuse.get_prompt.return_value = mock_prompt_obj

        with (
            patch(f"{_SVC}._is_langfuse_configured", return_value=True),
            patch(f"{_SVC}.understanding_db", return_value=mock_db),
            patch(f"{_SVC}._get_langfuse", return_value=mock_langfuse),
            patch(
                f"{_SVC}.asyncio.to_thread", new=AsyncMock(return_value=mock_prompt_obj)
            ),
        ):
            from backend.copilot.service import _build_system_prompt

            prompt, understanding = await _build_system_prompt("user-789")

        assert prompt == langfuse_prompt_text
        assert understanding is fake_understanding
        mock_prompt_obj.compile.assert_called_once_with(users_information="")

    @pytest.mark.asyncio
    async def test_langfuse_error_falls_back_to_static_prompt(self):
        """When Langfuse raises an error, the fallback _CACHEABLE_SYSTEM_PROMPT is used."""
        mock_db = MagicMock()
        mock_db.get_business_understanding = AsyncMock(return_value=None)

        with (
            patch(f"{_SVC}._is_langfuse_configured", return_value=True),
            patch(f"{_SVC}.understanding_db", return_value=mock_db),
            patch(
                f"{_SVC}.asyncio.to_thread",
                new=AsyncMock(side_effect=RuntimeError("langfuse down")),
            ),
        ):
            from backend.copilot.service import (
                _CACHEABLE_SYSTEM_PROMPT,
                _build_system_prompt,
            )

            prompt, understanding = await _build_system_prompt("user-000")

        assert prompt == _CACHEABLE_SYSTEM_PROMPT
        assert understanding is None


class TestInjectUserContext:
    """Tests for inject_user_context — sequence resolution logic."""

    @pytest.mark.asyncio
    async def test_uses_session_msg_sequence_when_set(self):
        """When session_msg.sequence is populated (DB-loaded), it is used as the DB key."""
        from backend.copilot.model import ChatMessage
        from backend.copilot.service import inject_user_context

        understanding = MagicMock()
        understanding.__str__ = MagicMock(return_value="biz ctx")

        msg = ChatMessage(role="user", content="hello", sequence=7)

        mock_db = MagicMock()
        mock_db.update_message_content_by_sequence = AsyncMock(return_value=True)
        with patch(
            "backend.copilot.service.chat_db",
            return_value=mock_db,
        ), patch(
            "backend.copilot.service.format_understanding_for_prompt",
            return_value="biz ctx",
        ):
            result = await inject_user_context(understanding, "hello", "sess-1", [msg])

        assert result is not None
        assert "<user_context>" in result
        mock_db.update_message_content_by_sequence.assert_awaited_once()
        _, called_sequence, _ = (
            mock_db.update_message_content_by_sequence.call_args.args
        )
        assert called_sequence == 7

    @pytest.mark.asyncio
    async def test_falls_back_to_idx_when_sequence_is_none(self):
        """When session_msg.sequence is None (cache-loaded), list index is used as fallback."""
        from backend.copilot.model import ChatMessage
        from backend.copilot.service import inject_user_context

        understanding = MagicMock()

        msg = ChatMessage(role="user", content="hello", sequence=None)

        mock_db = MagicMock()
        mock_db.update_message_content_by_sequence = AsyncMock(return_value=True)
        with patch(
            "backend.copilot.service.chat_db",
            return_value=mock_db,
        ), patch(
            "backend.copilot.service.format_understanding_for_prompt",
            return_value="biz ctx",
        ):
            result = await inject_user_context(understanding, "hello", "sess-1", [msg])

        assert result is not None
        mock_db.update_message_content_by_sequence.assert_awaited_once()
        _, called_sequence, _ = (
            mock_db.update_message_content_by_sequence.call_args.args
        )
        assert called_sequence == 0

    @pytest.mark.asyncio
    async def test_returns_none_when_no_user_message(self):
        """Returns None when session_messages contains no user role message."""
        from backend.copilot.model import ChatMessage
        from backend.copilot.service import inject_user_context

        understanding = MagicMock()

        msgs = [ChatMessage(role="assistant", content="hi")]

        mock_db = MagicMock()
        mock_db.update_message_content_by_sequence = AsyncMock(return_value=True)
        with patch(
            "backend.copilot.service.chat_db",
            return_value=mock_db,
        ), patch(
            "backend.copilot.service.format_understanding_for_prompt",
            return_value="biz ctx",
        ):
            result = await inject_user_context(understanding, "hello", "sess-1", msgs)

        assert result is None
        mock_db.update_message_content_by_sequence.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_returns_prefix_even_when_db_persist_fails(self):
        """DB persist failure still returns the prefixed message (silent-success contract)."""
        from backend.copilot.model import ChatMessage
        from backend.copilot.service import inject_user_context

        understanding = MagicMock()

        msg = ChatMessage(role="user", content="hello", sequence=0)

        mock_db = MagicMock()
        mock_db.update_message_content_by_sequence = AsyncMock(return_value=False)
        with patch(
            "backend.copilot.service.chat_db",
            return_value=mock_db,
        ), patch(
            "backend.copilot.service.format_understanding_for_prompt",
            return_value="biz ctx",
        ):
            result = await inject_user_context(understanding, "hello", "sess-1", [msg])

        assert result is not None
        assert "<user_context>" in result
        assert result.endswith("hello")
        # in-memory list is still mutated even when persist returns False
        assert msg.content == result

    @pytest.mark.asyncio
    async def test_empty_message_produces_well_formed_prefix(self):
        """An empty message is wrapped in a well-formed <user_context> block."""
        from backend.copilot.model import ChatMessage
        from backend.copilot.service import inject_user_context

        understanding = MagicMock()
        msg = ChatMessage(role="user", content="", sequence=0)

        mock_db = MagicMock()
        mock_db.update_message_content_by_sequence = AsyncMock(return_value=True)
        with patch(
            "backend.copilot.service.chat_db",
            return_value=mock_db,
        ), patch(
            "backend.copilot.service.format_understanding_for_prompt",
            return_value="biz ctx",
        ):
            result = await inject_user_context(understanding, "", "sess-1", [msg])

        assert result == "<user_context>\nbiz ctx\n</user_context>\n\n"
        mock_db.update_message_content_by_sequence.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_double_injection_guard_skips_rewrite(self):
        """If the message already contains <user_context>, no re-injection occurs."""
        from backend.copilot.model import ChatMessage
        from backend.copilot.service import inject_user_context

        understanding = MagicMock()
        already_prefixed = "<user_context>\nold ctx\n</user_context>\n\nhello again"
        msg = ChatMessage(role="user", content=already_prefixed, sequence=0)

        mock_db = MagicMock()
        mock_db.update_message_content_by_sequence = AsyncMock(return_value=True)
        with patch(
            "backend.copilot.service.chat_db",
            return_value=mock_db,
        ), patch(
            "backend.copilot.service.format_understanding_for_prompt",
            return_value="new ctx",
        ):
            result = await inject_user_context(
                understanding, already_prefixed, "sess-1", [msg]
            )

        # Returns the incoming message unchanged, no DB write issued.
        assert result == already_prefixed
        assert "new ctx" not in result
        mock_db.update_message_content_by_sequence.assert_not_awaited()


class TestCacheableSystemPromptContent:
    """Smoke-test the _CACHEABLE_SYSTEM_PROMPT constant for key structural requirements."""

    def test_cacheable_prompt_has_no_placeholder(self):
        """The static cacheable prompt must not contain the users_information placeholder.

        Checks for the specific placeholder only — unrelated curly braces
        (e.g. JSON examples in future prompt text) should not fail this test.
        """
        from backend.copilot.service import _CACHEABLE_SYSTEM_PROMPT

        assert "{users_information}" not in _CACHEABLE_SYSTEM_PROMPT

    def test_cacheable_prompt_mentions_user_context(self):
        """The prompt instructs the model to parse <user_context> blocks."""
        from backend.copilot.service import _CACHEABLE_SYSTEM_PROMPT

        assert "user_context" in _CACHEABLE_SYSTEM_PROMPT
