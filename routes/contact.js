/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Contact & Quote Routes
 *  File: routes/contact.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  PUBLIC ENDPOINTS:
 *
 *  POST /api/contact/contact
 *    Body: { first_name, last_name, email, phone, service, message }
 *    - Saves message to 'messages' table
 *    - Sends notification email to NOTIFY_EMAIL
 *    - Sends confirmation email to the customer
 *    Use: Homepage contact form.
 *
 *  POST /api/contact/quote
 *    Body: { first_name, last_name, email, phone, company,
 *            product_names, service, message }
 *    - Saves to 'quotes' table
 *    - Sends notification + confirmation emails
 *    Use: Request Service page, floating popup, cart checkout.
 *
 *  ADMIN ENDPOINTS (require JWT):
 *
 *  GET /api/contact/messages
 *    Query: ?status=unread|read &page=1 &limit=20
 *    Returns: { messages, total }
 *
 *  PUT /api/contact/messages/:id
 *    Body: { status, notes }  — mark as read, add internal notes
 *
 *  DELETE /api/contact/messages/:id
 *
 *  GET /api/contact/quotes
 *    Query: ?status=new|in_progress|completed|cancelled
 *    Returns: { quotes, total }
 *
 *  PUT /api/contact/quotes/:id
 *    Body: { status, notes }  — update pipeline status, add notes
 *
 *  DELETE /api/contact/quotes/:id
 *
 *  EMAIL SETUP:
 *  - Configure SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS in .env
 *  - For Gmail: use App Passwords (not your regular password)
 *  - Email failures are logged but don't break the form submission
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const { getDb } = require('../db/database');
const { auth } = require('../middleware/auth');
const { sendMail } = require('../lib/mailer');
const { syncOrderFromQuote } = require('../lib/orderQuoteSync');

// SEC-03 fix: basic RFC-5322-ish email validation. Rejects control
// characters (which enable email header injection) and requires a
// plausible local@domain shape. Not a full RFC parser — good enough to
// stop injection and obvious garbage without rejecting real addresses.
function isValidEmail(email) {
  if (typeof email !== 'string' || email.length > 254) return false;
  if (/[\r\n\0]/.test(email)) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email);
}

// SEC-02/SEC-03 fix: escape user-submitted text before interpolating it
// into HTML email bodies — closes the "HTML injection in confirmation
// emails via first_name" gap called out in the audit.
function escHtml(s) {
  return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

// DEV-05 fix: phone numbers were hardcoded here — now pulled from
// site_settings (contact_phone1/contact_phone2), the same source the admin
// Site Editor already manages for the rest of the site's contact info.
async function getContactPhonesLine() {
  try {
    const db = getDb();
    const p1 = await db.prepare("SELECT value FROM site_settings WHERE key='contact_phone1'").get();
    const p2 = await db.prepare("SELECT value FROM site_settings WHERE key='contact_phone2'").get();
    const phones = [p1?.value, p2?.value].filter(Boolean);
    return phones.length ? phones.join(' | ') : '';
  } catch { return ''; }
}

// Contact form
router.post('/contact', async (req, res, next) => {
  try {
    const { first_name, last_name, email, phone, service, message } = req.body;
    if (!first_name || !email || !message) return res.status(400).json({ error:'Name, email and message required.' });
    if (!isValidEmail(email)) return res.status(400).json({ error:'Please enter a valid email address.' });
    const db = getDb();
    const result = await db.prepare('INSERT INTO messages(first_name,last_name,email,phone,service,message) VALUES(?,?,?,?,?,?)').run(first_name,last_name||'',email,phone||'',service||'',message);
    console.log(`[Contact] New message saved — id=${result.lastInsertRowid}, from=${first_name} <${email}>`);
    // Respond to the user immediately — don't make them wait on email delivery.
    res.status(201).json({ message:'Message sent successfully!' });
    // Send emails in the background (fire-and-forget, not awaited). Any
    // failure — SMTP or DB — is caught inside and logged; it never affects
    // the already-sent response or the saved message.
    (async () => {
      const phonesLine = await getContactPhonesLine();
      await sendMail(process.env.NOTIFY_EMAIL,`New Contact: ${escHtml(first_name)} ${escHtml(last_name||'')}`,`<h2>New Contact Message</h2><p><b>From:</b> ${escHtml(first_name)} ${escHtml(last_name||'')} &lt;${escHtml(email)}&gt;</p><p><b>Phone:</b> ${escHtml(phone||'N/A')}</p><p><b>Service:</b> ${escHtml(service||'N/A')}</p><p><b>Message:</b></p><p>${escHtml(message)}</p>`);
      await sendMail(email,`We received your message — InfraConnect`,`<h2>Thank you, ${escHtml(first_name)}!</h2><p>We received your message and will respond within 24 hours.</p><p>&#128222; ${escHtml(phonesLine)}</p>`);
    })().catch(e => console.error('[Contact] background email error:', e.message));
  } catch (err) { next(err); }
});

// Quote request
router.post('/quote', async (req, res, next) => {
  try {
    const { first_name, last_name, email, phone, company, product_names, items_detail, service, message, order_id } = req.body;
    if (!first_name || !email) return res.status(400).json({ error:'Name and email required.' });
    if (!isValidEmail(email)) return res.status(400).json({ error:'Please enter a valid email address.' });
    const db = getDb();
    const itemsDetailStr = items_detail ? JSON.stringify(items_detail) : null;
    const orderId = order_id ? parseInt(order_id) : null;
    const result = await db.prepare('INSERT INTO quotes(first_name,last_name,email,phone,company,product_names,items_detail,service,message,order_id) VALUES(?,?,?,?,?,?,?,?,?,?)').run(first_name,last_name||'',email,phone||'',company||'',product_names||'',itemsDetailStr,service||'',message||'',orderId);
    console.log(`[Quote] New quote saved — id=${result.lastInsertRowid}, from=${first_name} <${email}>`);
    res.status(201).json({ message:'Quote request submitted!' });
    // Background email — never blocks or affects the saved record.
    (async () => {
      const phonesLine = await getContactPhonesLine();
      await sendMail(process.env.NOTIFY_EMAIL,`New Quote #${result.lastInsertRowid}: ${escHtml(first_name)} ${escHtml(last_name||'')}`,`<h2>New Quote Request</h2><p><b>Name:</b> ${escHtml(first_name)} ${escHtml(last_name||'')}</p><p><b>Email:</b> ${escHtml(email)}</p><p><b>Phone:</b> ${escHtml(phone||'N/A')}</p><p><b>Company:</b> ${escHtml(company||'N/A')}</p><p><b>Products:</b> ${escHtml(product_names||'N/A')}</p><p><b>Service:</b> ${escHtml(service||'N/A')}</p><p><b>Message:</b> ${escHtml(message||'N/A')}</p>`);
      await sendMail(email,`Quote request received — InfraConnect`,`<h2>Thank you, ${escHtml(first_name)}!</h2><p>Your quote request has been received. We'll send a detailed proposal within 24 hours.</p><p>&#128222; ${escHtml(phonesLine)}</p>`);
    })().catch(e => console.error('[Quote] background email error:', e.message));
  } catch (err) { next(err); }
});

// Admin: messages
router.get('/messages', auth, async (req, res, next) => {
  try {
    const { status, page=1, limit=20 } = req.query;
    const db = getDb();
    let sql = 'SELECT * FROM messages', p = [];
    if (status) { sql+=' WHERE status=?'; p.push(status); }
    sql+=` ORDER BY created_at DESC LIMIT ? OFFSET ?`; p.push(parseInt(limit),(parseInt(page)-1)*parseInt(limit));
    const msgs = await db.prepare(sql).all(...p);
    const total = Number((await db.prepare(`SELECT COUNT(*) as c FROM messages${status?' WHERE status=?':''}`).get(...(status?[status]:[]))).c);
    res.json({ messages:msgs, total });
  } catch (err) { next(err); }
});
router.put('/messages/:id', auth, async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    await getDb().prepare("UPDATE messages SET status=?,notes=?,updated_at=datetime('now') WHERE id=?").run(status,notes||'',req.params.id);
    res.json({ message:'Updated.' });
  } catch (err) { next(err); }
});
router.delete('/messages/:id', auth, async (req, res, next) => {
  try {
    await getDb().prepare('DELETE FROM messages WHERE id=?').run(req.params.id);
    res.json({ message:'Deleted.' });
  } catch (err) { next(err); }
});

