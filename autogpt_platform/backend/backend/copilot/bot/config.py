"""Shared configuration — platform-agnostic only.

Platform-specific config (tokens, limits) lives in adapters/<platform>/config.py.
"""

import os

PLATFORM_BOT_API_KEY: str = os.getenv("PLATFORM_BOT_API_KEY", "")
AUTOGPT_API_URL: str = os.getenv("AUTOGPT_API_URL", "http://localhost:8006")
AUTOGPT_FRONTEND_URL: str = os.getenv(
    "AUTOGPT_FRONTEND_URL", "https://platform.agpt.co"
)

# Max seconds between SSE events from the backend before we consider the
# connection dead. Resets on every chunk or keepalive.
SSE_IDLE_TIMEOUT = 90

# Cache TTL for AutoPilot session IDs (per channel/thread)
SESSION_TTL = 86400  # 24 hours
