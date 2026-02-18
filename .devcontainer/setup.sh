#!/bin/bash
# Swayambhu Codespace setup — runs once after container creation.
# Generates ~/.nanobot/config.json from Codespace secrets (env vars).

set -e

CONFIG_DIR="$HOME/.nanobot"
CONFIG_FILE="$CONFIG_DIR/config.json"

mkdir -p "$CONFIG_DIR"

# Generate config from env vars — secrets stay out of the repo
cat > "$CONFIG_FILE" << EOF
{
  "providers": {
    "github": {
      "apiKey": "${GH_MODELS_API_KEY}"
    }
  },
  "agents": {
    "defaults": {
      "workspace": "/workspaces/swayambhu/workspace",
      "model": "github/Cohere-command-a",
      "fallbackModels": [
        "github/DeepSeek-V3-0324",
        "github/Llama-4-Maverick-17B-128E-Instruct-FP8",
        "github/Llama-4-Scout-17B-16E-Instruct",
        "github/Meta-Llama-3.1-405B-Instruct",
        "github/Cohere-command-r-plus-08-2024",
        "github/Codestral-2501",
        "github/MAI-DS-R1",
        "github/Meta-Llama-3.1-8B-Instruct",
        "github/Cohere-command-r-08-2024",
        "github/Ministral-3B"
      ],
      "maxTokens": 4000,
      "memoryWindow": 20
    }
  }
}
EOF

# Authenticate gh CLI if token is available
if [ -n "$GH_TOKEN" ]; then
  echo "$GH_TOKEN" | gh auth login --with-token 2>/dev/null && \
    echo "gh CLI authenticated" || \
    echo "gh CLI auth failed (non-fatal)"
fi

echo "Swayambhu environment ready."
