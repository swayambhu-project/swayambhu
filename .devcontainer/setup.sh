#!/bin/bash
# Swayambhu Codespace setup — runs once after container creation.
# Generates ~/.swayambhu/config.json from Codespace secrets (env vars).

set -e

# Load .env from workspace if env vars aren't already set (Codespace secrets vs local)
WORKSPACE_DIR="$(cd "$(dirname "$0")/.." && pwd)"
if [ -z "$OPENROUTER_API_KEY" ] || [ -z "$DISCORD_BOT_TOKEN" ]; then
    if [ -f "$WORKSPACE_DIR/.env" ]; then
        source "$WORKSPACE_DIR/.env"
    fi
fi

CONFIG_DIR="$HOME/.swayambhu"
CONFIG_FILE="$CONFIG_DIR/config.json"

mkdir -p "$CONFIG_DIR"

# Build optional channels JSON block
CHANNELS_BLOCK=""
if [ -n "$DISCORD_BOT_TOKEN" ]; then
    CHANNELS_BLOCK=",
  \"channels\": {
    \"discord\": {
      \"enabled\": true,
      \"botToken\": \"${DISCORD_BOT_TOKEN}\"
    }
  }"
fi

# Generate config from env vars — secrets stay out of the repo
cat > "$CONFIG_FILE" << EOF
{
  "providers": {
    "openrouter": {
      "apiKey": "${OPENROUTER_API_KEY}"
    }
  },
  "agents": {
    "defaults": {
      "workspace": "/workspaces/swayambhu/workspace",
      "model": "openrouter/deepseek/deepseek-v3.1-terminus",
      "maxTokens": 8192,
      "memoryWindow": 20,
      "maxRequestsPerSession": 50,
      "maxSessionMinutes": 10,
      "reasoningEffort": "medium"
    }
  }${CHANNELS_BLOCK}
}
EOF

# gh CLI auto-detects GH_TOKEN env var — no login needed

echo "Swayambhu environment ready."
