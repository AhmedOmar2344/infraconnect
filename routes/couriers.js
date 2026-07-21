/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Courier Route
 *  File: routes/couriers.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Delivery tracking has 3 stages, exactly matching the workflow requested:
 *    1. confirmed   — set by an ADMIN action (routes/orders.js /:id/confirm),
 *                     not automatic — the admin verifies the order is ready
 *                     before it enters the delivery pipeline at all.
 *    2. dispatched   — set by the COURIER once assigned, from their own
 *                     portal, independent of the admin from this point on.
 *    3. delivering   — set by the COURIER when they start the delivery run;
 *                     this is also when their live location starts being
 *                     tracked and shown to the customer.
 *  (A final "delivered" stage exists too, courier-confirmed on drop-off.)
 *
 *  COURIER (own auth, separate from admin/customer):
 *    POST /api/couriers/login
 *    GET  /api/couriers/me/orders                 Orders assigned to them
 *    PUT  /api/couriers/me/orders/:id/stage        Advance to dispatched/delivering/delivered
 *    POST /api/couriers/me/orders/:id/location     Push a live lat/lng update
 *
 *  ADMIN:
 *    GET    /api/couriers            List couriers
 *    POST   /api/couriers            Create a courier account
 *    PUT    /api/couriers/:id        Edit / deactivate
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');
const { courierAuth } = require('../middleware/courierAuth');
const { auth, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { syncQuoteFromOrder } = require('../lib/orderQuoteSync');

function issueCourierToken(courier) {
  return jwt.sign({ id: courier.id, email: courier.email, type: 'courier' }, process.env.JWT_SECRET, { expiresIn: '30d' });
}

// ── COURIER ──────────────────────────────────────────────────────────────────
router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    const db = getDb();
    const courier = await db.prepare('SELECT * FROM couriers WHERE email=? AND active=1').get(email.trim().toLowerCase());
    if (!courier || !bcrypt.compareSync(password, courier.password)) return res.status(401).json({ error: 'Invalid email or password.' });
    await db.prepare("UPDATE couriers SET last_login=datetime('now') WHERE id=?").run(courier.id);
    const token = issueCourierToken(courier);
    res.json({ token, courier: { id: courier.id, name: courier.name, email: courier.email, phone: courier.phone } });
  } catch (err) { next(err); }
});

router.get('/me/orders', courierAuth, async (req, res, next) => {
  try {
    const orders = await getDb().prepare(
      "SELECT * FROM orders WHERE courier_id=? AND delivery_stage IS NOT NULL AND delivery_stage != 'delivered' ORDER BY created_at DESC"
    ).all(req.courier.id);
    res.json({ orders });
  } catch (err) { next(err); }
});

router.put('/me/orders/:id/stage', courierAuth, async (req, res, next) => {
  try {
    const { stage } = req.body;
    if (!['dispatched', 'delivering', 'delivered'].includes(stage)) {
      return res.status(400).json({ error: 'Invalid stage.' });
    }
    const db = getDb();
    const order = await db.prepare('SELECT * FROM orders WHERE id=? AND courier_id=?').get(req.params.id, req.courier.id);
    if (!order) return res.status(404).json({ error: 'Order not assigned to you.' });
    // Can't skip ahead — dispatched only follows confirmed, delivering only
    // follows dispatched, etc. Keeps the tracker meaningful for the
    // customer rather than allowing stages to jump around.
    const validNext = { confirmed: 'dispatched', dispatched: 'delivering', delivering: 'delivered' };
    if (validNext[order.delivery_stage] !== stage) {
      return res.status(400).json({ error: `Order must be "${validNext[order.delivery_stage] || 'confirmed'}" before this step.` });
    }
    const timestampCol = { dispatched: 'dispatched_at', delivering: 'delivering_at', delivered: 'delivered_at' }[stage];
    await db.prepare(`UPDATE orders SET delivery_stage=?, ${timestampCol}=datetime('now') WHERE id=?`).run(stage, req.params.id);
    if (stage === 'delivered') {
      await db.prepare("UPDATE orders SET status='completed' WHERE id=?").run(req.params.id);
      // The order and its linked quote (checkout creates both — see
      // lib/orderQuoteSync.js) previously only stayed in sync when an
      // ADMIN changed status manually. A courier marking "delivered" from
      // their own portal reached the order but never touched the quote,
      // so it kept showing "new"/"in_progress" indefinitely even after
      // the order was actually done.
      await syncQuoteFromOrder(db, req.params.id, 'completed');
    }
    // logActivity reads req.user (admin shape) — couriers authenticate via
    // req.courier instead, so it's mapped in here rather than changing
    // logActivity itself just for this one caller.
    req.user = { id: null, email: req.courier.email };
    logActivity(req, 'order.stage_' + stage, 'order', order.order_number, { via: 'courier' });
    res.json({ message: 'Updated.' });
  } catch (err) { next(err); }
});

