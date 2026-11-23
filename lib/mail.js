'use strict';
// Reads mail from Dovecot over IMAP and sends through Postfix, both on this machine.
// Signing in to the portal is an IMAP login, so the portal never reads /etc/shadow.
const crypto = require('crypto');
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { config } = require('./config');

const LIST_LIMIT = 50;

// Postfix accepts mail from 127.0.0.1 without a password (mynetworks), and the
// opendkim milter signs it on the way out.
const transport = nodemailer.createTransport({
  host: config.smtpHost,
  port: config.smtpPort,
  secure: false,
  ignoreTLS: true, // loopback only; avoids the self-signed certificate on port 25
});

function newClient(user, pass) {
  const client = new ImapFlow({
    host: config.imapHost,
    port: config.imapPort,
    secure: false,
    // Loopback only. Dovecot treats same-host connections as secure, and its default
    // certificate is self-signed, so the upgrade would fail verification.
    doSTARTTLS: false,
    auth: { user, pass },
    logger: false,
  });
  client.on('error', (e) => console.error('IMAP connection error:', e.message));
  return client;
}

async function withImap(user, pass, fn) {
  const client = newClient(user, pass);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    try { await client.logout(); } catch (_) { client.close(); }
  }
}

function isAuthError(e) {
  return Boolean(e && (e.authenticationFailed || /AUTHENTICATIONFAILED/i.test(e.serverResponseCode || '')));
}

async function verifyLogin(user, pass) {
  try {
    await withImap(user, pass, async () => {});
    return true;
  } catch (e) {
    if (isAuthError(e)) return false;
    throw e;
  }
}

async function sentPath(client) {
  const boxes = await client.list();
  const special = boxes.find((b) => b.specialUse === '\\Sent');
  if (special) return special.path;
  const named = boxes.find((b) => b.path.toLowerCase() === 'sent');
  if (named) return named.path;
  try { await client.mailboxCreate('Sent'); } catch (_) { /* created concurrently */ }
  return 'Sent';
}

const folderPath = (client, folder) => (folder === 'sent' ? sentPath(client) : 'INBOX');

function addressList(list) {
  return (list || []).map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(', ');
}

async function listMessages(user, pass, folder) {
  return withImap(user, pass, async (client) => {
    const path = await folderPath(client, folder);
    const lock = await client.getMailboxLock(path);
    try {
      const total = client.mailbox.exists;
      if (!total) return [];
      const start = Math.max(1, total - LIST_LIMIT + 1);
      const items = [];
      for await (const msg of client.fetch(`${start}:*`, { uid: true, envelope: true, flags: true, internalDate: true })) {
        const env = msg.envelope || {};
        const from = (env.from || [])[0] || {};
        items.push({
          uid: msg.uid,
          subject: env.subject || '(no subject)',
          fromName: from.name || from.address || '',
          to: addressList(env.to),
          date: env.date || msg.internalDate,
          seen: msg.flags ? msg.flags.has('\\Seen') : true,
        });
      }
      return items.reverse();
    } finally {
      lock.release();
    }
  });
}

async function getMessage(user, pass, folder, uid) {
  return withImap(user, pass, async (client) => {
    const path = await folderPath(client, folder);
    const lock = await client.getMailboxLock(path);
    try {
      const msg = await client.fetchOne(String(uid), { uid: true, source: true }, { uid: true });
      if (!msg || !msg.source) return null;
      await client.messageFlagsAdd(String(uid), ['\\Seen'], { uid: true });
      const p = await simpleParser(msg.source);
      const first = (field) => (p[field] && p[field].value && p[field].value[0] && p[field].value[0].address) || '';
      return {
        uid,
        subject: p.subject || '(no subject)',
        from: p.from ? p.from.text : '',
        to: p.to ? p.to.text : '',
        cc: p.cc ? p.cc.text : '',
        date: p.date,
        text: p.text || '',
        html: typeof p.html === 'string' ? p.html : '',
        messageId: p.messageId || '',
        references: Array.isArray(p.references) ? p.references : p.references ? [p.references] : [],
        replyAddress: first('replyTo') || first('from'),
        firstTo: first('to'),
        attachments: (p.attachments || []).map((a) => ({ filename: a.filename || 'Unnamed file', size: a.size || 0 })),
      };
    } finally {
      lock.release();
    }
  });
}

async function deleteMessage(user, pass, folder, uid) {
  return withImap(user, pass, async (client) => {
    const path = await folderPath(client, folder);
    const lock = await client.getMailboxLock(path);
    try {
      await client.messageDelete(String(uid), { uid: true });
    } finally {
      lock.release();
    }
  });
}

// Keeps only well-formed <message-id> tokens, so form fields can't inject headers.
function messageIds(value) {
  const raw = Array.isArray(value) ? value.join(' ') : String(value || '');
  return raw.match(/<[^<>\s]+>/g) || [];
}

async function sendMessage(user, pass, { to, cc, subject, text, inReplyTo, references }) {
  const address = `${user}@${config.domain}`;
  const replyTo = messageIds(inReplyTo)[0];
  const refs = messageIds(references);
  const composer = new MailComposer({
    from: { name: user, address },
    to,
    cc: cc.length ? cc : undefined,
    subject: subject || '(no subject)',
    text,
    inReplyTo: replyTo,
    references: refs.length ? refs : undefined,
    messageId: `<${crypto.randomUUID()}@${config.domain}>`,
    date: new Date(),
  });
  const raw = await new Promise((resolve, reject) =>
    composer.compile().build((err, buf) => (err ? reject(err) : resolve(buf))));

  // Logging in first proves the session's password is still valid before anything is sent.
  await withImap(user, pass, async (client) => {
    await transport.sendMail({ envelope: { from: address, to: [...to, ...cc] }, raw });
    try {
      await client.append(await sentPath(client), raw, ['\\Seen']);
    } catch (e) {
      console.error(`Sent, but could not save a copy to Sent for ${user}:`, e.message);
    }
  });
}

module.exports = { isAuthError, verifyLogin, listMessages, getMessage, deleteMessage, sendMessage, LIST_LIMIT };
