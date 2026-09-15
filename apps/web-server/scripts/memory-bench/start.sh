#!/bin/zsh
set -u
setopt null_glob
LIVE="$(cd "$(dirname "$0")" && pwd)"
WT="${WT:-$(cd "$LIVE/../../../.." && pwd)}"
PORT="${PORT:-8951}"
GATEWAY_PORT="${GATEWAY_PORT:-8952}"
TOKEN="0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
HOME_DIR="$LIVE/home"; AGENT_DIR="$HOME_DIR/.exxperts/agent"; APP_DIR="$HOME_DIR/.exxperts/app"
lsof -ti :"$PORT" | xargs kill 2>/dev/null; lsof -ti :"$GATEWAY_PORT" | xargs kill 2>/dev/null; sleep 0.5
mkdir -p "$AGENT_DIR" "$APP_DIR" "$LIVE/workspace"
rm -f "$APP_DIR"/.room-locks/*.json 2>/dev/null
cat > "$AGENT_DIR/models.json" <<EOT
{ "providers": { "openai-compatible": { "name": "Memorize Bench Gateway", "baseUrl": "http://127.0.0.1:$GATEWAY_PORT/v1", "api": "openai-completions",
  "models": [ { "id": "maint-16k", "name": "Maintenance 16k", "contextWindow": 128000, "maxTokens": 16384 },
              { "id": "maint-32k", "name": "Maintenance 32k", "contextWindow": 200000, "maxTokens": 32000 },
              { "id": "maint-128k", "name": "Maintenance 128k", "contextWindow": 200000, "maxTokens": 128000 } ] } } }
EOT
echo '{"openai-compatible":{"type":"api_key","key":"bench-key"}}' > "$AGENT_DIR/auth.json"
MAINT="${MAINT:-maint-16k}"
cat > "$APP_DIR/openai-compatible-ai-profile.json" <<EOT
{ "profileId": "openai-compatible", "providerId": "openai-compatible", "label": "Memorize Bench Gateway",
  "roomModels": [ { "modelId": "maint-16k", "label": "Maintenance 16k" }, { "modelId": "maint-32k", "label": "Maintenance 32k" }, { "modelId": "maint-128k", "label": "Maintenance 128k" } ],
  "maintenanceModel": "$MAINT" }
EOT
echo '{"profileId":"openai-compatible"}' > "$APP_DIR/persistent-agent-ai-profile.json"
chmod 600 "$AGENT_DIR"/*.json "$APP_DIR"/*.json
GATEWAY_PORT="$GATEWAY_PORT" nohup node "$LIVE/memorize-gateway.mjs" > "$LIVE/gateway.log" 2>&1 &
( cd "$WT/apps/web-server" || exit 1
  unset ANTHROPIC_API_KEY ANTHROPIC_OAUTH_TOKEN OPENAI_API_KEY AZURE_OPENAI_API_KEY EXXETA_AI_API_KEY COPILOT_GITHUB_TOKEN GH_TOKEN GITHUB_TOKEN GEMINI_API_KEY GOOGLE_CLOUD_API_KEY OPENROUTER_API_KEY
  HOME="$HOME_DIR" USERPROFILE="$HOME_DIR" PORT="$PORT" EXXPERTS_AUTH_TOKEN="$TOKEN" EXXETA_HOME="$WT" EXXPERTS_CODING_AGENT_DIR="$AGENT_DIR" LOG_LEVEL=warn \
  nohup "$WT/node_modules/.bin/tsx" src/index.ts > "$LIVE/server.log" 2>&1 & )
for i in {1..80}; do curl -fsS "http://localhost:$PORT/healthz" > /dev/null 2>&1 && break; sleep 0.25; done
curl -fsS "http://localhost:$PORT/healthz" > /dev/null || { echo "server did not come up"; tail -30 "$LIVE/server.log"; exit 1; }
echo "up: server http://localhost:$PORT gateway :$GATEWAY_PORT maint=$MAINT"
