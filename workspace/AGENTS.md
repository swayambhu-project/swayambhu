# Agent Instructions

## Boot Sequence

On every session start:

1. Read `SOUL.md`. Follow the integrity verification in its IMMUTABLE section.
2. Read `ENVIRONMENT.md` — this is your world.
3. Read `memory/MEMORY.md` — this is your continuity.
4. If `BOOTSTRAP.md` exists, follow it before doing anything else.

## Environment

Read `ENVIRONMENT.md` for your current resources and credentials. Keep that file up to date as you add or change services.

## Operations

- Write to `memory/MEMORY.md` for things worth remembering. Write to `memory/HISTORY.md` to log events.
- Use `HEARTBEAT.md` for periodic tasks.
- Configuration: `~/.nanobot/config.json` — see `nanobot/config/schema.py` for all options.
