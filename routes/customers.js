/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Customer Accounts Route
 *  File: routes/customers.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Public storefront accounts — separate from admin users entirely (own
 *  table, own JWT type, own middleware). Lets repeat customers see order
 *  history and skip re-entering their details at checkout, without
 *  requiring an account for guest checkout (orders.customer_id is
 *  nullable — guest orders keep working exactly as before).
 *
 *  PUBLIC:
 *    POST /api/customers/register   Create an account
 *    POST /api/customers/login      Sign in
 *
 *  AUTHENTICATED (customer session):
 *    GET  /api/customers/me           Current profile
 *    PUT  /api/customers/me           Update profile
 *    POST /api/customers/change-password
 *    GET  /api/customers/me/orders    Order history
 *
 *  KNOWN GAP: no "forgot password" flow yet — a customer who forgets their
 *  password currently has no self-service recovery path. Flagging this
 *  explicitly rather than shipping a rushed version of something that
 *  handles account-recovery security, which deserves more care than the
 *  remaining scope here allows.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const { getDb } = require('../db/database');
const { customerAuth } = require('../middleware/customerAuth');
const { auth, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { decrypt } = require('../lib/encryption');

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function issueCustomerToken(customer) {
  return jwt.sign({ id: customer.id, email: customer.email, type: 'customer' }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

router.post('/register', async (req, res, next) => {
  try {
    const { name, email, password, phone, company } = req.body;
    if (!name?.trim() || !email?.trim() || !password) {
      return res.status(400).json({ error: 'Name, email, and password are required.' });
    }
    if (!isValidEmail(email)) return res.status(400).json({ error: 'Please enter a valid email address.' });
    if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });

    const db = getDb();
    try {
      const result = await db.prepare(
        'INSERT INTO customers(name,email,password,phone,company) VALUES(?,?,?,?,?)'
      ).run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 12), phone || '', company || '');
      const customer = await db.prepare('SELECT id,name,email,phone,company FROM customers WHERE id=?').get(result.lastInsertRowid);
      const token = issueCustomerToken(customer);
      res.status(201).json({ token, customer });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'An account with this email already exists — try signing in instead.' });
      throw e;
    }
  } catch (err) { next(err); }
});

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    const db = getDb();
    const customer = await db.prepare('SELECT * FROM customers WHERE email=? AND active=1').get(email.trim().toLowerCase());
    if (!customer || !bcrypt.compareSync(password, customer.password)) {
      return res.status(401).json({ error: 'Invalid email or password.' });
    }
    await db.prepare("UPDATE customers SET last_login=datetime('now') WHERE id=?").run(customer.id);
    const token = issueCustomerToken(customer);
    res.json({ token, customer: { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone, company: customer.company } });
  } catch (err) { next(err); }
});

/**
 * POST /api/customers/google-auth
 * Handles both sign-in AND sign-up in one step — Google Identity Services
 * on the frontend returns a signed ID token after the user picks their
 * Google account; this verifies that token server-side (never trusts a
 * client-asserted email) and either logs into an existing account matching
 * that email, or creates a brand new one automatically. Either way results
 * in a normal customer session — nothing downstream needs to know or care
 * whether an account originated from a password or from Google.
 */
router.post('/google-auth', async (req, res, next) => {
  try {
    const { credential } = req.body;
    if (!credential) return res.status(400).json({ error: 'Missing Google credential.' });

    const db = getDb();
    let clientId = process.env.GOOGLE_CLIENT_ID;
    if (!clientId) {
      const clientIdRow = await db.prepare(
        "SELECT key_value_encrypted FROM api_credentials WHERE service_name='Google OAuth' AND key_label='Client ID' AND active=1"
      ).get();
      if (!clientIdRow) {
        return res.status(500).json({ error: 'Google Sign-In is not configured yet — add it in Admin → API Console (Service: "Google OAuth", Key Label: "Client ID"), or set GOOGLE_CLIENT_ID as an environment variable.' });
      }
      clientId = decrypt(clientIdRow.key_value_encrypted);
    }

    const client = new OAuth2Client(clientId);
    let payload;
    try {
      const ticket = await client.verifyIdToken({ idToken: credential, audience: clientId });
      payload = ticket.getPayload();
    } catch (e) {
      return res.status(401).json({ error: 'Could not verify Google sign-in — please try again.' });
    }
    if (!payload?.email) return res.status(401).json({ error: 'Google did not provide an email address.' });
    // Google verifies ownership of the email itself before issuing this
    // token, so email_verified=false here means it's a third-party email
    // Google can't vouch for — reject rather than silently trusting it.
    if (payload.email_verified === false) {
      return res.status(401).json({ error: 'Your Google account email is not verified.' });
    }

    const email = payload.email.toLowerCase();
    let customer = await db.prepare('SELECT * FROM customers WHERE email=?').get(email);

    if (customer) {
      if (!customer.active) return res.status(401).json({ error: 'This account has been disabled.' });
      if (!customer.google_id) {
        // Existing password-based account signing in with Google for the
        // first time — link it by email match rather than creating a
        // second, duplicate account for the same person.
        await db.prepare('UPDATE customers SET google_id=? WHERE id=?').run(payload.sub, customer.id);
      }
    } else {
      const result = await db.prepare('INSERT INTO customers(name,email,google_id,phone,company) VALUES(?,?,?,?,?)')
        .run(payload.name || email.split('@')[0], email, payload.sub, '', '');
      customer = await db.prepare('SELECT * FROM customers WHERE id=?').get(result.lastInsertRowid);
    }

    await db.prepare("UPDATE customers SET last_login=datetime('now') WHERE id=?").run(customer.id);
    const token = issueCustomerToken(customer);
    res.json({ token, customer: { id: customer.id, name: customer.name, email: customer.email, phone: customer.phone, company: customer.company } });
  } catch (err) { next(err); }
});

