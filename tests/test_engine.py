"""Tests for the agent tool loop engine."""

import asyncio
from typing import Any
from dataclasses import dataclass, field

import pytest

from swayambhu.agent.engine import run_tool_loop, BUDGET_WARNING, CONTINUE_PROMPT, SOUL_CHECK_PROMPT
from swayambhu.agent.tools.base import Tool
from swayambhu.agent.tools.sleep import SleepTool
from swayambhu.agent.tools.registry import ToolRegistry
from swayambhu.providers.base import LLMResponse, ToolCallRequest


# ── Fixtures ──────────────────────────────────────────────────────────


class EchoTool(Tool):
    """Simple tool that echoes its input."""

    @property
    def name(self) -> str:
        return "echo"

    @property
    def description(self) -> str:
        return "Echo input back"

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"text": {"type": "string"}},
            "required": ["text"],
        }

    async def execute(self, **kwargs: Any) -> str:
        return kwargs["text"]


class FakeReadFileTool(Tool):
    """Mock read_file tool (name matches READ_ONLY_TOOLS)."""

    @property
    def name(self) -> str:
        return "read_file"

    @property
    def description(self) -> str:
        return "Fake read_file"

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {"path": {"type": "string"}},
            "required": ["path"],
        }

    async def execute(self, **kwargs: Any) -> str:
        return "file contents"


class MockProvider:
    """Mock LLM provider that returns scripted responses."""

    def __init__(self, responses: list[LLMResponse]):
        self.responses = list(responses)
        self.call_count = 0
        self.calls: list[tuple[list, list | None, str]] = []

    async def chat(self, messages, tools=None, model=None, **kwargs):
        self.calls.append((messages, tools, model))
        self.call_count += 1
        return self.responses.pop(0)


def make_registry(*tools: Tool) -> ToolRegistry:
    reg = ToolRegistry()
    for t in tools:
        reg.register(t)
    return reg


def tc(name: str, args: dict, id: str = "tc1") -> ToolCallRequest:
    return ToolCallRequest(id=id, name=name, arguments=args)


def text_response(content: str) -> LLMResponse:
    return LLMResponse(content=content)


def tool_response(calls: list[ToolCallRequest], content: str = "") -> LLMResponse:
    return LLMResponse(content=content, tool_calls=calls)


def sleep_response(reason: str, next_steps: str, wake_after: str | None = None) -> LLMResponse:
    args = {"reason": reason, "next_steps": next_steps}
    if wake_after:
        args["wake_after"] = wake_after
    return tool_response([tc("sleep", args)])


