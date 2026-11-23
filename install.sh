#!/bin/bash
# Installs the mail portal on this server.
# Run from the unpacked folder:  sudo ./install.sh
# Safe to run again: it updates the code and keeps your configuration and admin password.
set -euo pipefail

SRC="$(cd "$(dirname "$0")" && pwd)"
APP_DIR=/opt/mailportal
CONF_DIR=/etc/mailportal
DATA_DIR=/var/lib/mailportal
HELPER=/usr/local/sbin/mailportal-helper

say()  { printf '\n\033[1m%s\033[0m\n' "$1"; }
warn() { printf '  ! %s\n' "$1"; }

[[ $EUID -eq 0 ]] || { echo "Run as root: sudo ./install.sh"; exit 1; }

# ---------- prerequisites ----------
say "Checking prerequisites"
command -v node >/dev/null || { echo "Node.js is not installed. Install Node 20 or newer first (see README.md)."; exit 1; }
NODE_BIN=$(command -v node)
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
(( NODE_MAJOR >= 20 )) || { echo "Node.js 20 or newer is required; found $(node -v). See README.md."; exit 1; }
command -v npm >/dev/null || { echo "npm is not installed: apt install -y npm"; exit 1; }
case "$NODE_BIN" in
  /root/*|/home/*) echo "Node is installed under a home directory ($NODE_BIN), which the service account can't use. Install Node system-wide (see README.md)."; exit 1 ;;
esac
echo "  Node $(node -v) at $NODE_BIN"

if [[ "$(postconf -h home_mailbox 2>/dev/null)" != "Maildir/" ]]; then
  warn "Postfix home_mailbox is not 'Maildir/'. New mail won't show in the portal until you run:"
  warn "  postconf -e 'home_mailbox = Maildir/' && systemctl reload postfix"
fi
if [[ "$(doveconf -h mail_location 2>/dev/null)" != "maildir:~/Maildir" ]]; then
  warn "Dovecot mail_location is not 'maildir:~/Maildir'. The portal reads mail through Dovecot, so set it in"
  warn "  /etc/dovecot/conf.d/10-mail.conf and run: systemctl restart dovecot"
fi
if ! ss -ltn 2>/dev/null | grep -qE '127\.0\.0\.1:143|0\.0\.0\.0:143|\*:143|\[::\]:143'; then
  warn "Nothing is listening on IMAP port 143. Check: doveconf -n | grep protocols  (must include imap)"
fi

# ---------- accounts ----------
say "Creating the service account and the mailusers group"
id mailportal >/dev/null 2>&1 || useradd --system --home-dir "$APP_DIR" --no-create-home --shell /usr/sbin/nologin mailportal
groupadd -f mailusers
mkdir -p /etc/skel/Maildir/{cur,new,tmp}
chmod -R 700 /etc/skel/Maildir

# ---------- code ----------
say "Installing the app to $APP_DIR"
mkdir -p "$APP_DIR"
rm -rf "$APP_DIR/lib" "$APP_DIR/public"
cp -r "$SRC/server.js" "$SRC/package.json" "$SRC/lib" "$SRC/public" "$APP_DIR/"
[[ -f "$SRC/package-lock.json" ]] && cp "$SRC/package-lock.json" "$APP_DIR/"
install -m 0750 "$SRC/deploy/set-admin-password.sh" "$APP_DIR/set-admin-password.sh"
(cd "$APP_DIR" && if [[ -f package-lock.json ]]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi)
chown -R root:root "$APP_DIR"
chmod -R go-w "$APP_DIR"

# ---------- root helper ----------
say "Installing the account helper and its sudo rule"
install -o root -g root -m 0700 "$SRC/deploy/mailportal-helper" "$HELPER"
SUDOERS_TMP=$(mktemp)
cat > "$SUDOERS_TMP" << EOF
# The mail portal may run exactly one command as root: its account helper.
mailportal ALL=(root) NOPASSWD: $HELPER
EOF
visudo -cf "$SUDOERS_TMP" >/dev/null
install -o root -g root -m 0440 "$SUDOERS_TMP" /etc/sudoers.d/mailportal
rm -f "$SUDOERS_TMP"

# ---------- configuration ----------
mkdir -p "$CONF_DIR" "$DATA_DIR"
chown mailportal:mailportal "$DATA_DIR"
chmod 0700 "$DATA_DIR"

if [[ ! -f "$CONF_DIR/env" ]]; then
  say "Configuring the portal"
  read -rp "Mail domain [vidyanetwork.com]: " DOMAIN
  DOMAIN=${DOMAIN:-vidyanetwork.com}
  read -rp "Name shown in the portal [Vidya Network]: " BRAND
  BRAND=${BRAND:-Vidya Network}
  SECRET=$(node -e 'console.log(require("crypto").randomBytes(32).toString("hex"))')
  cat > "$CONF_DIR/env" << EOF
MAIL_DOMAIN=$DOMAIN
BRAND="$BRAND"
HOST=127.0.0.1
PORT=3000
TRUST_PROXY=1
SESSION_SECRET=$SECRET
SEND_LIMIT_PER_HOUR=100
MAX_RECIPIENTS=20
DISPLAY_TZ=Asia/Kolkata
NODE_ENV=production
EOF
  chmod 0600 "$CONF_DIR/env"
else
  echo "  Keeping existing $CONF_DIR/env"
fi

if [[ ! -f "$CONF_DIR/admin.json" ]]; then
  say "Set the portal administrator (a separate login; do not reuse the root password)"
  "$APP_DIR/set-admin-password.sh"
else
  echo "  Keeping existing administrator login (change it with: sudo $APP_DIR/set-admin-password.sh)"
fi

# ---------- existing mailboxes ----------
say "Existing mailboxes"
echo "  Portal users must be in the mailusers group. Accounts in sudo/admin groups are always refused."
read -rp "  Add existing users now? Names separated by spaces (e.g. kunal rahul), or Enter to skip: " EXISTING
for u in $EXISTING; do
  if ! id "$u" >/dev/null 2>&1; then warn "$u does not exist; skipped"; continue; fi
  if id -nG "$u" | tr ' ' '\n' | grep -qxE 'sudo|admin|wheel|root'; then warn "$u is an administrator account; skipped"; continue; fi
  usermod -aG mailusers "$u" && echo "  Added $u"
done

# ---------- service ----------
say "Starting the service"
sed "s|@NODE@|$NODE_BIN|" "$SRC/deploy/mailportal.service" > /etc/systemd/system/mailportal.service
systemctl daemon-reload
systemctl enable mailportal >/dev/null 2>&1
systemctl restart mailportal
sleep 2
if systemctl is-active --quiet mailportal && node -e "require('http').get('http://127.0.0.1:3000/login', r => process.exit(r.statusCode === 200 ? 0 : 1)).on('error', () => process.exit(1))"; then
  echo "  Running on http://127.0.0.1:3000 (local only)"
else
  warn "The service did not start. See: journalctl -u mailportal -n 50 --no-pager"
  exit 1
fi

say "Done. Next: put it behind HTTPS (README.md, step 4)."
