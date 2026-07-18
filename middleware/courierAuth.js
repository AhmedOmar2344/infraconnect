/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Courier Authentication Middleware
 *  File: middleware/courierAuth.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  A third, fully separate auth system alongside admin (middleware/auth.js)
 *  and customer (middleware/customerAuth.js). Courier JWTs carry
 *  `type: 'courier'` — checked explicitly here, and middleware/auth.js
 *  rejects any token carrying a `type` claim at all, so a courier token
 *  can never be used against an admin route (or a customer route, since
 *  customerAuth checks specifically for `type === 'customer'`).
 * ═══════════════════════════════════════════════════════════════════════════
 */
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');

async function courierAuth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Not signed in.' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.type !== 'courier') return res.status(401).json({ error: 'Invalid session.' });
    const courier = await getDb().prepare('SELECT id,name,email,phone,active FROM couriers WHERE id=?').get(decoded.id);
    if (!courier || !courier.active) return res.status(401).json({ error: 'Account not found or disabled.' });
    req.courier = courier;
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired session.' }); }
}

module.exports = { courierAuth };
