'use strict';
const crypto = require('crypto');

const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ENTITIES[c]);
}

// Compares two strings without leaking where they differ.
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// One token per session; every POST form must send it back as _csrf.
function csrf(req, res, next) {
  if (!req.session.csrf) req.session.csrf = crypto.randomBytes(24).toString('hex');
  res.locals.csrf = req.session.csrf;
  if (req.method === 'POST') {
    const sent = req.body && typeof req.body._csrf === 'string' ? req.body._csrf : '';
    if (!sent || !safeEqual(sent, req.session.csrf)) {
      return res
        .status(403)
        .send('This form expired. Go back, reload the page, and submit it again.');
    }
  }
  next();
}

module.exports = { esc, safeEqual, csrf };
