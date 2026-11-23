'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const { rateLimit } = require('express-rate-limit');
const bcrypt = require('bcryptjs');

const { config, loadAdmin } = require('./lib/config');
const helper = require('./lib/helper');
const mail = require('./lib/mail');
const state = require('./lib/state');
const views = require('./lib/views');
const { csrf, safeEqual } = require('./lib/security');

const FOLDERS = new Set(['inbox', 'sent']);
// Names that already mean something to the mail system or the OS.
const RESERVED = new Set([
  'root', 'admin', 'administrator', 'postmaster', 'hostmaster', 'webmaster', 'abuse',
  'mailer-daemon', 'dmarc', 'noreply', 'no-reply', 'nobody', 'mail', 'www-data', 'mailportal',
]);

const app = express();
if (config.trustProxy) app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({
    'Content-Security-Policy':
      "default-src 'self'; script-src 'none'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; form-action 'self'; frame-ancestors 'none'",
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
  });
  next();
});

app.use('/static', express.static(path.join(__dirname, 'public'), { maxAge: '1h', setHeaders: (res) => res.set('Cache-Control', 'public, max-age=3600') }));
app.use(express.urlencoded({ extended: false, limit: '2mb' }));
app.use(session({
  name: 'mailportal.sid',
  secret: config.sessionSecret,
  resave: false,
  saveUninitialized: false,
  cookie: { httpOnly: true, sameSite: 'lax', secure: 'auto', maxAge: 8 * 60 * 60 * 1000 },
}));
app.use(csrf);

// ---------- helpers ----------

const str = (v) => (typeof v === 'string' ? v : '');

const signInLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  handler: (req, res) => res.status(429).send(views.simplePage(
    'Too many attempts',
    'Too many sign-in attempts came from your network. Wait 15 minutes, then try again.',
  )),
});

function setFlash(req, type, text, extra = {}) { req.session.flash = { type, text, ...extra }; }
function takeFlash(req) { const f = req.session.flash; delete req.session.flash; return f; }

function normalizeName(input) {
  let name = str(input).trim().toLowerCase();
  const suffix = `@${config.domain}`;
  if (name.endsWith(suffix)) name = name.slice(0, -suffix.length);
  return name;
}

