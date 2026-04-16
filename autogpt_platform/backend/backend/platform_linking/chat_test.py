"""Tests for chat-turn orchestration — esp. the duplicate-message guard."""

from unittest.mock import AsyncMock, MagicMock, patch

import pytest

from backend.util.exceptions import DuplicateChatMessageError, NotFoundError

from .chat import start_chat_turn
from .models import BotChatRequest, Platform


def _request(**overrides) -> BotChatRequest:
    defaults = dict(
        platform=Platform.DISCORD,
        platform_user_id="pu1",
        message="hello",
    )
    defaults.update(overrides)
    return BotChatRequest(**defaults)


class TestStartChatTurn:
    @pytest.mark.asyncio
    async def test_no_user_link_raises_not_found(self):
        with patch(
            "backend.platform_linking.chat.find_user_link",
            new=AsyncMock(return_value=None),
        ):
            with pytest.raises(NotFoundError):
                await start_chat_turn(_request())

    @pytest.mark.asyncio
    async def test_duplicate_message_raises_and_skips_stream_create(self):
        # append_and_save_message returns None → duplicate.
        # Verify we raise and do NOT create a stream session (Sentry-reported
        # bug: an orphan stream with no producer makes subscribers hang).
        user_link = MagicMock(userId="owner-1")
        session = MagicMock(session_id="sess-existing")

        with (
            patch(
                "backend.platform_linking.chat.find_user_link",
                new=AsyncMock(return_value=user_link),
            ),
            patch(
                "backend.platform_linking.chat.create_chat_session",
                new=AsyncMock(return_value=session),
            ),
            patch(
                "backend.platform_linking.chat.append_and_save_message",
                new=AsyncMock(return_value=None),
            ),
            patch(
                "backend.platform_linking.chat.stream_registry"
            ) as mock_stream_registry,
            patch(
                "backend.platform_linking.chat.enqueue_copilot_turn",
                new=AsyncMock(),
            ) as mock_enqueue,
        ):
            mock_stream_registry.create_session = AsyncMock()

            with pytest.raises(DuplicateChatMessageError):
                await start_chat_turn(_request())

        mock_stream_registry.create_session.assert_not_awaited()
        mock_enqueue.assert_not_awaited()

    @pytest.mark.asyncio
    async def test_happy_path_creates_stream_and_enqueues(self):
        user_link = MagicMock(userId="owner-1")
        session = MagicMock(session_id="sess-new")

        with (
            patch(
                "backend.platform_linking.chat.find_user_link",
                new=AsyncMock(return_value=user_link),
            ),
            patch(
                "backend.platform_linking.chat.create_chat_session",
                new=AsyncMock(return_value=session),
            ),
            patch(
                "backend.platform_linking.chat.append_and_save_message",
                new=AsyncMock(return_value=MagicMock()),
            ),
            patch(
                "backend.platform_linking.chat.stream_registry"
            ) as mock_stream_registry,
            patch(
                "backend.platform_linking.chat.enqueue_copilot_turn",
                new=AsyncMock(),
            ) as mock_enqueue,
        ):
            mock_stream_registry.create_session = AsyncMock()
            handle = await start_chat_turn(_request())

        assert handle.session_id == "sess-new"
        assert handle.user_id == "owner-1"
        assert handle.turn_id  # non-empty uuid
        assert handle.subscribe_from == "0-0"
        mock_stream_registry.create_session.assert_awaited_once()
        mock_enqueue.assert_awaited_once()

    @pytest.mark.asyncio
    async def test_existing_session_id_wrong_user_raises_not_found(self):
        user_link = MagicMock(userId="owner-1")

        with (
            patch(
                "backend.platform_linking.chat.find_user_link",
                new=AsyncMock(return_value=user_link),
            ),
            # get_chat_session returns None when the caller doesn't own the
            # session — emulate that here.
            patch(
                "backend.platform_linking.chat.get_chat_session",
                new=AsyncMock(return_value=None),
            ),
        ):
            with pytest.raises(NotFoundError):
                await start_chat_turn(_request(session_id="someone-elses"))