router.post('/me/orders/:id/location', courierAuth, async (req, res, next) => {
  try {
    const { lat, lng } = req.body;
    if (typeof lat !== 'number' || typeof lng !== 'number') return res.status(400).json({ error: 'lat/lng required.' });
    const db = getDb();
    const order = await db.prepare('SELECT id FROM orders WHERE id=? AND courier_id=?').get(req.params.id, req.courier.id);
    if (!order) return res.status(404).json({ error: 'Order not assigned to you.' });
    await db.prepare("UPDATE orders SET courier_lat=?, courier_lng=?, courier_location_at=datetime('now') WHERE id=?").run(lat, lng, req.params.id);
    res.json({ message: 'Location updated.' });
  } catch (err) { next(err); }
});

// ── ADMIN: full access to the courier portal itself ─────────────────────────
// Lets an admin sign into /courier with their EXISTING admin session (no
// separate courier account needed) and see/manage every delivery across
// every courier — useful if a courier can't access their phone, or the
// admin just wants to check on things directly.

router.get('/all-orders', auth, requireAdmin, async (req, res, next) => {
  try {
    const orders = await getDb().prepare(
      "SELECT o.*, c.name as courier_name FROM orders o LEFT JOIN couriers c ON c.id = o.courier_id WHERE o.delivery_stage IS NOT NULL AND o.delivery_stage != 'delivered' ORDER BY o.created_at DESC"
    ).all();
    res.json({ orders });
  } catch (err) { next(err); }
});

router.put('/orders/:id/stage', auth, requireAdmin, async (req, res, next) => {
  try {
    const { stage } = req.body;
    if (!['dispatched', 'delivering', 'delivered'].includes(stage)) {
      return res.status(400).json({ error: 'Invalid stage.' });
    }
    const db = getDb();
    const order = await db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    // Same "can't skip ahead" rule as the courier's own endpoint — admin
    // access doesn't mean the tracker stops being meaningful.
    const validNext = { confirmed: 'dispatched', dispatched: 'delivering', delivering: 'delivered' };
    if (validNext[order.delivery_stage] !== stage) {
      return res.status(400).json({ error: `Order must be "${validNext[order.delivery_stage] || 'confirmed'}" before this step.` });
    }
    const timestampCol = { dispatched: 'dispatched_at', delivering: 'delivering_at', delivered: 'delivered_at' }[stage];
    await db.prepare(`UPDATE orders SET delivery_stage=?, ${timestampCol}=datetime('now') WHERE id=?`).run(stage, req.params.id);
    if (stage === 'delivered') {
      await db.prepare("UPDATE orders SET status='completed' WHERE id=?").run(req.params.id);
      await syncQuoteFromOrder(db, req.params.id, 'completed');
    }
    logActivity(req, 'order.stage_' + stage, 'order', order.order_number, { via: 'admin' });
    res.json({ message: 'Updated.' });
  } catch (err) { next(err); }
});

// ── ADMIN: courier account management ───────────────────────────────────────
router.get('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const couriers = await getDb().prepare('SELECT id,name,email,phone,active,created_at,last_login FROM couriers ORDER BY name').all();
    res.json({ couriers });
  } catch (err) { next(err); }
});

router.post('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const { name, email, password, phone } = req.body;
    if (!name?.trim() || !email?.trim() || !password || password.length < 8) {
      return res.status(400).json({ error: 'Name, email, and an 8+ character password are required.' });
    }
    const db = getDb();
    try {
      const result = await db.prepare('INSERT INTO couriers(name,email,password,phone) VALUES(?,?,?,?)')
        .run(name.trim(), email.trim().toLowerCase(), bcrypt.hashSync(password, 12), phone || '');
      logActivity(req, 'courier.create', 'courier', email.trim());
      res.status(201).json({ courier: await db.prepare('SELECT id,name,email,phone,active FROM couriers WHERE id=?').get(result.lastInsertRowid) });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'A courier with this email already exists.' });
      throw e;
    }
  } catch (err) { next(err); }
});

router.put('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const { active, phone } = req.body;
    const db = getDb();
    const existing = await db.prepare('SELECT * FROM couriers WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    await db.prepare('UPDATE couriers SET active=?, phone=? WHERE id=?').run(
      active !== undefined ? (active ? 1 : 0) : existing.active,
      phone !== undefined ? phone : existing.phone,
      req.params.id
    );
    res.json({ message: 'Updated.' });
  } catch (err) { next(err); }
});

// Couriers have no self-service "forgot password" flow (they're
// admin-provisioned accounts, not public signups) — this is how a locked-out
// courier gets back in.
router.put('/:id/reset-password', auth, requireAdmin, async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password || password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    const db = getDb();
    const existing = await db.prepare('SELECT email FROM couriers WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    await db.prepare('UPDATE couriers SET password=? WHERE id=?').run(bcrypt.hashSync(password, 12), req.params.id);
    logActivity(req, 'courier.reset_password', 'courier', existing.email);
    res.json({ message: 'Password reset.' });
  } catch (err) { next(err); }
});

router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT email FROM couriers WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    // Unassign rather than block deletion — past orders keep their
    // delivery history (stage, timestamps) even after the courier account
    // itself is gone, rather than either cascading deletes into order data
    // or refusing to ever let an admin remove an old courier account.
    await db.prepare('UPDATE orders SET courier_id=NULL WHERE courier_id=?').run(req.params.id);
    await db.prepare('DELETE FROM couriers WHERE id=?').run(req.params.id);
    logActivity(req, 'courier.delete', 'courier', existing.email);
    res.json({ message: 'Deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