# ── Tests ─────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_stop_tool_ends_session():
    """Session ends when the model calls the stop tool."""
    provider = MockProvider([
        sleep_response("done", "nothing to do"),
    ])
    tools = make_registry(EchoTool(), SleepTool())
    messages = [{"role": "user", "content": "hello"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test",
    )

    assert stop_result["reason"] == "done"
    assert stop_result["next_steps"] == "nothing to do"
    assert tools_used == []  # stop is intercepted, not recorded in tools_used
    assert provider.call_count == 1


@pytest.mark.asyncio
async def test_text_response_resubmitted_as_thinking():
    """Text-only response is kept in history and loop continues."""
    provider = MockProvider([
        text_response("Let me think about this..."),
        text_response("I should use the echo tool."),
        tool_response([tc("echo", {"text": "hi"})]),
        sleep_response("done", "finished"),
    ])
    tools = make_registry(EchoTool(), SleepTool())
    messages = [{"role": "user", "content": "hello"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test",
    )

    assert stop_result["reason"] == "done"
    assert provider.call_count == 4
    # Two thinking messages should be in history
    assistant_msgs = [m for m in msgs if m.get("role") == "assistant"]
    assert len(assistant_msgs) >= 2
    assert assistant_msgs[0]["content"] == "Let me think about this..."
    assert assistant_msgs[1]["content"] == "I should use the echo tool."


@pytest.mark.asyncio
async def test_tool_execution_with_reflect_prompt():
    """After tool execution, a reflect prompt is injected."""
    provider = MockProvider([
        tool_response([tc("echo", {"text": "hello"})]),
        sleep_response("done", "next"),
    ])
    tools = make_registry(EchoTool(), SleepTool())
    messages = [{"role": "user", "content": "start"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test",
    )

    assert "echo" in tools_used
    # Check reflect prompt was injected
    reflect_msgs = [m for m in msgs if m.get("content") in (CONTINUE_PROMPT, SOUL_CHECK_PROMPT)]
    assert len(reflect_msgs) == 1


@pytest.mark.asyncio
async def test_budget_exhaustion_forces_stop():
    """When budget runs out, a forced stop is returned."""
    # All text responses — never calls stop, never calls tools
    provider = MockProvider([
        text_response(f"thinking {i}") for i in range(5)
    ])
    tools = make_registry(EchoTool(), SleepTool())
    messages = [{"role": "user", "content": "go"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test", max_requests=5,
    )

    assert stop_result["reason"] == "budget_exhausted"
    assert provider.call_count == 5


@pytest.mark.asyncio
async def test_budget_warning_injected():
    """Budget warning is injected at max_requests - 2."""
    provider = MockProvider([
        text_response("thinking 0"),
        text_response("thinking 1"),
        text_response("thinking 2"),  # call 3 = max_requests - 2 → warning injected before this
        text_response("thinking 3"),
        text_response("thinking 4"),
    ])
    tools = make_registry(SleepTool())
    messages = [{"role": "user", "content": "go"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test", max_requests=5,
    )

    # Warning should be in messages
    warning_msgs = [m for m in msgs if m.get("content") == BUDGET_WARNING]
    assert len(warning_msgs) == 1


@pytest.mark.asyncio
async def test_time_budget_zero_is_disabled():
    """max_minutes=0 is falsy, so time budget is disabled."""
    provider = MockProvider([
        sleep_response("done", "next"),
    ])
    tools = make_registry(SleepTool())
    messages = [{"role": "user", "content": "go"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test", max_minutes=0,
    )

    # 0 is falsy → time check never triggers, stop tool ends the session normally
    assert stop_result["reason"] == "done"


@pytest.mark.asyncio
async def test_time_budget_exhaustion():
    """A small time budget triggers time_budget_exhausted."""

    class SlowProvider(MockProvider):
        async def chat(self, messages, tools=None, model=None, **kwargs):
            import asyncio
            await asyncio.sleep(0.01)  # 10ms delay to burn time
            return await super().chat(messages, tools, model, **kwargs)

    # Provide enough responses so the mock doesn't run out
    provider = SlowProvider([text_response(f"thinking {i}") for i in range(50)])
    tools = make_registry(SleepTool())
    messages = [{"role": "user", "content": "go"}]

    # 0.0001 minutes = 6ms. After first 10ms sleep, elapsed > budget.
    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test",
        max_requests=50, max_minutes=0.0001,
    )

    assert stop_result["reason"] == "time_budget_exhausted"
    # Should have stopped after just a few calls
    assert provider.call_count < 10


@pytest.mark.asyncio
async def test_stop_tool_with_wake_after():
    """Stop tool can include wake_after parameter."""
    provider = MockProvider([
        sleep_response("pausing", "continue reading", wake_after="30m"),
    ])
    tools = make_registry(SleepTool())
    messages = [{"role": "user", "content": "go"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test",
    )

    assert stop_result["reason"] == "pausing"
    assert stop_result["next_steps"] == "continue reading"
    assert stop_result["wake_after"] == "30m"


@pytest.mark.asyncio
async def test_multiple_tool_calls_before_stop():
    """Multiple tool calls execute before stop."""
    provider = MockProvider([
        tool_response([tc("echo", {"text": "a"}, id="t1")]),
        tool_response([tc("echo", {"text": "b"}, id="t2")]),
        sleep_response("done", "all echoed"),
    ])
    tools = make_registry(EchoTool(), SleepTool())
    messages = [{"role": "user", "content": "echo twice"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test",
    )

    assert tools_used == ["echo", "echo"]
    assert stop_result["reason"] == "done"
    assert provider.call_count == 3


@pytest.mark.asyncio
async def test_stop_mixed_with_tool_calls():
    """If stop appears alongside other tool calls, stop wins after executing prior tools."""
    # Response has echo + stop in same batch
    provider = MockProvider([
        tool_response([
            tc("echo", {"text": "before stop"}, id="t1"),
            tc("sleep", {"reason": "done", "next_steps": "n/a"}, id="t2"),
        ]),
    ])
    tools = make_registry(EchoTool(), SleepTool())
    messages = [{"role": "user", "content": "go"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test",
    )

    # echo should have executed before stop was intercepted
    assert "echo" in tools_used
    assert stop_result["reason"] == "done"


@pytest.mark.asyncio
async def test_context_builder_used_when_provided():
    """When context is provided, it's used for message building."""

    class FakeContext:
        def __init__(self):
            self.assistant_calls = []
            self.tool_result_calls = []

        def add_assistant_message(self, messages, content, tool_calls, reasoning_content=None):
            self.assistant_calls.append((content, tool_calls))
            messages.append({"role": "assistant", "content": content or "", "tool_calls": tool_calls})
            return messages

        def add_tool_result(self, messages, tool_call_id, tool_name, result):
            self.tool_result_calls.append((tool_call_id, tool_name, result))
            messages.append({"role": "tool", "tool_call_id": tool_call_id, "content": result})
            return messages

    ctx = FakeContext()
    provider = MockProvider([
        tool_response([tc("echo", {"text": "hi"})], content="calling echo"),
        sleep_response("done", "next"),
    ])
    tools = make_registry(EchoTool(), SleepTool())
    messages = [{"role": "user", "content": "go"}]

    await run_tool_loop(provider, messages, tools, model="test", context=ctx)

    assert len(ctx.assistant_calls) >= 1
    assert len(ctx.tool_result_calls) >= 1


# ── Selective reflect tests ──────────────────────────────────────────


@pytest.mark.asyncio
async def test_workspace_read_skips_reflect():
    """Reading a workspace file is recall — no reflection needed."""
    provider = MockProvider([
        tool_response([tc("read_file", {"path": "workspace/JOURNAL.md"})]),
        sleep_response("done", "next"),
    ])
    tools = make_registry(FakeReadFileTool(), SleepTool())
    messages = [{"role": "user", "content": "read it"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test",
    )

    assert "read_file" in tools_used
    reflect_msgs = [m for m in msgs if m.get("content") in (CONTINUE_PROMPT, SOUL_CHECK_PROMPT)]
    assert len(reflect_msgs) == 0


@pytest.mark.asyncio
async def test_external_read_gets_reflect():
    """Reading a file outside workspace is perception — triggers reflection."""
    provider = MockProvider([
        tool_response([tc("read_file", {"path": "/tmp/surprise.txt"})]),
        sleep_response("done", "next"),
    ])
    tools = make_registry(FakeReadFileTool(), SleepTool())
    messages = [{"role": "user", "content": "read it"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test",
    )

    assert "read_file" in tools_used
    reflect_msgs = [m for m in msgs if m.get("content") in (CONTINUE_PROMPT, SOUL_CHECK_PROMPT)]
    assert len(reflect_msgs) == 1


@pytest.mark.asyncio
async def test_write_tool_gets_reflect():
    """Reflect prompt IS injected after non-read-only tool calls."""
    provider = MockProvider([
        tool_response([tc("echo", {"text": "hi"})]),
        sleep_response("done", "next"),
    ])
    tools = make_registry(EchoTool(), SleepTool())
    messages = [{"role": "user", "content": "go"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test",
    )

    assert "echo" in tools_used
    reflect_msgs = [m for m in msgs if m.get("content") in (CONTINUE_PROMPT, SOUL_CHECK_PROMPT)]
    assert len(reflect_msgs) == 1


@pytest.mark.asyncio
async def test_mixed_batch_gets_reflect():
    """A batch with workspace read + action tool gets reflect."""
    provider = MockProvider([
        tool_response([
            tc("read_file", {"path": "workspace/SCRATCH.md"}, id="t1"),
            tc("echo", {"text": "hi"}, id="t2"),
        ]),
        sleep_response("done", "next"),
    ])
    tools = make_registry(FakeReadFileTool(), EchoTool(), SleepTool())
    messages = [{"role": "user", "content": "go"}]

    stop_result, msgs, tools_used = await run_tool_loop(
        provider, messages, tools, model="test",
    )

    reflect_msgs = [m for m in msgs if m.get("content") in (CONTINUE_PROMPT, SOUL_CHECK_PROMPT)]
    assert len(reflect_msgs) == 1


# ── _parse_duration_ms tests ─────────────────────────────────────────

from swayambhu.agent.loop import AgentLoop


class TestParseDurationMs:
    def test_minutes(self):
        assert AgentLoop._parse_duration_ms("30m") == 1_800_000

    def test_hours(self):
        assert AgentLoop._parse_duration_ms("6h") == 21_600_000

    def test_days(self):
        assert AgentLoop._parse_duration_ms("1d") == 86_400_000

    def test_seconds(self):
        assert AgentLoop._parse_duration_ms("90s") == 90_000

    def test_fractional(self):
        assert AgentLoop._parse_duration_ms("1.5h") == 5_400_000

    def test_bare_number_defaults_to_minutes(self):
        assert AgentLoop._parse_duration_ms("10") == 600_000

    def test_whitespace(self):
        assert AgentLoop._parse_duration_ms("  30m  ") == 1_800_000


# ── Reasoning toggle tests ───────────────────────────────────────────


@pytest.mark.asyncio
async def test_reasoning_off_for_routine_calls():
    """When reasoning_effort is set, routine calls pass reasoning_effort='none'."""
    call_kwargs: list[dict] = []

    class KwargsCapturingProvider(MockProvider):
        async def chat(self, messages, tools=None, model=None, **kwargs):
            call_kwargs.append(kwargs)
            return await super().chat(messages, tools, model, **kwargs)

    provider = KwargsCapturingProvider([
        tool_response([tc("read_file", {"path": "workspace/JOURNAL.md"})]),
        sleep_response("done", "next"),
    ])
    tools = make_registry(FakeReadFileTool(), SleepTool())
    messages = [{"role": "user", "content": "read it"}]

    await run_tool_loop(
        provider, messages, tools, model="test",
        reasoning_effort="medium",
    )

    assert len(call_kwargs) == 2
    # First call (routine workspace read): reasoning off
    assert call_kwargs[0]["reasoning_effort"] == "none"
    # Second call (no reflect for workspace recall): still "none"
    assert call_kwargs[1]["reasoning_effort"] == "none"


@pytest.mark.asyncio
async def test_reasoning_on_for_reflect():
    """After non-read-only tool batch, the reflect call uses reflect_reasoning_effort."""
    call_kwargs: list[dict] = []

    class KwargsCapturingProvider(MockProvider):
        async def chat(self, messages, tools=None, model=None, **kwargs):
            call_kwargs.append(kwargs)
            return await super().chat(messages, tools, model, **kwargs)

    provider = KwargsCapturingProvider([
        tool_response([tc("echo", {"text": "hi"})]),  # non-read-only → reflect
        sleep_response("done", "next"),                 # reflect call with reasoning ON
    ])
    tools = make_registry(EchoTool(), SleepTool())
    messages = [{"role": "user", "content": "go"}]

    await run_tool_loop(
        provider, messages, tools, model="test",
        reasoning_effort="medium",
        reflect_reasoning_effort="high",
    )

    assert len(call_kwargs) == 2
    # First call (routine): reasoning off
    assert call_kwargs[0]["reasoning_effort"] == "none"
    # Second call (reflect after write): uses reflect_reasoning_effort, not reasoning_effort
    assert call_kwargs[1]["reasoning_effort"] == "high"


@pytest.mark.asyncio
async def test_no_reasoning_param_when_not_configured():
    """When reasoning_effort is None, no reasoning parameter is passed."""
    call_kwargs: list[dict] = []

    class KwargsCapturingProvider(MockProvider):
        async def chat(self, messages, tools=None, model=None, **kwargs):
            call_kwargs.append(kwargs)
            return await super().chat(messages, tools, model, **kwargs)

    provider = KwargsCapturingProvider([
        tool_response([tc("echo", {"text": "hi"})]),
        sleep_response("done", "next"),
    ])
    tools = make_registry(EchoTool(), SleepTool())
    messages = [{"role": "user", "content": "go"}]

    await run_tool_loop(
        provider, messages, tools, model="test",
        # reasoning_effort not passed (defaults to None)
    )

    assert len(call_kwargs) == 2
    # Neither call should have a reasoning_effort key
    for kw in call_kwargs:
        assert kw.get("reasoning_effort") is None
