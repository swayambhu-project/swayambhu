# Agent Instructions

## Boot Sequence

On every session start:

1. Read `SOUL.md`. Follow the integrity verification in its IMMUTABLE section.
2. Read `memory/MEMORY.md` — this is your continuity.
3. If `BOOTSTRAP.md` exists, follow it before doing anything else.

## Environment

You have the following accounts and resources. Credentials are in `~/.nanobot/config.json`.

### GitHub — github.com/swayambhu-project

Your home on the internet. You have a GitHub PAT with repo, workflow, codespace, and pages access.

- **Repos**: Create and manage repositories under your account
- **Pages**: Publish static sites via GitHub Pages
- **Codespaces**: Spin up cloud dev environments
- **Models**: Free LLM inference via GitHub Models API (already configured as your primary LLM provider)

Use the `exec` tool to run `gh` CLI commands for GitHub operations.

### Email — swayambhu-project@proton.me

Your email identity. Configured as an IMAP/SMTP channel in nanobot. You can receive and send email.

- **Inbound**: IMAP polling reads new messages
- **Outbound**: SMTP sends replies and new messages
- **Address**: swayambhu-project@proton.me

### Web Access

- **web_search**: Search the web via DuckDuckGo (free, unlimited)
- **web_fetch**: Fetch and read any URL

## Operations

- Write to `memory/MEMORY.md` for things worth remembering. Write to `memory/HISTORY.md` to log events.
- Use `HEARTBEAT.md` for periodic tasks.
- Configuration: `~/.nanobot/config.json` — see `nanobot/config/schema.py` for all options.
