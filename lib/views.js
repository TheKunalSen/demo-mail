'use strict';
const { esc } = require('./security');
const { config } = require('./config');
const { LIST_LIMIT } = require('./mail');

const TZ = process.env.DISPLAY_TZ || 'Asia/Kolkata';
const FOLDER_TITLES = { inbox: 'Inbox', sent: 'Sent' };

// ---------- small helpers ----------

const csrfField = (token) => `<input type="hidden" name="_csrf" value="${esc(token)}">`;

function toDate(d) {
  if (!d) return null;
  const x = new Date(d);
  return Number.isNaN(x.getTime()) ? null : x;
}
const ymd = (date) => date.toLocaleDateString('en-CA', { timeZone: TZ });

function shortDate(d) {
  const date = toDate(d);
  if (!date) return '';
  const now = new Date();
  if (ymd(date) === ymd(now)) {
    return date.toLocaleTimeString('en-IN', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
  }
  const opts = { timeZone: TZ, day: 'numeric', month: 'short' };
  if (ymd(date).slice(0, 4) !== ymd(now).slice(0, 4)) opts.year = 'numeric';
  return date.toLocaleDateString('en-IN', opts);
}

function fullDate(d) {
  const date = toDate(d);
  return date ? date.toLocaleString('en-IN', { timeZone: TZ, dateStyle: 'medium', timeStyle: 'short' }) : '';
}

const isoDate = (d) => { const date = toDate(d); return date ? date.toISOString() : ''; };

function fileSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const wordmark = () => `<span class="wm-main">${esc(config.brand)}</span><span class="wm-sub">Mail</span>`;

function notice(flash) {
  if (!flash || !flash.text || flash.type === 'creds') return '';
  const error = flash.type === 'error';
  return `<p class="notice ${error ? 'notice-error' : 'notice-ok'}" role="${error ? 'alert' : 'status'}">${esc(flash.text)}</p>`;
}
const errorNotice = (text) => (text ? notice({ type: 'error', text }) : '');

function layout({ title, body, bodyClass = '' }) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${esc(title)} – ${esc(config.brand)} Mail</title>
<link rel="stylesheet" href="/static/style.css">
</head>
<body class="${bodyClass}">
${body}
</body>
</html>`;
}

// ---------- mailbox user pages ----------

function userShell(ctx, active, title, content) {
  const link = (href, label, key) =>
    `<a href="${href}"${active === key ? ' aria-current="page"' : ''}>${label}</a>`;
  return layout({
    title,
    body: `<div class="app">
  <aside class="rail">
    <a class="wordmark" href="/mail/inbox">${wordmark()}</a>
    <a class="btn btn-write" href="/compose">Write message</a>
    <nav class="folders" aria-label="Folders">
      ${link('/mail/inbox', 'Inbox', 'inbox')}
      ${link('/mail/sent', 'Sent', 'sent')}
      ${link('/password', 'Password', 'password')}
    </nav>
    <div class="account">
      <span class="account-address">${esc(ctx.address)}</span>
      <form method="post" action="/logout">${csrfField(ctx.csrf)}<button type="submit" class="linkish">Sign out</button></form>
    </div>
  </aside>
  <main class="pane">
${content}
  </main>
</div>`,
  });
}

function mailboxPage({ ctx, folder, items, flash }) {
  const title = FOLDER_TITLES[folder];
  const unread = items.filter((i) => !i.seen).length;
  let summary = '';
  if (items.length) {
    summary = `${items.length} ${items.length === 1 ? 'message' : 'messages'}`;
    if (folder === 'inbox' && unread) summary += `, ${unread} unread`;
  }
  const rows = items.map((i) => `
    <li${i.seen ? '' : ' class="unread"'}>
      <a href="/mail/${folder}/${i.uid}">
        <span class="m-who">${esc(folder === 'sent' ? `To ${i.to}` : i.fromName)}</span>
        <span class="m-subj">${esc(i.subject)}</span>
        <time datetime="${isoDate(i.date)}">${esc(shortDate(i.date))}</time>
      </a>
    </li>`).join('');
  const empty = folder === 'sent'
    ? `<div class="empty"><p>Nothing sent yet. Messages you send from here are kept in this folder.</p><a class="btn" href="/compose">Write message</a></div>`
    : `<div class="empty"><p>No mail yet. Messages sent to ${esc(ctx.address)} will appear here.</p></div>`;

  return userShell(ctx, folder, title, `
    <header class="pane-head">
      <h1>${title}</h1>
      ${summary ? `<p class="pane-sub">${summary}</p>` : ''}
    </header>
    ${notice(flash)}
    ${items.length ? `<ol class="msglist">${rows}</ol>` : empty}
    ${items.length >= LIST_LIMIT ? `<p class="pane-note">Showing the ${LIST_LIMIT} most recent messages.</p>` : ''}`);
}

// HTML mail is shown inside a sandboxed frame: no scripts, no remote images.
const HTML_FRAME_HEAD =
  `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'">` +
  `<base target="_blank"><style>body{font-family:system-ui,sans-serif;margin:16px;color:#1c2135;background:#fff}</style>`;

function messagePage({ ctx, folder, msg, view, flash }) {
  const title = FOLDER_TITLES[folder];
  const showHtml = view === 'html' && msg.html;
  const body = showHtml
    ? `<iframe class="html-body" title="Formatted message" sandbox="allow-popups allow-popups-to-escape-sandbox" srcdoc="${esc(HTML_FRAME_HEAD + msg.html)}"></iframe>`
    : msg.text.trim()
      ? `<div class="text-body">${esc(msg.text)}</div>`
      : `<p class="muted">This message has no text.</p>`;
  const toggle = msg.html
    ? `<p class="view-toggle">${showHtml
        ? `<a href="/mail/${folder}/${msg.uid}">Show plain text</a>`
        : `<a href="/mail/${folder}/${msg.uid}?view=html">Show formatted version</a> <span class="muted">Remote images stay blocked.</span>`}</p>`
    : '';
  const attachments = msg.attachments.length
    ? `<section class="attachments">
        <h2>Attachments</h2>
        <ul>${msg.attachments.map((a) => `<li>${esc(a.filename)} <span class="muted">${fileSize(a.size)}</span></li>`).join('')}</ul>
        <p class="muted">Open this message in a mail app to download attachments.</p>
      </section>`
    : '';

  return userShell(ctx, folder, msg.subject, `
    ${notice(flash)}
    <article class="message">
      <header>
        <h1 class="msg-subject">${esc(msg.subject)}</h1>
        <dl class="msg-meta">
          <dt>From</dt><dd>${esc(msg.from)}</dd>
          <dt>To</dt><dd>${esc(msg.to)}</dd>
          ${msg.cc ? `<dt>Cc</dt><dd>${esc(msg.cc)}</dd>` : ''}
          <dt>Date</dt><dd><time datetime="${isoDate(msg.date)}">${esc(fullDate(msg.date))}</time></dd>
        </dl>
        <div class="msg-actions">
          <a class="btn" href="/compose?reply=${msg.uid}&amp;folder=${folder}">Reply</a>
          <form method="post" action="/mail/${folder}/${msg.uid}/delete">${csrfField(ctx.csrf)}<button class="btn btn-quiet" type="submit">Delete</button></form>
          <a class="back" href="/mail/${folder}">Back to ${title}</a>
        </div>
      </header>
      ${toggle}
      ${body}
      ${attachments}
    </article>`);
}

function composePage({ ctx, form, error }) {
  return userShell(ctx, 'compose', 'Write message', `
    <header class="pane-head"><h1>${form.inReplyTo ? 'Reply' : 'Write message'}</h1></header>
    ${errorNotice(error)}
    <form class="compose" method="post" action="/compose">
      ${csrfField(ctx.csrf)}
      <input type="hidden" name="inReplyTo" value="${esc(form.inReplyTo)}">
      <input type="hidden" name="references" value="${esc(form.references)}">
      <label for="to">To</label>
      <input id="to" name="to" value="${esc(form.to)}" required autocomplete="email" spellcheck="false">
      <p class="field-hint">Separate several addresses with commas.</p>
      <label for="cc">Cc</label>
      <input id="cc" name="cc" value="${esc(form.cc)}" autocomplete="email" spellcheck="false">
      <label for="subject">Subject</label>
      <input id="subject" name="subject" value="${esc(form.subject)}" maxlength="300">
      <label for="text">Message</label>
      <textarea id="text" name="text" rows="16">${esc(form.text)}</textarea>
      <div class="compose-actions">
        <button class="btn" type="submit">Send</button>
        <a href="/mail/inbox">Discard</a>
      </div>
      <p class="field-hint">Sent from ${esc(ctx.address)}.</p>
    </form>`);
}

function passwordPage({ ctx, forced, error, flash }) {
  return userShell(ctx, 'password', 'Password', `
    <header class="pane-head"><h1>${forced ? 'Choose your password' : 'Change password'}</h1></header>
    ${forced ? '<p class="notice notice-ok" role="status">The password you were given is temporary. Choose your own before you continue.</p>' : ''}
    ${notice(flash)}
    ${errorNotice(error)}
    <form class="narrow" method="post" action="/password">
      ${csrfField(ctx.csrf)}
      <label for="current">Current password</label>
      <input id="current" name="current" type="password" autocomplete="current-password" required>
      <label for="password">New password</label>
      <input id="password" name="password" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>
      <p class="field-hint">At least 10 characters.</p>
      <label for="confirm">New password again</label>
      <input id="confirm" name="confirm" type="password" autocomplete="new-password" minlength="10" maxlength="128" required>
      <button class="btn btn-block" type="submit">Save password</button>
    </form>`);
}

// ---------- sign-in pages ----------

function authShell({ title, intro, content }) {
  return layout({
    title,
    bodyClass: 'auth',
    body: `<div class="auth-wrap">
  <div class="auth-brand">
    <div class="wordmark">${wordmark()}</div>
    <p>${intro}</p>
  </div>
  <main class="auth-form">
${content}
  </main>
</div>`,
  });
}

function loginPage({ csrf, error, username = '', notice: info }) {
  return authShell({
    title: 'Sign in',
    intro: `Mail for ${esc(config.domain)}. Sign in with the address and password your administrator gave you.`,
    content: `
    <h1>Sign in</h1>
    ${info ? `<p class="notice notice-ok" role="status">${esc(info)}</p>` : ''}
    ${errorNotice(error)}
    <form method="post" action="/login">
      ${csrfField(csrf)}
      <label for="username">Email address</label>
      <input id="username" name="username" value="${esc(username)}" autocomplete="username" spellcheck="false" autocapitalize="none" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button class="btn btn-block" type="submit">Sign in</button>
    </form>
    <p class="auth-alt"><a href="/admin/login">Administrator sign in</a></p>`,
  });
}

function adminLoginPage({ csrf, error }) {
  return authShell({
    title: 'Administrator sign in',
    intro: `Create and remove mailboxes for ${esc(config.domain)}.`,
    content: `
    <h1>Administrator sign in</h1>
    ${errorNotice(error)}
    <form method="post" action="/admin/login">
      ${csrfField(csrf)}
      <label for="username">Administrator name</label>
      <input id="username" name="username" autocomplete="username" spellcheck="false" autocapitalize="none" required>
      <label for="password">Password</label>
      <input id="password" name="password" type="password" autocomplete="current-password" required>
      <button class="btn btn-block" type="submit">Sign in</button>
    </form>
    <p class="auth-alt"><a href="/login">Mailbox sign in</a></p>`,
  });
}

// ---------- administrator page ----------

function adminPage({ csrf, users, flash, signInUrl }) {
  const slip = flash && flash.type === 'creds' ? `
  <section class="slip" aria-labelledby="slip-title">
    <h2 id="slip-title">${esc(flash.text)}</h2>
    <dl>
      <dt>Address</dt><dd>${esc(flash.creds.address)}</dd>
      <dt>Temporary password</dt><dd class="slip-pw">${esc(flash.creds.password)}</dd>
      <dt>Sign in at</dt><dd>${esc(signInUrl)}</dd>
    </dl>
    <p>Copy these now. The password is shown only once, and they'll be asked to choose their own the first time they sign in.</p>
  </section>` : notice(flash);

  const rows = users.map((u) => `
        <tr>
          <td class="addr">${esc(u.name)}@${esc(config.domain)}</td>
          <td>${u.temporary ? '<span class="tag tag-temp">Temporary password</span>' : '<span class="tag">Own password</span>'}</td>
          <td>
            <div class="row-actions">
              <form method="post" action="/admin/users/${esc(u.name)}/reset">${csrfField(csrf)}<button class="btn btn-quiet btn-small" type="submit">Reset password</button></form>
              <details class="confirm-delete">
                <summary>Delete</summary>
                <form method="post" action="/admin/users/${esc(u.name)}/delete">
                  ${csrfField(csrf)}
                  <label for="confirm-${esc(u.name)}">Type ${esc(u.name)} to delete this mailbox and all its mail</label>
                  <input id="confirm-${esc(u.name)}" name="confirm" autocomplete="off" spellcheck="false" required>
                  <button class="btn btn-danger btn-small" type="submit">Delete mailbox</button>
                </form>
              </details>
            </div>
          </td>
        </tr>`).join('');

  return layout({
    title: 'Mailboxes',
    body: `<header class="admin-bar">
  <a class="wordmark" href="/admin">${wordmark()}</a>
  <form method="post" action="/admin/logout">${csrfField(csrf)}<button type="submit" class="linkish">Sign out</button></form>
</header>
<main class="admin">
  <h1>Mailboxes</h1>
  ${slip}
  <section class="create" aria-labelledby="create-title">
    <h2 id="create-title">Create a mailbox</h2>
    <form class="create-form" method="post" action="/admin/users">
      ${csrfField(csrf)}
      <div>
        <label for="new-username">Username</label>
        <div class="addr-input">
          <input id="new-username" name="username" required pattern="[a-z][a-z0-9_\\-]{1,31}" autocomplete="off" spellcheck="false" autocapitalize="none">
          <span>@${esc(config.domain)}</span>
        </div>
      </div>
      <div>
        <label for="new-password">Temporary password</label>
        <input id="new-password" name="password" autocomplete="off" minlength="8" maxlength="128" spellcheck="false">
      </div>
      <button class="btn" type="submit">Create mailbox</button>
    </form>
    <p class="field-hint">Lowercase letters, numbers, hyphens and underscores. Leave the password empty to generate one.</p>
  </section>
  <section aria-labelledby="list-title">
    <h2 id="list-title">${users.length} ${users.length === 1 ? 'mailbox' : 'mailboxes'}</h2>
    ${users.length
      ? `<div class="table-wrap"><table>
        <thead><tr><th scope="col">Address</th><th scope="col">Password</th><th scope="col">Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table></div>`
      : '<p class="muted">No mailboxes yet. Create the first one above.</p>'}
  </section>
</main>`,
  });
}

function simplePage(title, text, link = { href: '/', label: 'Go to the start page' }) {
  return layout({
    title,
    bodyClass: 'simple',
    body: `<main class="simple-box">
  <h1>${esc(title)}</h1>
  <p>${esc(text)}</p>
  <p><a href="${link.href}">${esc(link.label)}</a></p>
</main>`,
  });
}

module.exports = {
  fullDate,
  mailboxPage,
  messagePage,
  composePage,
  passwordPage,
  loginPage,
  adminLoginPage,
  adminPage,
  simplePage,
};
