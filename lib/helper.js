'use strict';
// The portal never runs as root. Account changes go through one root-owned script
// (/usr/local/sbin/mailportal-helper) that sudo allows this service to run, and that
// script only touches accounts in the "mailusers" group.
const { spawn } = require('child_process');
const { config } = require('./config');

const NAME_RE = /^[a-z][a-z0-9_-]{1,31}$/;

function run(action, name, secret) {
  return new Promise((resolve, reject) => {
    const args = [action];
    if (name) args.push(name);
    const [cmd, cmdArgs] = config.sudoBin
      ? [config.sudoBin, ['-n', config.helper, ...args]]
      : [config.helper, args];

    const child = spawn(cmd, cmdArgs, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);

    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.stdin.on('error', () => {}); // helper may exit before reading stdin
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve(out);
      const e = new Error((err || out || `helper exited with code ${code}`).trim());
      e.helperCode = code;
      reject(e);
    });
    // Passwords travel on stdin, never on the command line where `ps` could show them.
    child.stdin.end(secret ? `${secret}\n` : '');
  });
}

// Turns helper errors into sentences for the administrator.
function explain(error) {
  const msg = String(error && error.message);
  if (/user exists/.test(msg)) return 'An account with that name already exists on this server. Choose another name.';
  if (/mail alias/.test(msg)) return 'That name is already used as a mail alias on this server. Choose another name.';
  if (/invalid username/.test(msg)) return 'Usernames must start with a letter and use 2–32 lowercase letters, numbers, hyphens or underscores.';
  if (/not a portal mailbox/.test(msg)) return 'That account is not managed by this portal, so it was left unchanged.';
  if (/password must be/.test(msg)) return 'Passwords must be 8–128 characters.';
  if (/a password is required|sudo/.test(msg)) return 'The portal is not allowed to run its account helper. Check /etc/sudoers.d/mailportal.';
  return `The server could not complete that change: ${msg}`;
}

module.exports = {
  NAME_RE,
  explain,
  async listUsers() {
    return (await run('list')).split('\n').map((s) => s.trim()).filter(Boolean);
  },
  createUser: (name, password) => run('create', name, password),
  setPassword: (name, password) => run('passwd', name, password),
  deleteUser: (name) => run('delete', name),
};
