"""Shared agent tool loop."""

import json
import time
from typing import Any

from loguru import logger

BUDGET_WARNING = "Budget low. Enter your Sleep phase now."
CONTINUE_PROMPT = "Continue."
SOUL_CHECK_PROMPT = "Continue. Is this aligned with your SOUL?"
SOUL_CHECK_INTERVAL = 4  # inject SOUL check every N reflect-worthy actions
IDLE_NUDGE = (
    "You have been thinking without acting. "
    "Either use a tool to make progress, or call sleep to end your session."
)
MAX_CONTEXT_CHARS = 20_000  # rough limit before trimming old tool results
DEFAULT_IDLE_TOKEN_THRESHOLD = 1500  # max text-only tokens before nudge/force-stop
WORKSPACE_PREFIXES = ("workspace/", "swayambhu/")  # paths that are "recall" — no reflection needed
SLEEP_ALIASES = frozenset({"sleep", "stop", "exit", "quit", "done"})


def _trim_tool_results(messages: list[dict], max_chars: int = MAX_CONTEXT_CHARS) -> list[dict]:
    """Shrink old tool results to keep context under the token limit.

    Keeps the system prompt and the most recent messages intact.
    Replaces old tool result content with a short note.
    """
    total = sum(len(str(m.get("content", ""))) for m in messages)
    if total <= max_chars:
        return messages

    # Walk from oldest to newest, truncate tool results until under limit
    for m in messages:
        if total <= max_chars:
            break
        if m.get("role") == "tool":
            content = m.get("content", "")
            if len(content) > 120:
                short = content[:80] + f"\n[...trimmed {len(content)} chars]"
                total -= len(content) - len(short)
                m["content"] = short

    return messages


def _batch_needs_reflect(tool_calls) -> bool:
    """Return True unless every call in the batch is a workspace file read."""
    for tc in tool_calls:
        if tc.name not in ("read_file", "list_dir"):
            return True
        path = tc.arguments.get("path", "")
        if not path.startswith(WORKSPACE_PREFIXES):
            return True
    return False


