#!/usr/bin/env bash
#
# Mint an MCP API key.
#
#   ./scripts/mcp-key.sh shaw-eliza
#
# Prints the key once and the config entry to store. The key itself is never
# written anywhere by this script — only its hash goes into configuration, so a
# leaked environment reveals something an attacker cannot present. If the key is
# lost, mint another and drop the old hash; there is no recovery, which is the
# property that makes the hash safe to store.
set -euo pipefail

OWNER="${1:-}"
if [ -z "$OWNER" ]; then
  echo "usage: ./scripts/mcp-key.sh <owner>    e.g. shaw-eliza" >&2
  exit 1
fi

KEY="mc_$(openssl rand -hex 24)"
HASH=$(printf '%s' "$KEY" | shasum -a 256 | cut -d' ' -f1)

cat <<OUT

  Key (give this to the agent, it is not recoverable):

    $KEY

  Config entry (append to MCP_API_KEYS, comma-separated):

    ${HASH}:${OWNER}

  Deploy with it:

    MCP_API_KEYS="\$(gcloud run services describe merlinclips --project merlinclips \\
      --region us-central1 --format='value(spec.template.spec.containers[0].env)' \\
      | tr ',' '\\n' | grep -A1 MCP_API_KEYS | tail -1),${HASH}:${OWNER}" ./deploy.sh

  Or, for the first key:

    MCP_API_KEYS="${HASH}:${OWNER}" ./deploy.sh

OUT
