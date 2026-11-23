#!/bin/bash
# Sets the portal administrator's name and password (stored as a bcrypt hash).
# Usage: sudo /opt/mailportal/set-admin-password.sh
# Takes effect at the next administrator sign-in; no restart needed.
set -euo pipefail

APP_DIR=/opt/mailportal
FILE=/etc/mailportal/admin.json

[[ $EUID -eq 0 ]] || { echo "Run this as root: sudo $0"; exit 1; }
[[ -d "$APP_DIR/node_modules/bcryptjs" ]] || { echo "The portal is not installed in $APP_DIR yet. Run install.sh first."; exit 1; }

CURRENT=admin
if [[ -f "$FILE" ]]; then
  CURRENT=$(node -p "require('$FILE').user" 2>/dev/null || echo admin)
fi

read -rp "Administrator name [$CURRENT]: " NAME
NAME=${NAME:-$CURRENT}
[[ "$NAME" =~ ^[A-Za-z0-9._-]{3,32}$ ]] || { echo "Use 3-32 letters, numbers, dots, hyphens or underscores."; exit 1; }

while true; do
  read -rsp "New administrator password (at least 12 characters; not your root password): " PW; echo
  read -rsp "Repeat it: " PW2; echo
  if [[ "$PW" != "$PW2" ]]; then echo "They don't match. Try again."; continue; fi
  if (( ${#PW} < 12 )); then echo "Use at least 12 characters."; continue; fi
  break
done

mkdir -p "$(dirname "$FILE")"
ADMIN_USER="$NAME" ADMIN_PW="$PW" ADMIN_FILE="$FILE" node -e '
  const bcrypt = require("/opt/mailportal/node_modules/bcryptjs");
  const fs = require("fs");
  const data = { user: process.env.ADMIN_USER, hash: bcrypt.hashSync(process.env.ADMIN_PW, 12) };
  fs.writeFileSync(process.env.ADMIN_FILE, JSON.stringify(data, null, 2) + "\n", { mode: 0o640 });
'
chown root:mailportal "$FILE"
chmod 0640 "$FILE"
echo "Saved. Sign in at /admin/login as \"$NAME\"."