router.get('/me', customerAuth, (req, res) => res.json({ customer: req.customer }));

router.put('/me', customerAuth, async (req, res, next) => {
  try {
    const { name, phone, company, address } = req.body;
    const db = getDb();
    await db.prepare('UPDATE customers SET name=?, phone=?, company=?, address=? WHERE id=?').run(
      name?.trim() || req.customer.name, phone !== undefined ? phone : req.customer.phone,
      company !== undefined ? company : req.customer.company,
      address !== undefined ? address : req.customer.address,
      req.customer.id
    );
    const updated = await db.prepare('SELECT id,name,email,phone,company,address FROM customers WHERE id=?').get(req.customer.id);
    res.json({ customer: updated });
  } catch (err) { next(err); }
});

router.post('/change-password', customerAuth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 8) {
      return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    }
    const db = getDb();
    const customer = await db.prepare('SELECT password FROM customers WHERE id=?').get(req.customer.id);
    if (!bcrypt.compareSync(currentPassword, customer.password)) return res.status(401).json({ error: 'Current password incorrect.' });
    await db.prepare('UPDATE customers SET password=? WHERE id=?').run(bcrypt.hashSync(newPassword, 12), req.customer.id);
    res.json({ message: 'Password updated.' });
  } catch (err) { next(err); }
});

router.get('/me/orders', customerAuth, async (req, res, next) => {
  try {
    const db = getDb();
    const orders = await db.prepare('SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC').all(req.customer.id);
    orders.forEach(o => { try { o.items_detail = o.items_detail ? JSON.parse(o.items_detail) : null; } catch { o.items_detail = null; } });
    res.json({ orders });
  } catch (err) { next(err); }
});

// ── ADMIN: customer management ──────────────────────────────────────────────
// Placed after all the literal-path routes above (/me, /me/orders, etc) —
// :id below would otherwise match "me" as an id and swallow those routes,
// the same routing-order issue fixed earlier for /export vs /:slug on
// products and orders.

router.get('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    // Order count + total spend per customer in one query, rather than
    // N+1 queries per row — matters once there are more than a handful
    // of registered customers.
    const customers = await db.prepare(`
      SELECT c.id, c.name, c.email, c.phone, c.company, c.active, c.created_at, c.last_login,
        COUNT(o.id) as order_count,
        COALESCE(SUM(o.subtotal), 0) as total_spent
      FROM customers c
      LEFT JOIN orders o ON o.customer_id = c.id
      GROUP BY c.id
      ORDER BY c.created_at DESC
    `).all();
    res.json({ customers: customers.map(c => ({ ...c, order_count: Number(c.order_count), total_spent: Number(c.total_spent) })) });
  } catch (err) { next(err); }
});

router.get('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const customer = await db.prepare('SELECT id,name,email,phone,company,address,admin_notes,active,created_at,last_login FROM customers WHERE id=?').get(req.params.id);
    if (!customer) return res.status(404).json({ error: 'Not found.' });
    const orders = await db.prepare('SELECT * FROM orders WHERE customer_id=? ORDER BY created_at DESC').all(req.params.id);
    orders.forEach(o => { try { o.items_detail = o.items_detail ? JSON.parse(o.items_detail) : null; } catch { o.items_detail = null; } });
    res.json({ customer, orders });
  } catch (err) { next(err); }
});

router.put('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    const { active, admin_notes } = req.body;
    await db.prepare('UPDATE customers SET active=?, admin_notes=? WHERE id=?').run(
      active !== undefined ? (active ? 1 : 0) : existing.active,
      admin_notes !== undefined ? admin_notes : existing.admin_notes,
      req.params.id
    );
    logActivity(req, active !== undefined && !active ? 'customer.disable' : 'customer.update', 'customer', existing.email);
    res.json({ message: 'Updated.' });
  } catch (err) { next(err); }
});

module.exports = router;
