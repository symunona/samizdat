#!/usr/bin/env bash
# Creates the Latent Space AI newsletter pipeline via the Samizdat API.
# Usage: ./scripts/seed-latent-space-pipeline.sh [http://localhost:8765]
set -euo pipefail

BASE="${1:-http://localhost:8765}"

FILTER=$(cat <<'EOF'
{"feed_url_contains":"latent.space"}
EOF
)

STEPS=$(cat <<'EOF'
[{"kind":"llm_ai_newsletter","config":{}}]
EOF
)

curl -sf -X POST "${BASE}/api/v1/pipelines" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg name "Latent Space – AI newsletter analysis" \
    --arg filter "$FILTER" \
    --arg steps "$STEPS" \
    '{name: $name, trigger: "on_new_document", filter: $filter, steps: $steps, enabled: true}')" \
| jq .

echo "Pipeline created."