// Admin: quotes
router.get('/quotes', auth, async (req, res, next) => {
  try {
    const { status, page=1, limit=20 } = req.query;
    const db = getDb();
    let sql = 'SELECT * FROM quotes', p = [];
    if (status) { sql+=' WHERE status=?'; p.push(status); }
    sql+=` ORDER BY created_at DESC LIMIT ? OFFSET ?`; p.push(parseInt(limit),(parseInt(page)-1)*parseInt(limit));
    const quotes = await db.prepare(sql).all(...p);
    quotes.forEach(q => { try { q.items_detail = q.items_detail ? JSON.parse(q.items_detail) : null; } catch { q.items_detail = null; } });
    const total = Number((await db.prepare(`SELECT COUNT(*) as c FROM quotes${status?' WHERE status=?':''}`).get(...(status?[status]:[]))).c);
    res.json({ quotes, total });
  } catch (err) { next(err); }
});
router.put('/quotes/:id', auth, async (req, res, next) => {
  try {
    const { status, notes } = req.body;
    const db = getDb();
    const existing = await db.prepare('SELECT order_id, status FROM quotes WHERE id=?').get(req.params.id);
    await db.prepare("UPDATE quotes SET status=?,notes=?,updated_at=datetime('now') WHERE id=?").run(status,notes||'',req.params.id);
    // If this quote came from a checkout order, keep that order's status in
    // sync too. No-op for Service Requests / manual quotes — they don't
    // have an order_id, so syncOrderFromQuote just returns immediately.
    if (existing && status && status !== existing.status) {
      await syncOrderFromQuote(db, existing.order_id, status);
    }
    res.json({ message:'Updated.' });
  } catch (err) { next(err); }
});
router.delete('/quotes/:id', auth, async (req, res, next) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT order_id FROM quotes WHERE id=?').get(req.params.id);
    await db.prepare('DELETE FROM quotes WHERE id=?').run(req.params.id);
    // Delete the linked order too, if any — same reasoning as the reverse
    // direction in routes/orders.js: they represent one purchase, so
    // leaving one half behind isn't useful.
    if (existing?.order_id) {
      await db.prepare('DELETE FROM orders WHERE id=?').run(existing.order_id);
    }
    res.json({ message:'Deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
