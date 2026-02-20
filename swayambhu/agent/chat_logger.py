"""Full LLM chat logging — incremental JSONL transcripts."""

import json
import re
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


# Keys whose values should be redacted (case-insensitive substring match).
# "tokens" is excluded so usage stats like prompt_tokens survive.
_SENSITIVE_PATTERNS = re.compile(
    r"(key|secret|password|authorization|app.code)", re.IGNORECASE
)
_SAFE_OVERRIDE = re.compile(r"tokens", re.IGNORECASE)


class ChatLogger:
    """Append-only JSONL logger for full LLM chat transcripts.

    One file per session-key per day.  Each JSON line is a self-contained
    event so partial sessions are always recoverable.
    """

    def __init__(self, log_dir: Path):
        self.log_dir = log_dir
        self.log_dir.mkdir(parents=True, exist_ok=True)
        self._file = None
        self._session_key: str | None = None

    # ------------------------------------------------------------------
    # Public API
    # ------------------------------------------------------------------

    def start_session(self, session_key: str, model: str) -> None:
        """Open (or reopen) the log file for *session_key* and write a start event."""
        self._session_key = session_key
        self._open_file(session_key)
        self._write({
            "type": "session_start",
            "session_key": session_key,
            "model": model,
        })

    def log_request(
        self,
        request_num: int,
        model: str,
        message_count: int,
        tool_count: int,
        reasoning_effort: str | None,
    ) -> None:
        self._write({
            "type": "llm_request",
            "request_num": request_num,
            "model": model,
            "message_count": message_count,
            "tool_count": tool_count,
            "reasoning_effort": reasoning_effort,
        })

    def log_response(
        self,
        request_num: int,
        response: Any,  # LLMResponse
        duration_ms: int,
    ) -> None:
        tool_calls = [
            {"name": tc.name, "args": self._sanitize(tc.arguments)}
            for tc in (response.tool_calls or [])
        ]
        self._write({
            "type": "llm_response",
            "request_num": request_num,
            "content": response.content,
            "reasoning_content": response.reasoning_content,
            "tool_calls": tool_calls or None,
            "usage": response.usage,
            "finish_reason": response.finish_reason,
            "duration_ms": duration_ms,
        })

    def log_tool_exec(
        self,
        request_num: int,
        tool_name: str,
        args: dict,
        result: str,
        duration_ms: int,
    ) -> None:
        self._write({
            "type": "tool_exec",
            "request_num": request_num,
            "tool": tool_name,
            "args": self._sanitize(args),
            "result": result[:4000] if result else result,
            "duration_ms": duration_ms,
        })

    def end_session(
        self,
        total_requests: int,
        total_tokens: int,
        tools_used: list[str],
    ) -> None:
        self._write({
            "type": "session_end",
            "total_requests": total_requests,
            "total_tokens": total_tokens,
            "tools_used": list(dict.fromkeys(tools_used)),  # unique, order-preserved
        })
        self._close()

    # ------------------------------------------------------------------
    # Internals
    # ------------------------------------------------------------------

    def _open_file(self, session_key: str) -> None:
        self._close()
        safe_key = session_key.replace(":", "_").replace("/", "_")
        date_str = datetime.now(timezone.utc).strftime("%Y-%m-%d")
        path = self.log_dir / f"{safe_key}_{date_str}.jsonl"
        self._file = open(path, "a", encoding="utf-8")  # noqa: SIM115

    def _close(self) -> None:
        if self._file and not self._file.closed:
            self._file.close()
        self._file = None

    def _write(self, entry: dict) -> None:
        if self._file is None:
            return
        entry["ts"] = datetime.now(timezone.utc).isoformat()
        line = json.dumps(entry, ensure_ascii=False, default=str)
        self._file.write(line + "\n")
        self._file.flush()

    # -- sanitization --------------------------------------------------

    def _sanitize(self, data: Any) -> Any:
        """Recursively redact values whose keys look sensitive."""
        if isinstance(data, dict):
            return {
                k: self._redact_value(k, v) for k, v in data.items()
            }
        if isinstance(data, list):
            return [self._sanitize(item) for item in data]
        return data

    def _redact_value(self, key: str, value: Any) -> Any:
        if _SENSITIVE_PATTERNS.search(key) and not _SAFE_OVERRIDE.search(key):
            return "[REDACTED]"
        return self._sanitize(value)
