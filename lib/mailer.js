/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Shared Mail Helper
 *  File: lib/mailer.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Extracted from routes/contact.js so other features (like the monthly
 *  analytics report) can send email without duplicating the SMTP transport
 *  setup. BE-01's original fix still applies here: the transport is built
 *  once at module load and reused for every send.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const nodemailer = require('nodemailer');

const transport = nodemailer.createTransport({
  host: process.env.SMTP_HOST,
  port: parseInt(process.env.SMTP_PORT || 587),
  secure: false,
  auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS }
});

async function sendMail(to, subject, html) {
  try {
    await transport.sendMail({ from: process.env.SMTP_FROM, to, subject, html });
    return true;
  } catch(e) {
    console.log('Mail error:', e.message);
    return false;
  }
}

module.exports = { sendMail };
