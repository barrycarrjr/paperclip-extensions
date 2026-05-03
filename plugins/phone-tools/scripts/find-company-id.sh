#!/usr/bin/env bash
# Resolve a Paperclip company name to its UUID.
#
# Usage:
#   PAPERCLIP_COOKIE='<cookie>' ./find-company-id.sh "<Company Name>"

set -euo pipefail

NAME="${1:-}"
PAPERCLIP_URL="${PAPERCLIP_URL:-http://localhost:3100}"

if [ -z "$NAME" ]; then
  echo "Usage: $0 \"<company name>\"" >&2
  exit 2
fi
if [ -z "${PAPERCLIP_COOKIE:-}" ]; then
  echo "ERROR: set PAPERCLIP_COOKIE — see smoke-outbound.sh header for how to grab it." >&2
  exit 2
fi

curl -sS "$PAPERCLIP_URL/api/companies" -H "Cookie: $PAPERCLIP_COOKIE" \
  | python -c "
import json, sys
data = json.load(sys.stdin)
companies = data if isinstance(data, list) else (data.get('companies') or data.get('data') or [])
target = sys.argv[1].lower().strip()
matches = [c for c in companies if (c.get('name') or '').lower().strip() == target]
if not matches:
    near = [c for c in companies if target in (c.get('name') or '').lower()]
    if near:
        print('No exact match. Closest:', file=sys.stderr)
        for c in near[:5]:
            print(f\"  {c.get('id')}  {c.get('name')}\", file=sys.stderr)
    else:
        print('No matches. All companies:', file=sys.stderr)
        for c in companies[:30]:
            print(f\"  {c.get('id')}  {c.get('name')}\", file=sys.stderr)
    sys.exit(1)
print(matches[0]['id'])
" "$NAME"
