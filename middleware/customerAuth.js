/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Customer Authentication Middleware
 *  File: middleware/customerAuth.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Deliberately separate from middleware/auth.js (admin auth) — different
 *  token shape, different table, different trust level. A customer account
 *  should never be able to reach an admin route, and vice versa.
 *
 *  Customer JWTs carry `type: 'customer'`; admin JWTs never set this field.
 *  This middleware checks for it explicitly (rejecting anything without
 *  it) and, symmetrically, middleware/auth.js rejects any token carrying a
 *  `type` claim — the same pattern already used there to stop the 2FA
 *  temp-tokens from being usable as full sessions.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');

async function customerAuth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'customer') return res.status(401).json({ error: 'Invalid session.' });
    const customer = await getDb().prepare('SELECT id,name,email,phone,company,address,active FROM customers WHERE id=?').get(decoded.id);
    if (!customer || !customer.active) return res.status(401).json({ error: 'Account not found or disabled.' });
    req.customer = customer;
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired session.' }); }
}

module.exports = { customerAuth };