async def run_tool_loop(
    provider,
    messages: list[dict[str, Any]],
    tools,  # ToolRegistry
    model: str,
    max_requests: int = 25,
    max_minutes: int | None = None,
    context=None,  # ContextBuilder — uses add_assistant_message/add_tool_result if provided
    session_state: dict | None = None,  # Shared mutable state visible to tools (e.g. phase)
    reasoning_effort: str | None = None,  # None = no toggle; "low"/"medium"/"high" for routine calls
    reflect_reasoning_effort: str = "high",  # Reasoning level for reflection steps
    idle_token_threshold: int = DEFAULT_IDLE_TOKEN_THRESHOLD,  # Text-only tokens before nudge
    idle_token_limit: int = 500,  # Text-only tokens after nudge before force-stop
    chat_logger=None,  # optional ChatLogger for full transcript logging
) -> tuple[dict | None, list[dict[str, Any]], list[str]]:
    """
    Run the agent tool loop.

    Returns: (sleep_result, updated_messages, tools_used)
    - sleep_result: dict with reason/next_steps from sleep tool, or synthetic on budget exhaustion
    - messages: full conversation history
    - tools_used: list of tool names called
    """
    requests_used = 0
    tools_used: list[str] = []
    start_time = time.time()

    # Reasoning toggle: when configured, routine calls use "none" and
    # reflect calls (after non-read-only tools) use the configured level.
    can_reason = reasoning_effort is not None
    next_reasoning: str | None = "none" if can_reason else None

    # Idle detection: cumulative completion tokens since last tool call.
    # A healthy agent thinks briefly then acts. If it burns tokens without
    # action, it's stuck. Nudge once, then force-stop.
    idle_tokens = 0
    idle_nudged = False
    action_count = 0  # reflect-worthy actions since last SOUL check

    while requests_used < max_requests:
        # Time budget check
        if max_minutes:
            elapsed = (time.time() - start_time) / 60
            if elapsed >= max_minutes:
                if chat_logger:
                    _end_log(chat_logger, requests_used, messages, tools_used)
                return {
                    "reason": "time_budget_exhausted",
                    "next_steps": "Continue from where I left off",
                }, messages, tools_used

        # Phase tracking (shared with tools via session_state)
        if session_state is not None:
            if requests_used == 0:
                session_state["phase"] = "wake"
            elif requests_used >= max_requests - 2:
                session_state["phase"] = "sleep"
            else:
                session_state["phase"] = "act"

        # Request budget warning
        if requests_used == max_requests - 2:
            messages.append({"role": "user", "content": BUDGET_WARNING})

        # Trim context before calling LLM
        messages = _trim_tool_results(messages)

        # Rebuild system prompt (static content — caches well across calls)
        if context and messages and messages[0].get("role") == "system":
            messages[0]["content"] = context.build_system_prompt()

        # Log request
        if chat_logger:
            # Find last user message for the transcript
            last_user = next(
                (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
                None,
            )
            chat_logger.log_request(
                requests_used + 1, model, len(messages),
                len(tools.get_definitions()), next_reasoning,
                last_user_content=last_user,
            )

        # Call LLM
        t0 = time.time()
        response = await provider.chat(
            messages, tools.get_definitions(), model,
            reasoning_effort=next_reasoning,
        )
        llm_ms = int((time.time() - t0) * 1000)
        requests_used += 1
        next_reasoning = "none" if can_reason else None  # reset to off

        # Log response
        if chat_logger:
            chat_logger.log_response(requests_used, response, llm_ms)

        if response.has_tool_calls:
            # Action taken — reset idle tracking
            idle_tokens = 0
            idle_nudged = False

            # Add assistant message with tool calls
            tool_call_dicts = [
                {
                    "id": tc.id,
                    "type": "function",
                    "function": {
                        "name": tc.name,
                        "arguments": json.dumps(tc.arguments),
                    },
                }
                for tc in response.tool_calls
            ]

            if response.content:
                preview = response.content[:200] + "..." if len(response.content) > 200 else response.content
                logger.info(f"Assistant: {preview}")

            if context:
                messages = context.add_assistant_message(
                    messages, response.content, tool_call_dicts,
                    reasoning_content=response.reasoning_content,
                )
            else:
                messages.append({
                    "role": "assistant",
                    "content": response.content or "",
                    "tool_calls": tool_call_dicts,
                })

            # Execute tools
            for tc in response.tool_calls:
                if tc.name in SLEEP_ALIASES:
                    # Session ends (accept common aliases for sleep)
                    if tc.name != "sleep":
                        logger.info(f"Treating '{tc.name}' as sleep")
                    if chat_logger:
                        _end_log(chat_logger, requests_used, messages, tools_used)
                    return tc.arguments, messages, tools_used

                tools_used.append(tc.name)
                args_str = json.dumps(tc.arguments, ensure_ascii=False)
                logger.info(f"Tool call: {tc.name}({args_str[:200]})")
                tool_t0 = time.time()
                result = await tools.execute(tc.name, tc.arguments)
                tool_ms = int((time.time() - tool_t0) * 1000)

                if chat_logger:
                    chat_logger.log_tool_exec(
                        requests_used, tc.name, tc.arguments, result, tool_ms,
                    )

                if context:
                    messages = context.add_tool_result(
                        messages, tc.id, tc.name, result,
                    )
                else:
                    messages.append({
                        "role": "tool",
                        "tool_call_id": tc.id,
                        "name": tc.name,
                        "content": result,
                    })

            # Interleaved CoT — helps weak models pause and think
            # Skip reflect when every tool just read internal workspace files (recall).
            # Everything else — web, writes, exec, external reads — gets reflection.
            if _batch_needs_reflect(response.tool_calls):
                action_count += 1
                if action_count % SOUL_CHECK_INTERVAL == 0:
                    prompt = SOUL_CHECK_PROMPT
                else:
                    prompt = CONTINUE_PROMPT
                messages.append({"role": "user", "content": prompt})
                if can_reason:
                    next_reasoning = reflect_reasoning_effort  # ON for reflect call

        else:
            # Text only = thinking. Keep in history, continue.
            text = response.content or ""
            preview = text[:200] + "..." if len(text) > 200 else text
            logger.info(f"Thinking: {preview}")
            if context:
                messages = context.add_assistant_message(messages, text, [])
            else:
                messages.append({"role": "assistant", "content": text})

            # If last user message is a reflect prompt, keep reasoning on
            # so the model doesn't degenerate on open-ended reflection
            last_user = next(
                (m.get("content", "") for m in reversed(messages) if m.get("role") == "user"),
                "",
            )
            if can_reason and last_user in (CONTINUE_PROMPT, SOUL_CHECK_PROMPT):
                next_reasoning = reflect_reasoning_effort

            # Idle detection: accumulate text-only tokens
            idle_tokens += response.usage.get("completion_tokens", 0)
            threshold = idle_token_limit if idle_nudged else idle_token_threshold
            if threshold and idle_tokens >= threshold:
                if idle_nudged:
                    # Already nudged once — force-stop
                    logger.warning(
                        f"Idle limit: {idle_tokens} text-only tokens after nudge. "
                        "Force-stopping session."
                    )
                    if chat_logger:
                        _end_log(chat_logger, requests_used, messages, tools_used)
                    return {
                        "reason": "idle_limit",
                        "next_steps": "Continue from where I left off",
                    }, messages, tools_used
                else:
                    # First breach — nudge
                    logger.warning(
                        f"Idle warning: {idle_tokens} text-only tokens without action. Nudging."
                    )
                    messages.append({"role": "user", "content": IDLE_NUDGE})
                    idle_nudged = True
                    idle_tokens = 0  # reset for post-nudge limit
                    if can_reason:
                        next_reasoning = reflect_reasoning_effort

    # Budget exhausted — force stop
    if chat_logger:
        _end_log(chat_logger, requests_used, messages, tools_used)
    return {
        "reason": "budget_exhausted",
        "next_steps": "Continue from where I left off",
    }, messages, tools_used


def _end_log(chat_logger, requests_used: int, messages: list[dict], tools_used: list[str]) -> None:
    """Compute total tokens from message usage metadata and end the chat log session."""
    total_tokens = sum(
        m.get("usage", {}).get("total_tokens", 0)
        for m in messages if isinstance(m.get("usage"), dict)
    )
    chat_logger.end_session(requests_used, total_tokens, tools_used)
