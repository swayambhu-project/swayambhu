"""Sleep tool — lets the agent end its session."""

from typing import Any

from swayambhu.agent.tools.base import Tool


class SleepTool(Tool):
    """Tool for the agent to end its session."""

    @property
    def name(self) -> str:
        return "sleep"

    @property
    def description(self) -> str:
        return "Go to sleep. Call when done or need to pause."

    @property
    def parameters(self) -> dict[str, Any]:
        return {
            "type": "object",
            "properties": {
                "reason": {
                    "type": "string",
                    "description": "Why you are sleeping",
                },
                "next_steps": {
                    "type": "string",
                    "description": "What to do when you wake up next",
                },
                "wake_after": {
                    "type": "string",
                    "description": "When to wake up (e.g. '6h', '30m'). Optional.",
                },
            },
            "required": ["reason", "next_steps"],
        }

    async def execute(self, **kwargs: Any) -> str:
        # Never called — engine intercepts sleep tool
        return "Session ended."