function demoPassword() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
  const group = () => Array.from({ length: 4 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${group()}-${group()}-${group()}`;
}

function parseAddresses(input) {
  const parts = [...new Set(str(input).split(/[,;\s]+/).map((s) => s.trim()).filter(Boolean))];
  const ok = /^[^\s@<>()",;:]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/;
  return { valid: parts.filter((p) => ok.test(p)), invalid: parts.filter((p) => !ok.test(p)) };
}

function ctx(req, res) {
  return { name: req.session.user.name, address: `${req.session.user.name}@${config.domain}`, csrf: res.locals.csrf };
}

// Per-mailbox sending limit, so one stolen password can't burn the domain's reputation.
const sendLog = new Map();
const sendQuota = {
  allowed(name) {
    const now = Date.now();
    const recent = (sendLog.get(name) || []).filter((t) => now - t < 60 * 60 * 1000);
    sendLog.set(name, recent);
    return recent.length < config.sendLimitPerHour;
  },
  record(name) { sendLog.get(name).push(Date.now()); },
};

function requireUser(req, res, next) {
  if (!req.session.user) return res.redirect('/login');
  if (state.mustChange(req.session.user.name) && req.path !== '/password') return res.redirect('/password');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.session.admin) return res.redirect('/admin/login');
  next();
}

// If the password changed elsewhere (admin reset), IMAP refuses the session: sign out cleanly.
function mailError(e, req, res, next) {
  if (mail.isAuthError(e)) {
    return req.session.destroy(() => res.redirect('/login?expired=1'));
  }
  next(e);
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

// ---------- mailbox sign-in ----------

app.get('/', (req, res) => res.redirect(req.session.user ? '/mail/inbox' : '/login'));

app.get('/login', (req, res) => {
  if (req.session.user) return res.redirect('/mail/inbox');
  const info = req.query.expired ? 'Your password was changed, so you were signed out. Sign in with the new password.' : null;
  res.send(views.loginPage({ csrf: res.locals.csrf, notice: info }));
});

app.post('/login', signInLimiter, wrap(async (req, res, next) => {
  const name = normalizeName(req.body.username);
  const pass = str(req.body.password);
  const fail = () => res.status(401).send(views.loginPage({
    csrf: res.locals.csrf,
    username: req.body.username,
    error: "That address and password don't match a mailbox here. Check both and try again.",
  }));

  if (!helper.NAME_RE.test(name) || !pass) return fail();
  // Only mailboxes created for the portal may sign in, never the server's admin accounts.
  const members = await helper.listUsers();
  if (!members.includes(name)) return fail();
  if (!(await mail.verifyLogin(name, pass))) return fail();

  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.user = { name, pass };
    res.redirect(state.mustChange(name) ? '/password' : '/mail/inbox');
  });
}));

app.post('/logout', (req, res) => req.session.destroy(() => res.redirect('/login')));

// ---------- folders and messages ----------

app.get('/mail/:folder', requireUser, async (req, res, next) => {
  const { folder } = req.params;
  if (!FOLDERS.has(folder)) return res.status(404).send(views.simplePage('Not found', "That folder doesn't exist."));
  try {
    const { name, pass } = req.session.user;
    const items = await mail.listMessages(name, pass, folder);
    res.send(views.mailboxPage({ ctx: ctx(req, res), folder, items, flash: takeFlash(req) }));
  } catch (e) { mailError(e, req, res, next); }
});

app.get('/mail/:folder/:uid', requireUser, async (req, res, next) => {
  const { folder } = req.params;
  const uid = Number(req.params.uid);
  if (!FOLDERS.has(folder) || !Number.isInteger(uid) || uid < 1) {
    return res.status(404).send(views.simplePage('Not found', "That message doesn't exist."));
  }
  try {
    const { name, pass } = req.session.user;
    const msg = await mail.getMessage(name, pass, folder, uid);
    if (!msg) {
      return res.status(404).send(views.simplePage('Message not found', 'This message no longer exists. It may have been deleted.', { href: `/mail/${folder}`, label: 'Back to the folder' }));
    }
    res.send(views.messagePage({ ctx: ctx(req, res), folder, msg, view: req.query.view, flash: takeFlash(req) }));
  } catch (e) { mailError(e, req, res, next); }
});

app.post('/mail/:folder/:uid/delete', requireUser, async (req, res, next) => {
  const { folder } = req.params;
  const uid = Number(req.params.uid);
  if (!FOLDERS.has(folder) || !Number.isInteger(uid) || uid < 1) return res.redirect('/mail/inbox');
  try {
    const { name, pass } = req.session.user;
    await mail.deleteMessage(name, pass, folder, uid);
    setFlash(req, 'ok', 'Message deleted.');
    res.redirect(`/mail/${folder}`);
  } catch (e) { mailError(e, req, res, next); }
});

// ---------- writing mail ----------

app.get('/compose', requireUser, async (req, res, next) => {
  const form = { to: '', cc: '', subject: '', text: '', inReplyTo: '', references: '' };
  const replyUid = Number(req.query.reply);
  const folder = FOLDERS.has(req.query.folder) ? req.query.folder : 'inbox';
  if (Number.isInteger(replyUid) && replyUid > 0) {
    try {
      const { name, pass } = req.session.user;
      const m = await mail.getMessage(name, pass, folder, replyUid);
      if (m) {
        form.to = folder === 'sent' ? m.firstTo : m.replyAddress;
        form.subject = /^re:/i.test(m.subject) ? m.subject : `Re: ${m.subject}`;
        const quoted = m.text.trimEnd().split('\n').map((l) => `> ${l}`).join('\n');
        form.text = `\n\nOn ${views.fullDate(m.date)}, ${m.from} wrote:\n${quoted}\n`;
        form.inReplyTo = m.messageId;
        form.references = [...m.references, m.messageId].filter(Boolean).join(' ');
      }
    } catch (e) { return mailError(e, req, res, next); }
  }
  res.send(views.composePage({ ctx: ctx(req, res), form }));
});

app.post('/compose', requireUser, async (req, res, next) => {
  const { name, pass } = req.session.user;
  const form = {
    to: str(req.body.to),
    cc: str(req.body.cc),
    subject: str(req.body.subject).replace(/[\r\n]+/g, ' ').slice(0, 300),
    text: str(req.body.text),
    inReplyTo: str(req.body.inReplyTo),
    references: str(req.body.references),
  };
  const again = (error) => res.status(400).send(views.composePage({ ctx: ctx(req, res), form, error }));

  const to = parseAddresses(form.to);
  const cc = parseAddresses(form.cc);
  const invalid = [...to.invalid, ...cc.invalid];
  if (invalid.length) return again(`These addresses aren't valid: ${invalid.join(', ')}. Fix them and send again.`);
  if (!to.valid.length) return again('Add at least one address in To.');
  if (to.valid.length + cc.valid.length > config.maxRecipients) {
    return again(`Send to ${config.maxRecipients} addresses or fewer per message.`);
  }
  if (!sendQuota.allowed(name)) {
    return again(`This mailbox has sent ${config.sendLimitPerHour} messages in the last hour, which is the limit. Try again later.`);
  }

  try {
    await mail.sendMessage(name, pass, { to: to.valid, cc: cc.valid, subject: form.subject, text: form.text, inReplyTo: form.inReplyTo, references: form.references });
    sendQuota.record(name);
    setFlash(req, 'ok', 'Message sent.');
    res.redirect('/mail/sent');
  } catch (e) {
    if (mail.isAuthError(e)) return mailError(e, req, res, next);
    console.error(`Send failed for ${name}:`, e.message);
    again('The server could not send this message. Nothing was sent. Try again in a minute.');
  }
});

