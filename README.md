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
cp ~/.swayambhu/config.json.example ~/.swayambhu/config.json
# Add your OpenRouter API key
swayambhu onboard
```

## Usage

```bash
swayambhu agent -m "Hello"       # single message
swayambhu agent                  # interactive
swayambhu gateway                # run with email + cron + heartbeat
swayambhu status                 # check config
```

## Identity

See [SOUL.md](workspace/SOUL.md).

## License

MIT
