#!/usr/bin/env bash
# Creates the Budapest municipality newsletter pipeline via the Samizdat API.
# Splits each issue into per-topic Highlights (verbatim, no summarizer) with llm_topics.
# Usage: ./scripts/seed-budapest-pipeline.sh <token> [http://localhost:8765]
#   token: a device bearer token (e.g. from POST /api/v1/admin/test-device).
set -euo pipefail

TOKEN="${1:?usage: seed-budapest-pipeline.sh <token> [base_url]}"
BASE="${2:-http://localhost:8765}"

# filter/steps are JSON *strings* inside the request body (the API stores them raw).
# Budapest email-newsletter feed = email-newsletter:budapest-4b26.
read -r -d '' BODY <<'JSON' || true
{
  "name": "Budapest Newsletter – topics",
  "trigger": "on_new_document",
  "enabled": true,
  "filter": "{\"source_feed_id\":\"1a67c4b2-fadc-51c7-88d7-f10ab340afd7\"}",
  "steps": "[{\"kind\":\"llm_topics\",\"config\":{}}]"
}
JSON

curl -sf -X POST "${BASE}/api/v1/pipelines" \
  -H "Authorization: Bearer ${TOKEN}" \
  -H "Content-Type: application/json" \
  -d "$BODY"
echo

echo "Pipeline created."