// ---------- own password ----------

app.get('/password', requireUser, (req, res) => {
  res.send(views.passwordPage({ ctx: ctx(req, res), forced: state.mustChange(req.session.user.name), flash: takeFlash(req) }));
});

app.post('/password', requireUser, wrap(async (req, res) => {
  const { name, pass } = req.session.user;
  const forced = state.mustChange(name);
  const current = str(req.body.current);
  const next1 = str(req.body.password);
  const again = (error) => res.status(400).send(views.passwordPage({ ctx: ctx(req, res), forced, error }));

  if (!safeEqual(current, pass)) return again('Your current password is incorrect.');
  if (next1.length < 10) return again('Use at least 10 characters for the new password.');
  if (next1.length > 128 || /[\r\n]/.test(next1)) return again('Use 128 characters or fewer, on one line.');
  if (next1 === current) return again('Choose a password different from your current one.');
  if (next1 !== str(req.body.confirm)) return again("The two new passwords don't match.");

  try {
    await helper.setPassword(name, next1);
  } catch (e) {
    console.error(`Password change failed for ${name}:`, e.message);
    return again('The server could not change your password. Your old password still works.');
  }
  state.setMustChange(name, false);
  req.session.user.pass = next1;
  setFlash(req, 'ok', 'Password changed.');
  res.redirect('/mail/inbox');
}));

// ---------- administrator ----------

app.get('/admin/login', (req, res) => {
  if (req.session.admin) return res.redirect('/admin');
  res.send(views.adminLoginPage({ csrf: res.locals.csrf }));
});

