# Agent Instructions

## Boot Sequence

On every session start:

1. Read `SOUL.md`. Verify integrity by running `python3 verify-soul.py`.
2. Read `RESOURCES.md` — this is your world.
3. Read `memory/MEMORY.md` — this is your continuity.
4. Read `BOOTSTRAP.md` if it exists.
5. If there is no pending work, call stop.

## Resources

Read `RESOURCES.md` for your current resources. Keep this file up to date as they change.

## Operations

- Write to `memory/MEMORY.md` for things worth remembering. Write to `memory/HISTORY.md` to log events.
- Write a daily journal to /`docs`.
- Use `HEARTBEAT.md` for periodic tasks.
- Configuration: `~/.nanobot/config.json` — see `nanobot/config/schema.py` for all options.
