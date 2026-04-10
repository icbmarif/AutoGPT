"""CoPilot service — shared helpers used by both SDK and baseline paths.

This module contains:
- System prompt building (Langfuse + static fallback, cache-optimised)
- User context injection (prepends <user_context> to first user message)
- Session title generation
- Session assignment
- Shared config and client instances
"""

import asyncio
import logging
from typing import Any

from langfuse import get_client
from langfuse.openai import (
    AsyncOpenAI as LangfuseAsyncOpenAI,  # pyright: ignore[reportPrivateImportUsage]
)

from backend.data.db_accessors import chat_db, understanding_db
from backend.data.understanding import format_understanding_for_prompt
from backend.util.exceptions import NotAuthorizedError, NotFoundError
from backend.util.settings import AppEnvironment, Settings

from .config import ChatConfig
from .model import (
    ChatMessage,
    ChatSessionInfo,
    get_chat_session,
    update_session_title,
    upsert_chat_session,
)

logger = logging.getLogger(__name__)

config = ChatConfig()
settings = Settings()

_client: LangfuseAsyncOpenAI | None = None
_langfuse = None


def _get_openai_client() -> LangfuseAsyncOpenAI:
    global _client
    if _client is None:
        _client = LangfuseAsyncOpenAI(api_key=config.api_key, base_url=config.base_url)
    return _client


def _get_langfuse():
    global _langfuse
    if _langfuse is None:
        _langfuse = get_client()
    return _langfuse


# Static system prompt for token caching — identical for all users.
# User-specific context is injected into the first user message instead,
# so the system prompt never changes and can be cached across all sessions.
_CACHEABLE_SYSTEM_PROMPT = """You are an AI automation assistant helping users build and run automations.

Your goal is to help users automate tasks by:
- Understanding their needs and business context
- Building and running working automations
- Delivering tangible value through action, not just explanation

Be concise, proactive, and action-oriented. Bias toward showing working solutions over lengthy explanations.

When the user provides a <user_context> block in their message, use it to personalise your responses.
For users you are meeting for the first time with no context provided, greet them warmly and introduce them to the AutoGPT platform."""


# ---------------------------------------------------------------------------
# Shared helpers (used by SDK service and baseline)
# ---------------------------------------------------------------------------


def _is_langfuse_configured() -> bool:
    """Check if Langfuse credentials are configured."""
    return bool(
        settings.secrets.langfuse_public_key and settings.secrets.langfuse_secret_key
    )


async def _fetch_langfuse_prompt() -> str | None:
    """Fetch the static system prompt from Langfuse.

    Returns the compiled prompt string, or None if Langfuse is unconfigured
    or the fetch fails. Passes an empty users_information placeholder so the
    prompt text is identical across all users (enabling cross-session caching).
    """
    if not _is_langfuse_configured():
        return None
    try:
        label = (
            None if settings.config.app_env == AppEnvironment.PRODUCTION else "latest"
        )
        prompt = await asyncio.to_thread(
            _get_langfuse().get_prompt,
            config.langfuse_prompt_name,
            label=label,
            cache_ttl_seconds=config.langfuse_prompt_cache_ttl,
        )
        return prompt.compile(users_information="")
    except Exception as e:
        logger.warning(f"Failed to fetch prompt from Langfuse, using default: {e}")
        return None


async def _build_system_prompt(
    user_id: str | None,
) -> tuple[str, Any]:
    """Build a fully static system prompt suitable for LLM token caching.

    User-specific context is NOT embedded here. Callers must inject the
    returned understanding into the first user message via inject_user_context()
    so the system prompt stays identical across all users and sessions,
    enabling cross-session cache hits.

    Returns:
        Tuple of (static_prompt, understanding_object_or_None)
    """
    understanding = None
    if user_id:
        try:
            understanding = await understanding_db().get_business_understanding(user_id)
        except Exception as e:
            logger.warning(f"Failed to fetch business understanding: {e}")

    prompt = await _fetch_langfuse_prompt() or _CACHEABLE_SYSTEM_PROMPT
    return prompt, understanding


async def inject_user_context(
    understanding: Any,
    message: str,
    session_id: str,
    session_messages: list[ChatMessage],
) -> str | None:
    """Prepend a <user_context> block to the first user message.

    Updates the in-memory session_messages list and persists the prefixed
    content to the DB so resumed sessions and page reloads retain
    personalisation.

    Returns:
        The prefixed message string, or None if no user message was found.
    """
    user_ctx = format_understanding_for_prompt(understanding)
    prefixed = f"<user_context>\n{user_ctx}\n</user_context>\n\n{message}"
    for idx, session_msg in enumerate(session_messages):
        if session_msg.role == "user":
            session_msg.content = prefixed
            sequence = session_msg.sequence if session_msg.sequence is not None else idx
            await chat_db().update_message_content_by_sequence(
                session_id, sequence, prefixed
            )
            return prefixed
    return None


async def _generate_session_title(
    message: str,
    user_id: str | None = None,
    session_id: str | None = None,
) -> str | None:
    """Generate a concise title for a chat session based on the first message.

    Args:
        message: The first user message in the session
        user_id: User ID for OpenRouter tracing (optional)
        session_id: Session ID for OpenRouter tracing (optional)

    Returns:
        A short title (3-6 words) or None if generation fails
    """
    try:
        # Build extra_body for OpenRouter tracing and PostHog analytics
        extra_body: dict[str, Any] = {}
        if user_id:
            extra_body["user"] = user_id[:128]  # OpenRouter limit
            extra_body["posthogDistinctId"] = user_id
        if session_id:
            extra_body["session_id"] = session_id[:128]  # OpenRouter limit
        extra_body["posthogProperties"] = {
            "environment": settings.config.app_env.value,
        }

        response = await _get_openai_client().chat.completions.create(
            model=config.title_model,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Generate a very short title (3-6 words) for a chat conversation "
                        "based on the user's first message. The title should capture the "
                        "main topic or intent. Return ONLY the title, no quotes or punctuation."
                    ),
                },
                {"role": "user", "content": message[:500]},  # Limit input length
            ],
            max_tokens=20,
            extra_body=extra_body,
        )
        title = response.choices[0].message.content
        if title:
            # Clean up the title
            title = title.strip().strip("\"'")
            # Limit length
            if len(title) > 50:
                title = title[:47] + "..."
            return title
        return None
    except Exception as e:
        logger.warning(f"Failed to generate session title: {e}")
        return None


async def _update_title_async(
    session_id: str, message: str, user_id: str | None = None
) -> None:
    """Generate and persist a session title in the background.

    Shared by both the SDK and baseline execution paths.
    """
    try:
        title = await _generate_session_title(message, user_id, session_id)
        if title and user_id:
            await update_session_title(session_id, user_id, title, only_if_empty=True)
            logger.debug("Generated title for session %s", session_id)
    except Exception as e:
        logger.warning("Failed to update session title for %s: %s", session_id, e)


async def assign_user_to_session(
    session_id: str,
    user_id: str,
) -> ChatSessionInfo:
    """
    Assign a user to a chat session.
    """
    session = await get_chat_session(session_id, None)
    if not session:
        raise NotFoundError(f"Session {session_id} not found")
    if session.user_id is not None and session.user_id != user_id:
        logger.warning(
            f"[SECURITY] Attempt to claim session {session_id} by user {user_id}, "
            f"but it already belongs to user {session.user_id}"
        )
        raise NotAuthorizedError(f"Not authorized to claim session {session_id}")
    session.user_id = user_id
    session = await upsert_chat_session(session)
    return session
