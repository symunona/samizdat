#!/usr/bin/env bash
# Creates the napirajz image-extraction pipeline via the Samizdat API.
# Usage: ./scripts/seed-napirajz-pipeline.sh [http://localhost:8765]
set -euo pipefail

BASE="${1:-http://localhost:8765}"

FILTER=$(cat <<'EOF'
{"feed_url_contains":"napirajz"}
EOF
)

STEPS=$(cat <<'EOF'
[{"kind":"extract_images","config":{"max_images":1}}]
EOF
)

curl -sf -X POST "${BASE}/api/v1/pipelines" \
  -H "Content-Type: application/json" \
  -d "$(jq -n \
    --arg name "napirajz – extract image" \
    --arg filter "$FILTER" \
    --arg steps "$STEPS" \
    '{name: $name, trigger: "on_new_document", filter: $filter, steps: $steps}')" \
| jq .

echo "Pipeline created."
