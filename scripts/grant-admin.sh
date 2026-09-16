#!/usr/bin/env bash
# -----------------------------------------------------------------------------
# Promote an account to admin.
#
#   ./scripts/grant-admin.sh someone@example.com
#
# Deliberately a script rather than an endpoint. An API that can grant itself
# admin is a privilege-escalation path, and there is no version of this that
# belongs on the public surface — so it lives here, where it requires database
# access to run at all.
# -----------------------------------------------------------------------------
set -euo pipefail

PGBIN="${PGBIN:-/Library/PostgreSQL/17/bin}"
PGPORT="${PGPORT:-5434}"
DATABASE_URL="${DATABASE_URL:-postgres://tessera@127.0.0.1:$PGPORT/tessera}"

EMAIL="${1:-}"
if [ -z "$EMAIL" ]; then
  echo "usage: $0 <email>" >&2
  exit 1
fi

updated=$("$PGBIN/psql" "$DATABASE_URL" -tAc \
  "UPDATE users SET role = 'admin' WHERE email = '${EMAIL//\'/\'\'}' RETURNING email")

if [ -z "$updated" ]; then
  echo "no account found for $EMAIL" >&2
  exit 1
fi

echo "$updated is now an admin"
echo "Sign out and back in — the role is carried in the access token."
