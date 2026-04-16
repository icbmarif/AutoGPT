"""CoPilot Chat Bridge process entry point.

Runs the enabled chat-platform adapters (Discord, Telegram, Slack) that bridge
AutoPilot to external chat platforms. Always starts — idles if no platform
adapters are configured so the service stays resilient across restarts.
"""

import asyncio
import logging

from backend.util.process import AppProcess

from .adapters.base import PlatformAdapter
from .adapters.discord import config as discord_config
from .adapters.discord.adapter import DiscordAdapter
from .handler import MessageHandler
from .platform_api import PlatformAPI

logger = logging.getLogger(__name__)

# Idle when no adapters configured so the process stays up for health checks
# and future runtime reconfiguration.
_NO_ADAPTER_SLEEP_SECONDS = 3600


class CoPilotChatBridge(AppProcess):
    """Bridges AutoPilot to external chat platforms via per-platform adapters."""

    @property
    def service_name(self) -> str:
        return "CoPilotChatBridge"

    def run(self) -> None:
        asyncio.run(self._run_async())

    async def _run_async(self) -> None:
        api = PlatformAPI()
        adapters = _build_adapters(api)

        if not adapters:
            logger.info(
                "CoPilotChatBridge: no platform adapters configured — idling. "
                "Set AUTOPILOT_BOT_DISCORD_TOKEN (or another platform token) to "
                "enable an adapter."
            )
            try:
                while True:
                    await asyncio.sleep(_NO_ADAPTER_SLEEP_SECONDS)
            finally:
                await api.close()

        handler = MessageHandler(api)
        for adapter in adapters:
            adapter.on_message(handler.handle)

        try:
            await asyncio.gather(*(a.start() for a in adapters))
        finally:
            await asyncio.gather(*(a.stop() for a in adapters), return_exceptions=True)
            await api.close()


def _build_adapters(api: PlatformAPI) -> list[PlatformAdapter]:
    """Instantiate adapters based on which platform tokens are configured."""
    adapters: list[PlatformAdapter] = []
    if discord_config.BOT_TOKEN:
        adapters.append(DiscordAdapter(api))
        logger.info("Discord adapter enabled")
    # Future:
    # if telegram_config.BOT_TOKEN:
    #     adapters.append(TelegramAdapter(api))
    # if slack_config.BOT_TOKEN:
    #     adapters.append(SlackAdapter(api))
    return adapters
