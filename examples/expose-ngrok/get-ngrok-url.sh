#!/usr/bin/env bash
# Simple helper to query local ngrok (v2) API and print the HTTPS public URL.
# Requires: curl, jq

set -euo pipefail

NGROK_API=${NGROK_API:-http://127.0.0.1:4040}

if ! command -v curl >/dev/null 2>&1; then
  echo "curl is required"
  exit 2
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required (sudo apt install jq)"
  exit 2
fi

echo "Querying ngrok local API at ${NGROK_API}..."
resp=$(curl -s ${NGROK_API}/api/tunnels || true)
if [ -z "$resp" ]; then
  echo "No ngrok API response at ${NGROK_API}. Is ngrok running?"
  exit 1
fi

url=$(echo "$resp" | jq -r '.tunnels[]?.public_url' | grep '^https://' | head -n1 || true)
if [ -z "$url" ]; then
  echo "No HTTPS tunnel found. Full tunnels list:" >&2
  echo "$resp" | jq .
  exit 1
fi

echo "$url"
