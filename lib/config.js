'use strict';
const fs = require('fs');

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing environment variable ${name} (see /etc/mailportal/env)`);
  return value;
}

const config = {
  host: process.env.HOST || '127.0.0.1',
  port: parseInt(process.env.PORT || '3000', 10),
  domain: required('MAIL_DOMAIN').toLowerCase(),
  brand: process.env.BRAND || 'Mail',
  sessionSecret: required('SESSION_SECRET'),
  trustProxy: process.env.TRUST_PROXY === '1',
  adminFile: process.env.ADMIN_FILE || '/etc/mailportal/admin.json',
  stateFile: process.env.STATE_FILE || '/var/lib/mailportal/state.json',
  helper: process.env.HELPER || '/usr/local/sbin/mailportal-helper',
  // Set SUDO_BIN to an empty string only for local testing with a fake helper.
  sudoBin: process.env.SUDO_BIN === undefined ? 'sudo' : process.env.SUDO_BIN,
  imapHost: process.env.IMAP_HOST || '127.0.0.1',
  imapPort: parseInt(process.env.IMAP_PORT || '143', 10),
  smtpHost: process.env.SMTP_HOST || '127.0.0.1',
  smtpPort: parseInt(process.env.SMTP_PORT || '25', 10),
  sendLimitPerHour: parseInt(process.env.SEND_LIMIT_PER_HOUR || '100', 10),
  maxRecipients: parseInt(process.env.MAX_RECIPIENTS || '20', 10),
};

// Read on every administrator sign-in, so a new password applies without a restart.
function loadAdmin() {
  const admin = JSON.parse(fs.readFileSync(config.adminFile, 'utf8'));
  if (!admin.user || !admin.hash) throw new Error(`${config.adminFile} must contain "user" and "hash"`);
  return admin;
}

module.exports = { config, loadAdmin };
