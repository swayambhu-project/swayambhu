"""Shared agent tool loop."""

import json
import time
from typing import Any

from loguru import logger

BUDGET_WARNING = "Budget low. Wrap up and stop."
REFLECT_PROMPT = "Reflect on the results and decide next steps."
MAX_CONTEXT_CHARS = 20_000  # rough limit before trimming old tool results
READ_ONLY_TOOLS = frozenset({"read_file", "list_dir", "web_search", "web_fetch"})


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


async def run_tool_loop(
    provider,
    messages: list[dict[str, Any]],
    tools,  # ToolRegistry
    model: str,
    max_requests: int = 25,
    max_minutes: int | None = None,
    context=None,  # ContextBuilder — uses add_assistant_message/add_tool_result if provided
) -> tuple[dict | None, list[dict[str, Any]], list[str]]:
    """
    Run the agent tool loop.

    Returns: (stop_result, updated_messages, tools_used)
    - stop_result: dict with reason/next_steps from stop tool, or synthetic on budget exhaustion
    - messages: full conversation history
    - tools_used: list of tool names called
    """
    requests_used = 0
    tools_used: list[str] = []
    start_time = time.time()

    while requests_used < max_requests:
        # Time budget check
        if max_minutes:
            elapsed = (time.time() - start_time) / 60
            if elapsed >= max_minutes:
                return {
                    "reason": "time_budget_exhausted",
                    "next_steps": "Continue from where I left off",
                }, messages, tools_used

        # Request budget warning
        if requests_used == max_requests - 2:
            messages.append({"role": "user", "content": BUDGET_WARNING})

        # Trim context before calling LLM
        messages = _trim_tool_results(messages)

        # Call LLM
        response = await provider.chat(messages, tools.get_definitions(), model)
        requests_used += 1

        if response.has_tool_calls:
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
                if tc.name == "stop":
                    # Session ends
                    return tc.arguments, messages, tools_used

                tools_used.append(tc.name)
                args_str = json.dumps(tc.arguments, ensure_ascii=False)
                logger.info(f"Tool call: {tc.name}({args_str[:200]})")
                result = await tools.execute(tc.name, tc.arguments)

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
            # Skip reflect after read-only batches to save budget
            batch_names = {tc.name for tc in response.tool_calls}
            if not batch_names.issubset(READ_ONLY_TOOLS):
                messages.append({"role": "user", "content": REFLECT_PROMPT})

        else:
            # Text only = thinking. Keep in history, continue.
            text = response.content or ""
            preview = text[:200] + "..." if len(text) > 200 else text
            logger.info(f"Thinking: {preview}")
            if context:
                messages = context.add_assistant_message(messages, text, [])
            else:
                messages.append({"role": "assistant", "content": text})

    # Budget exhausted — force stop
    return {
        "reason": "budget_exhausted",
        "next_steps": "Continue from where I left off",
    }, messages, tools_used