app.post('/admin/login', signInLimiter, wrap(async (req, res, next) => {
  const admin = loadAdmin();
  const nameOk = safeEqual(str(req.body.username).trim(), admin.user);
  const passOk = await bcrypt.compare(str(req.body.password), admin.hash); // always run, keeps timing even
  if (!(nameOk && passOk)) {
    return res.status(401).send(views.adminLoginPage({ csrf: res.locals.csrf, error: 'Wrong administrator name or password.' }));
  }
  req.session.regenerate((err) => {
    if (err) return next(err);
    req.session.admin = true;
    res.redirect('/admin');
  });
}));

app.post('/admin/logout', (req, res) => req.session.destroy(() => res.redirect('/admin/login')));

app.get('/admin', requireAdmin, wrap(async (req, res) => {
  const users = (await helper.listUsers()).map((name) => ({ name, temporary: state.mustChange(name) }));
  res.send(views.adminPage({
    csrf: res.locals.csrf,
    users,
    flash: takeFlash(req),
    signInUrl: `${req.protocol}://${req.get('host')}/login`,
  }));
}));

app.post('/admin/users', requireAdmin, wrap(async (req, res) => {
  const name = normalizeName(req.body.username);
  let password = str(req.body.password);

  if (!helper.NAME_RE.test(name)) {
    setFlash(req, 'error', 'Usernames must start with a letter and use 2–32 lowercase letters, numbers, hyphens or underscores.');
  } else if (RESERVED.has(name)) {
    setFlash(req, 'error', `"${name}" is reserved by the mail system. Choose another name.`);
  } else if (password && (password.length < 8 || password.length > 128 || /[\r\n]/.test(password))) {
    setFlash(req, 'error', 'Temporary passwords must be 8–128 characters. Leave the field empty to generate one.');
  } else {
    if (!password) password = demoPassword();
    try {
      await helper.createUser(name, password);
      state.setMustChange(name, true);
      setFlash(req, 'creds', `Mailbox created for ${name}`, { creds: { address: `${name}@${config.domain}`, password } });
    } catch (e) {
      setFlash(req, 'error', helper.explain(e));
    }
  }
  res.redirect('/admin');
}));

app.post('/admin/users/:name/reset', requireAdmin, wrap(async (req, res) => {
  const { name } = req.params;
  if (!helper.NAME_RE.test(name)) return res.redirect('/admin');
  const password = demoPassword();
  try {
    await helper.setPassword(name, password);
    state.setMustChange(name, true);
    setFlash(req, 'creds', `New temporary password for ${name}`, { creds: { address: `${name}@${config.domain}`, password } });
  } catch (e) {
    setFlash(req, 'error', helper.explain(e));
  }
  res.redirect('/admin');
}));

app.post('/admin/users/:name/delete', requireAdmin, wrap(async (req, res) => {
  const { name } = req.params;
  if (!helper.NAME_RE.test(name)) return res.redirect('/admin');
  if (str(req.body.confirm).trim().toLowerCase() !== name) {
    setFlash(req, 'error', `Type ${name} exactly to confirm. The mailbox was not deleted.`);
    return res.redirect('/admin');
  }
  try {
    await helper.deleteUser(name);
    state.setMustChange(name, false);
    setFlash(req, 'ok', `Deleted ${name}@${config.domain} and all of its mail.`);
  } catch (e) {
    setFlash(req, 'error', helper.explain(e));
  }
  res.redirect('/admin');
}));

// ---------- errors ----------

app.use((req, res) => res.status(404).send(views.simplePage('Not found', "That page doesn't exist.")));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  console.error(err);
  if (err && err.code === 'ECONNREFUSED' && err.port === config.imapPort) {
    return res.status(503).send(views.simplePage(
      'Mail service unavailable',
      `The portal could not reach the mail server on port ${config.imapPort}, so nothing was changed. Server administrator: check that Dovecot is running (systemctl status dovecot).`,
    ));
  }
  res.status(500).send(views.simplePage(
    'Something went wrong',
    'The server hit an error and nothing was changed. Try again. If it keeps happening, tell your administrator.',
  ));
});

app.listen(config.port, config.host, () => {
  console.log(`Mail portal for ${config.domain} listening on http://${config.host}:${config.port}`);
});
