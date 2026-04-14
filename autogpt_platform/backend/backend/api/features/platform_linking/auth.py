"""Bot API key authentication for platform linking endpoints."""

import hmac
import logging
import os
from functools import lru_cache

from fastapi import HTTPException, Security
from fastapi.security import APIKeyHeader

from backend.util.settings import Settings

logger = logging.getLogger(__name__)


# APIKeyHeader lets FastAPI emit a proper `X-Bot-API-Key` security scheme in
# the OpenAPI spec. auto_error=False because dev-mode allows keyless requests
# when enable_auth is False — we surface a 401 ourselves in check_bot_api_key.
_bot_api_key_scheme = APIKeyHeader(name="X-Bot-API-Key", auto_error=False)


@lru_cache(maxsize=1)
def _auth_enabled() -> bool:
    """Cached read of Settings().config.enable_auth.

    Called on every unauthenticated bot request — instantiating Settings each
    time is expensive (reads env + pydantic validation). Auth-enabled doesn't
    flip at runtime, so caching is safe.
    """
    return Settings().config.enable_auth


async def get_bot_api_key(
    api_key: str | None = Security(_bot_api_key_scheme),
) -> str | None:
    """Extract the bot API key from the X-Bot-API-Key header.

    Declared via APIKeyHeader so routes using ``Security(get_bot_api_key)``
    get the X-Bot-API-Key scheme on their OpenAPI operation.
    """
    return api_key


def check_bot_api_key(api_key: str | None) -> None:
    """Validate the bot API key. Uses constant-time comparison.

    Reads the key from env on each call so rotated secrets take effect
    without restarting the process.
    """
    configured_key = os.getenv("PLATFORM_BOT_API_KEY", "")

    if not configured_key:
        if _auth_enabled():
            raise HTTPException(
                status_code=503,
                detail="Bot API key not configured.",
            )
        # Auth disabled (local dev) — allow without key, but warn so this
        # is never silent in staging or misconfigured production deployments.
        logger.warning(
            "PLATFORM_BOT_API_KEY is not set and auth is disabled — "
            "all bot-facing platform linking endpoints are unauthenticated. "
            "Set PLATFORM_BOT_API_KEY in your environment for any non-local deployment."
        )
        return

    if not api_key or not hmac.compare_digest(api_key, configured_key):
        raise HTTPException(status_code=401, detail="Invalid bot API key.")
