"""
Bot Chat Proxy endpoints.

Allows the bot to stream AutoPilot (CoPilot) responses on behalf of a
platform user, authenticated via bot API key. The bot never handles AutoGPT
user IDs — it passes platform identifiers and the backend resolves the
owning AutoGPT user internally. Prevents impersonation even if the bot
API key is compromised.

Two resolution paths depending on context:
  * SERVER context: request carries platform_server_id + platform_user_id.
    Resolves via PlatformLink; billed to the server owner. Each
    (server, user) pair gets its own session.
  * DM (USER) context: request carries only platform_user_id.
    Resolves via PlatformUserLink; billed to that user's own account.
"""

import asyncio
import logging
from uuid import uuid4

from fastapi import APIRouter, HTTPException, Security
from fastapi.responses import StreamingResponse

from backend.copilot import stream_registry
from backend.copilot.executor.utils import enqueue_copilot_turn
from backend.copilot.model import (
    ChatMessage,
    append_and_save_message,
    create_chat_session,
    get_chat_session,
)
from backend.copilot.response_model import StreamFinish

from . import find_server_link, find_user_link
from .auth import check_bot_api_key, get_bot_api_key
from .models import BotChatRequest, BotChatSessionResponse

logger = logging.getLogger(__name__)

router = APIRouter()


async def _resolve_owner(request: BotChatRequest) -> str:
    """Return the AutoGPT user ID that should own this conversation's session.

    - SERVER context (platform_server_id set): server owner.
    - DM context (platform_server_id is None): the DM-linked user themselves.
    Raises 404 if no matching link exists.
    """
    platform = request.platform.value

    if request.platform_server_id:
        link = await find_server_link(platform, request.platform_server_id)
        if link is None:
            raise HTTPException(
                status_code=404,
                detail="This server is not linked to an AutoGPT account.",
            )
        return link.userId

    user_link = await find_user_link(platform, request.platform_user_id)
    if user_link is None:
        raise HTTPException(
            status_code=404,
            detail="Your DMs are not linked to an AutoGPT account.",
        )
    return user_link.userId


@router.post(
    "/chat/session",
    response_model=BotChatSessionResponse,
    summary="Create a CoPilot session for a platform user (bot-facing)",
)
async def bot_create_session(
    request: BotChatRequest,
    x_bot_api_key: str | None = Security(get_bot_api_key),
) -> BotChatSessionResponse:
    """Create a new CoPilot session owned by the resolved AutoGPT account."""
    check_bot_api_key(x_bot_api_key)

    owner_user_id = await _resolve_owner(request)
    session = await create_chat_session(owner_user_id, dry_run=False)

    logger.info(
        "Bot created session %s for %s (server %s, owner ...%s)",
        session.session_id,
        request.platform.value,
        request.platform_server_id or "DM",
        owner_user_id[-8:],
    )

    return BotChatSessionResponse(session_id=session.session_id)


@router.post(
    "/chat/stream",
    summary="Stream a CoPilot response for a platform user (bot-facing)",
)
async def bot_chat_stream(
    request: BotChatRequest,
    x_bot_api_key: str | None = Security(get_bot_api_key),
):
    """Send a message to CoPilot and stream the response as SSE."""
    check_bot_api_key(x_bot_api_key)

    owner_user_id = await _resolve_owner(request)

    session_id = request.session_id
    if session_id:
        session = await get_chat_session(session_id, owner_user_id)
        if not session:
            raise HTTPException(status_code=404, detail="Session not found.")
    else:
        session = await create_chat_session(owner_user_id, dry_run=False)
        session_id = session.session_id

    message = ChatMessage(role="user", content=request.message)
    await append_and_save_message(session_id, message)

    turn_id = str(uuid4())

    await stream_registry.create_session(
        session_id=session_id,
        user_id=owner_user_id,
        tool_call_id="chat_stream",
        tool_name="chat",
        turn_id=turn_id,
    )

    subscribe_from_id = "0-0"

    logger.info(
        "Bot chat: %s (server %s, session %s, turn %s, owner ...%s)",
        request.platform.value,
        request.platform_server_id or "DM",
        session_id,
        turn_id,
        owner_user_id[-8:],
    )

    async def event_generator():
        subscriber_queue = None
        try:
            subscriber_queue = await stream_registry.subscribe_to_session(
                session_id=session_id,
                user_id=owner_user_id,
                last_message_id=subscribe_from_id,
            )

            if subscriber_queue is None:
                yield StreamFinish().to_sse()
                yield "data: [DONE]\n\n"
                return

            # Enqueue AFTER subscribing so the executor can't emit stream
            # events that would arrive before we're listening.
            await enqueue_copilot_turn(
                session_id=session_id,
                user_id=owner_user_id,
                message=request.message,
                turn_id=turn_id,
                is_user_message=True,
            )

            while True:
                try:
                    chunk = await asyncio.wait_for(subscriber_queue.get(), timeout=30.0)

                    yield chunk if isinstance(chunk, str) else chunk.to_sse()

                    if isinstance(chunk, StreamFinish) or (
                        isinstance(chunk, str) and "[DONE]" in chunk
                    ):
                        break

                except asyncio.TimeoutError:
                    yield ": keepalive\n\n"

        except Exception:
            logger.exception("Bot chat stream error for session %s", session_id)
            yield 'data: {"type": "error", "content": "Stream error"}\n\n'
            yield "data: [DONE]\n\n"
        finally:
            if subscriber_queue is not None:
                await stream_registry.unsubscribe_from_session(
                    session_id=session_id,
                    subscriber_queue=subscriber_queue,
                )

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            # Disable proxy buffering (nginx) so SSE chunks flush immediately.
            "X-Accel-Buffering": "no",
            "X-Session-Id": session_id,
        },
    )
