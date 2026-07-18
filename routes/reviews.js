/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Reviews & Ratings Route
 *  File: routes/reviews.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  PUBLIC:
 *    POST /api/reviews                    Submit a review (starts as "pending")
 *    GET  /api/reviews/product/:productId Approved reviews + average rating
 *
 *  ADMIN (auth required):
 *    GET    /api/reviews          List all reviews (any status), for moderation
 *    PUT    /api/reviews/:id      Approve / reject / edit status
 *    DELETE /api/reviews/:id      Delete a review
 *
 *  MODERATION: reviews are NOT shown publicly until an admin approves them
 *  (status starts as 'pending') — this is a deliberate anti-spam/anti-abuse
 *  default for a small business site, not a limitation to work around.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const { getDb } = require('../db/database');
const { auth } = require('../middleware/auth');
const { sendMail } = require('../lib/mailer');

// ── PUBLIC: submit a review ─────────────────────────────────────────────────
router.post('/', async (req, res, next) => {
  try {
    const { product_id, customer_name, customer_email, rating, comment } = req.body;
    const productId = parseInt(product_id);
    const ratingNum = parseInt(rating);
    if (!productId || !customer_name || !customer_name.trim()) {
      return res.status(400).json({ error: 'Product and name are required.' });
    }
    if (!ratingNum || ratingNum < 1 || ratingNum > 5) {
      return res.status(400).json({ error: 'Rating must be between 1 and 5.' });
    }
    const db = getDb();
    const product = await db.prepare('SELECT id, name FROM products WHERE id=? AND active=1').get(productId);
    if (!product) return res.status(404).json({ error: 'Product not found.' });

    const result = await db.prepare(
      'INSERT INTO reviews(product_id, customer_name, customer_email, rating, comment, status) VALUES(?,?,?,?,?,?)'
    ).run(productId, customer_name.trim().slice(0, 100), (customer_email || '').trim().slice(0, 200), ratingNum, (comment || '').trim().slice(0, 2000), 'pending');

    console.log(`[Reviews] New review saved — id=${result.lastInsertRowid}, product=${product.name}, rating=${ratingNum}`);
    res.status(201).json({ message: 'Thank you! Your review will appear once approved.' });

    // Notify admin in the background — never blocks the customer's response.
    if (process.env.NOTIFY_EMAIL) {
      const escHtml = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      sendMail(
        process.env.NOTIFY_EMAIL,
        `New Review Pending: ${product.name} (${ratingNum}★)`,
        `<h2>New Product Review</h2><p><b>Product:</b> ${escHtml(product.name)}</p><p><b>Rating:</b> ${'★'.repeat(ratingNum)}${'☆'.repeat(5-ratingNum)}</p><p><b>From:</b> ${escHtml(customer_name)}</p>${comment ? `<p><b>Comment:</b> ${escHtml(comment)}</p>` : ''}<p style="color:#888;font-size:12px;">Approve or reject it in your admin panel under Reviews &amp; Ratings.</p>`
      ).catch(e => console.error('[Reviews] notification email error:', e.message));
    }
  } catch (err) { next(err); }
});

// ── PUBLIC: approved reviews + average rating for a product ────────────────
router.get('/product/:productId', async (req, res, next) => {
  try {
    const db = getDb();
    const productId = parseInt(req.params.productId);
    const reviews = await db.prepare(
      "SELECT id, customer_name, rating, comment, created_at FROM reviews WHERE product_id=? AND status='approved' ORDER BY created_at DESC LIMIT 50"
    ).all(productId);
    const avgRow = await db.prepare(
      "SELECT AVG(rating) as avg, COUNT(*) as count FROM reviews WHERE product_id=? AND status='approved'"
    ).get(productId);
    res.json({
      reviews,
      average_rating: avgRow.avg ? Math.round(Number(avgRow.avg) * 10) / 10 : null,
      review_count: Number(avgRow.count),
    });
  } catch (err) { next(err); }
});

// ── ADMIN: list all reviews for moderation ──────────────────────────────────
router.get('/', auth, async (req, res, next) => {
  try {
    const { status, page = 1, limit = 20 } = req.query;
    const db = getDb();
    let sql = `SELECT r.*, p.name as product_name, p.slug as product_slug FROM reviews r LEFT JOIN products p ON r.product_id = p.id`;
    const params = [];
    if (status) { sql += ' WHERE r.status=?'; params.push(status); }
    sql += ' ORDER BY r.created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    const reviews = await db.prepare(sql).all(...params);
    const total = Number((await db.prepare(`SELECT COUNT(*) as c FROM reviews${status ? ' WHERE status=?' : ''}`).get(...(status ? [status] : []))).c);
    const pendingCount = Number((await db.prepare("SELECT COUNT(*) as c FROM reviews WHERE status='pending'").get()).c);
    res.json({ reviews, total, pending_count: pendingCount });
  } catch (err) { next(err); }
});

// ── ADMIN: approve / reject / edit status ───────────────────────────────────
router.put('/:id', auth, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['pending', 'approved', 'rejected'].includes(status)) {
      return res.status(400).json({ error: 'Status must be pending, approved, or rejected.' });
    }
    await getDb().prepare("UPDATE reviews SET status=?, updated_at=datetime('now') WHERE id=?").run(status, req.params.id);
    res.json({ message: 'Updated.' });
  } catch (err) { next(err); }
});

// ── ADMIN: delete ────────────────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res, next) => {
  try {
    await getDb().prepare('DELETE FROM reviews WHERE id=?').run(req.params.id);
    res.json({ message: 'Deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
