"""Agent loop: the core processing engine."""

import asyncio
from pathlib import Path
from typing import Any

from loguru import logger

from swayambhu.bus.events import InboundMessage, OutboundMessage
from swayambhu.bus.queue import MessageBus
from swayambhu.providers.base import LLMProvider
from swayambhu.agent.context import ContextBuilder
from swayambhu.agent.chat_logger import ChatLogger
from swayambhu.agent.engine import run_tool_loop
from swayambhu.agent.tools.registry import ToolRegistry
from swayambhu.agent.tools.filesystem import ReadFileTool, WriteFileTool, EditFileTool, ListDirTool
from swayambhu.agent.tools.shell import ExecTool
from swayambhu.agent.tools.web import WebSearchTool, WebFetchTool
from swayambhu.agent.tools.message import MessageTool
from swayambhu.agent.tools.spawn import SpawnTool
from swayambhu.agent.tools.cron import CronTool
from swayambhu.agent.tools.sleep import SleepTool
from swayambhu.agent.subagent import SubagentManager
from swayambhu.session.manager import SessionManager


class AgentLoop:
    """
    The agent loop is the core processing engine.
    
    It:
    1. Receives messages from the bus
    2. Builds context with history, memory, skills
    3. Calls the LLM
    4. Executes tool calls
    5. Sends responses back
    """
    
    def __init__(
        self,
        bus: MessageBus,
        provider: LLMProvider,
        workspace: Path,
        model: str | None = None,
        max_iterations: int = 25,
        max_minutes: int | None = None,
        memory_window: int = 50,
        brave_api_key: str | None = None,
        exec_config: "ExecToolConfig | None" = None,
        cron_service: "CronService | None" = None,
        restrict_to_workspace: bool = False,
        session_manager: SessionManager | None = None,
        reasoning_effort: str | None = None,
    ):
        from swayambhu.config.schema import ExecToolConfig
        from swayambhu.cron.service import CronService
        self.bus = bus
        self.provider = provider
        self.workspace = workspace
        self.model = model or provider.get_default_model()
        self.max_requests = max_iterations  # budget: max LLM API calls per session
        self.max_minutes = max_minutes  # budget: max session duration
        self.memory_window = memory_window
        self.brave_api_key = brave_api_key
        self.exec_config = exec_config or ExecToolConfig()
        self.cron_service = cron_service
        self.restrict_to_workspace = restrict_to_workspace
        self.reasoning_effort = reasoning_effort

        self.context = ContextBuilder(workspace)
        self.sessions = session_manager or SessionManager(workspace)
        self.chat_logger = ChatLogger(workspace / "logs" / "chat")
        self.tools = ToolRegistry()
        self.subagents = SubagentManager(
            provider=provider,
            workspace=workspace,
            bus=bus,
            model=self.model,
            brave_api_key=brave_api_key,
            exec_config=self.exec_config,
            restrict_to_workspace=restrict_to_workspace,
        )
        
        self._running = False
        self._register_default_tools()
    
    def _register_default_tools(self) -> None:
        """Register the default set of tools."""
        # File tools (resolve relative paths against workspace)
        allowed_dir = self.workspace if self.restrict_to_workspace else None
        self.tools.register(ReadFileTool(workspace=self.workspace, allowed_dir=allowed_dir))
        self.tools.register(WriteFileTool(workspace=self.workspace, allowed_dir=allowed_dir))
        self.tools.register(EditFileTool(workspace=self.workspace, allowed_dir=allowed_dir))
        self.tools.register(ListDirTool(workspace=self.workspace, allowed_dir=allowed_dir))
        
        # Shell tool
        self.tools.register(ExecTool(
            working_dir=str(self.workspace),
            timeout=self.exec_config.timeout,
            restrict_to_workspace=self.restrict_to_workspace,
        ))
        
        # Web tools
        self.tools.register(WebSearchTool())
        self.tools.register(WebFetchTool())
        
        # Message tool
        message_tool = MessageTool(send_callback=self.bus.publish_outbound)
        self.tools.register(message_tool)
        
        # Spawn tool (for subagents)
        spawn_tool = SpawnTool(manager=self.subagents)
        self.tools.register(spawn_tool)
        
        # Cron tool (for scheduling)
        if self.cron_service:
            self.tools.register(CronTool(self.cron_service))

        # Sleep tool (session termination — intercepted by engine, never executed)
        self.tools.register(SleepTool())
    
    async def run(self) -> None:
        """Run the agent loop, processing messages from the bus."""
        self._running = True
        logger.info("Agent loop started")
        
        while self._running:
            try:
                # Wait for next message
                msg = await asyncio.wait_for(
                    self.bus.consume_inbound(),
                    timeout=1.0
                )
                
                # Process it
                try:
                    response = await self._process_message(msg)
                    if response:
                        await self.bus.publish_outbound(response)
                except Exception as e:
                    logger.error(f"Error processing message: {e}")
                    # Send error response
                    await self.bus.publish_outbound(OutboundMessage(
                        channel=msg.channel,
                        chat_id=msg.chat_id,
                        content=f"Sorry, I encountered an error: {str(e)}"
                    ))
            except asyncio.TimeoutError:
                continue
    
    def stop(self) -> None:
        """Stop the agent loop."""
        self._running = False
        logger.info("Agent loop stopping")
    
    async def _process_message(self, msg: InboundMessage, session_key: str | None = None) -> OutboundMessage | None:
        """
        Process a single inbound message.
        
        Args:
            msg: The inbound message to process.
            session_key: Override session key (used by process_direct).
        
        Returns:
            The response message, or None if no response needed.
        """
        # Handle system messages (subagent announces)
        # The chat_id contains the original "channel:chat_id" to route back to
        if msg.channel == "system":
            return await self._process_system_message(msg)
        
        preview = msg.content[:80] + "..." if len(msg.content) > 80 else msg.content
        logger.info(f"Processing message from {msg.channel}:{msg.sender_id}: {preview}")
        
        # Get or create session
        key = session_key or msg.session_key
        session = self.sessions.get_or_create(key)
        
        # Handle slash commands
        cmd = msg.content.strip().lower()
        if cmd == "/new":
            session.clear()
            self.sessions.save(session)
            return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id,
                                  content="New session started.")
        if cmd == "/help":
            return OutboundMessage(channel=msg.channel, chat_id=msg.chat_id,
                                  content="🐈 swayambhu commands:\n/new — Start a new conversation\n/help — Show available commands")
        
        # Update tool contexts
        message_tool = self.tools.get("message")
        if isinstance(message_tool, MessageTool):
            message_tool.set_context(msg.channel, msg.chat_id)
        
        spawn_tool = self.tools.get("spawn")
        if isinstance(spawn_tool, SpawnTool):
            spawn_tool.set_context(msg.channel, msg.chat_id)
        
        cron_tool = self.tools.get("cron")
        if isinstance(cron_tool, CronTool):
            cron_tool.set_context(msg.channel, msg.chat_id)
        
        # Build initial messages (use get_history for LLM-formatted messages)
        messages = self.context.build_messages(
            history=session.get_history(),
            current_message=msg.content,
            media=msg.media if msg.media else None,
            channel=msg.channel,
            chat_id=msg.chat_id,
        )
        
        # Clear scratch pad for new session
        (self.workspace / "scratch.md").write_text("# Scratch\n", encoding="utf-8")

        # Agent loop
        self.chat_logger.start_session(key, self.model)
        sleep_result, messages, tools_used = await run_tool_loop(
            provider=self.provider,
            messages=messages,
            tools=self.tools,
            model=self.model,
            max_requests=self.max_requests,
            max_minutes=self.max_minutes,
            context=self.context,
            reasoning_effort=self.reasoning_effort,
            chat_logger=self.chat_logger,
        )
        await self._handle_sleep(sleep_result)
        logger.info(f"Session ended: {sleep_result.get('reason', 'unknown')}")

        # Save user message to session
        session.add_message("user", msg.content)
        self.sessions.save(session)

        # No outbound message — the model communicates via the message tool during the loop
        return None

    async def _process_system_message(self, msg: InboundMessage) -> OutboundMessage | None:
        """
        Process a system message (e.g., subagent announce).
        
        The chat_id field contains "original_channel:original_chat_id" to route
        the response back to the correct destination.
        """
        logger.info(f"Processing system message from {msg.sender_id}")
        
        # Parse origin from chat_id (format: "channel:chat_id")
        if ":" in msg.chat_id:
            parts = msg.chat_id.split(":", 1)
            origin_channel = parts[0]
            origin_chat_id = parts[1]
        else:
            # Fallback
            origin_channel = "cli"
            origin_chat_id = msg.chat_id
        
        # Use the origin session for context
        session_key = f"{origin_channel}:{origin_chat_id}"
        session = self.sessions.get_or_create(session_key)
        
        # Update tool contexts
        message_tool = self.tools.get("message")
        if isinstance(message_tool, MessageTool):
            message_tool.set_context(origin_channel, origin_chat_id)
        
        spawn_tool = self.tools.get("spawn")
        if isinstance(spawn_tool, SpawnTool):
            spawn_tool.set_context(origin_channel, origin_chat_id)
        
        cron_tool = self.tools.get("cron")
        if isinstance(cron_tool, CronTool):
            cron_tool.set_context(origin_channel, origin_chat_id)
        
        # Build messages with the announce content
        messages = self.context.build_messages(
            history=session.get_history(),
            current_message=msg.content,
            channel=origin_channel,
            chat_id=origin_chat_id,
        )
        
        # Clear scratch pad for new session
        (self.workspace / "scratch.md").write_text("# Scratch\n", encoding="utf-8")

        # Agent loop
        self.chat_logger.start_session(session_key, self.model)
        sleep_result, messages, _ = await run_tool_loop(
            provider=self.provider,
            messages=messages,
            tools=self.tools,
            model=self.model,
            max_requests=self.max_requests,
            max_minutes=self.max_minutes,
            context=self.context,
            reasoning_effort=self.reasoning_effort,
            chat_logger=self.chat_logger,
        )
        await self._handle_sleep(sleep_result)
        logger.info(f"System session ended: {sleep_result.get('reason', 'unknown')}")

        # Save system message to session
        session.add_message("user", f"[System: {msg.sender_id}] {msg.content}")
        self.sessions.save(session)

        return None

    async def _handle_sleep(self, sleep_result: dict) -> None:
        """Schedule wake if requested."""
        # Schedule wake if requested
        reason = sleep_result.get("reason", "unknown")
        next_steps = sleep_result.get("next_steps", "")
        wake_after = sleep_result.get("wake_after")
        if wake_after and self.cron_service:
            try:
                ms = self._parse_duration_ms(wake_after)
                import time
                from swayambhu.cron.types import CronSchedule
                at_ms = int(time.time() * 1000) + ms
                self.cron_service.add_job(
                    name=f"wake: {next_steps[:50]}",
                    schedule=CronSchedule(kind="at", at_ms=at_ms),
                    message=f"Waking up. Previous session: {reason}. Plan: {next_steps}",
                    delete_after_run=True,
                )
                logger.info(f"Scheduled wake in {wake_after} (at_ms={at_ms})")
            except Exception as e:
                logger.warning(f"Failed to schedule wake_after={wake_after!r}: {e}")

    @staticmethod
    def _parse_duration_ms(s: str) -> int:
        """Parse a duration string like '30m', '6h', '1d' to milliseconds."""
        s = s.strip().lower()
        multipliers = {"m": 60_000, "h": 3_600_000, "d": 86_400_000, "s": 1_000}
        for suffix, mult in multipliers.items():
            if s.endswith(suffix):
                return int(float(s[:-len(suffix)]) * mult)
        # Fallback: assume minutes
        return int(float(s) * 60_000)

    async def process_direct(
        self,
        content: str,
        session_key: str = "cli:direct",
        channel: str = "cli",
        chat_id: str = "direct",
    ) -> str:
        """
        Process a message directly (for CLI or cron usage).
        
        Args:
            content: The message content.
            session_key: Session identifier (overrides channel:chat_id for session lookup).
            channel: Source channel (for tool context routing).
            chat_id: Source chat ID (for tool context routing).
        
        Returns:
            The agent's response.
        """
        msg = InboundMessage(
            channel=channel,
            sender_id="user",
            chat_id=chat_id,
            content=content
        )
        
        response = await self._process_message(msg, session_key=session_key)
        return response.content if response else ""
