"""Discord channel implementation using discord.py."""

import discord
from loguru import logger

from swayambhu.bus.events import OutboundMessage
from swayambhu.bus.queue import MessageBus
from swayambhu.channels.base import BaseChannel
from swayambhu.config.schema import DiscordConfig


class DiscordChannel(BaseChannel):
    """Discord channel using discord.py bot client."""

    name = "discord"

    def __init__(self, config: DiscordConfig, bus: MessageBus):
        super().__init__(config, bus)
        self.config: DiscordConfig = config
        intents = discord.Intents.default()
        intents.message_content = True
        self._client = discord.Client(intents=intents)
        self._setup_handlers()

    def _setup_handlers(self):
        @self._client.event
        async def on_ready():
            logger.info(f"Discord bot connected as {self._client.user}")

        @self._client.event
        async def on_message(message: discord.Message):
            if message.author == self._client.user:
                return
            if message.author.bot:
                return

            # Filter by allowed channels
            if self.config.allow_channel_ids:
                if str(message.channel.id) not in self.config.allow_channel_ids:
                    return

            await self._handle_message(
                sender_id=str(message.author.id),
                chat_id=str(message.channel.id),
                content=message.content,
                metadata={
                    "author_name": str(message.author),
                    "guild_id": str(message.guild.id) if message.guild else "",
                    "message_id": str(message.id),
                },
            )

    async def start(self) -> None:
        if not self.config.bot_token:
            logger.error("Discord channel: bot_token not configured")
            return
        self._running = True
        logger.info("Starting Discord channel...")
        await self._client.start(self.config.bot_token)

    async def stop(self) -> None:
        self._running = False
        await self._client.close()

    async def send(self, msg: OutboundMessage) -> None:
        channel = self._client.get_channel(int(msg.chat_id))
        if channel is None:
            try:
                channel = await self._client.fetch_channel(int(msg.chat_id))
            except Exception as e:
                logger.error(f"Discord: could not fetch channel {msg.chat_id}: {e}")
                return

        # Discord message limit is 2000 chars — split if needed
        content = msg.content or ""
        for i in range(0, max(1, len(content)), 2000):
            chunk = content[i : i + 2000]
            await channel.send(chunk)
