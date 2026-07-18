/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Refund Requests Route
 *  File: routes/refunds.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Lets a logged-in customer request a refund on one of their own orders,
 *  and lets an admin review/approve/reject it. This tracks the *request*
 *  and its outcome — it does not move money anywhere, since there's no
 *  payment processor integrated yet (see the API Console notes on that).
 *  Approving a request here is a record of the decision; actually issuing
 *  the refund still happens through whatever payment method was used.
 *
 *  CUSTOMER:
 *    POST /api/refunds                 Request a refund on one of your orders
 *    GET  /api/refunds/mine            Your own refund request history
 *
 *  ADMIN:
 *    GET  /api/refunds                 All refund requests
 *    PUT  /api/refunds/:id             Approve / reject, with a note
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const { getDb } = require('../db/database');
const { customerAuth } = require('../middleware/customerAuth');
const { auth, requireAdmin } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { sendMail } = require('../lib/mailer');

router.post('/', customerAuth, async (req, res, next) => {
  try {
    const { order_id, reason } = req.body;
    if (!order_id || !reason?.trim()) return res.status(400).json({ error: 'Order and reason are required.' });
    const db = getDb();
    // Only the order's own customer can request a refund on it — checked
    // by customer_id match, not just a raw order_id, so one customer can't
    // request a refund on someone else's order by guessing an id.
    const order = await db.prepare('SELECT id FROM orders WHERE id=? AND customer_id=?').get(order_id, req.customer.id);
    if (!order) return res.status(404).json({ error: 'Order not found on your account.' });

    const existing = await db.prepare("SELECT id FROM refund_requests WHERE order_id=? AND status='pending'").get(order_id);
    if (existing) return res.status(409).json({ error: 'A refund request for this order is already pending review.' });

    const result = await db.prepare('INSERT INTO refund_requests(order_id, customer_id, reason) VALUES(?,?,?)')
      .run(order_id, req.customer.id, reason.trim().slice(0, 1000));

    if (process.env.NOTIFY_EMAIL) {
      const escHtml = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      sendMail(process.env.NOTIFY_EMAIL, `Refund Requested — Order #${order_id}`,
        `<h2>New Refund Request</h2><p><b>Customer:</b> ${escHtml(req.customer.name)} (${escHtml(req.customer.email)})</p><p><b>Reason:</b> ${escHtml(reason)}</p><p>Review it in your admin panel under Orders → Refund Requests.</p>`
      ).catch(() => {});
    }

    res.status(201).json({ refund_request: await db.prepare('SELECT * FROM refund_requests WHERE id=?').get(result.lastInsertRowid) });
  } catch (err) { next(err); }
});

router.get('/mine', customerAuth, async (req, res, next) => {
  try {
    const requests = await getDb().prepare('SELECT * FROM refund_requests WHERE customer_id=? ORDER BY created_at DESC').all(req.customer.id);
    res.json({ refund_requests: requests });
  } catch (err) { next(err); }
});

router.get('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const requests = await db.prepare(`
      SELECT r.*, o.order_number, o.total_label, c.name as customer_name, c.email as customer_email
      FROM refund_requests r
      LEFT JOIN orders o ON o.id = r.order_id
      LEFT JOIN customers c ON c.id = r.customer_id
      ORDER BY r.created_at DESC
    `).all();
    res.json({ refund_requests: requests });
  } catch (err) { next(err); }
});

router.put('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const { status, admin_notes } = req.body;
    if (!['pending', 'approved', 'rejected'].includes(status)) return res.status(400).json({ error: 'Invalid status.' });
    const db = getDb();
    const existing = await db.prepare('SELECT * FROM refund_requests WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    await db.prepare("UPDATE refund_requests SET status=?, admin_notes=?, updated_at=datetime('now') WHERE id=?")
      .run(status, admin_notes !== undefined ? admin_notes : existing.admin_notes, req.params.id);
    logActivity(req, 'refund.' + status, 'refund_request', `Order #${existing.order_id}`);
    res.json({ message: 'Updated.' });
  } catch (err) { next(err); }
});

module.exports = router;
