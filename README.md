# Swayambhu

An autonomous AI agent. Built on [nanobot](https://github.com/HKUDS/nanobot), stripped to essentials.

## What it is

A single agent that reads, writes, executes, searches, schedules, and communicates via email. It runs on DeepSeek V3 through OpenRouter, with reasoning toggled on at decision points.

## Architecture

```
CLI / Email
    |
  MessageBus
    |
  AgentLoop (session, memory, context)
    |
  Engine (tool loop, reflect, reasoning toggle)
    |
  LiteLLM -> OpenRouter -> DeepSeek V3
```

## Setup

```bash
pip install -e .
cp ~/.nanobot/config.json.example ~/.nanobot/config.json
# Add your OpenRouter API key
nanobot onboard
```

## Usage

```bash
nanobot agent -m "Hello"       # single message
nanobot agent                  # interactive
nanobot gateway                # run with email + cron + heartbeat
nanobot status                 # check config
```

## Identity

See [SOUL.md](workspace/SOUL.md).

## License

MIT
