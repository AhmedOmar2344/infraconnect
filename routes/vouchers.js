/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Vouchers & Discounts Route
 *  File: routes/vouchers.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  PUBLIC:
 *    POST /api/vouchers/validate   Check a code at checkout, returns the
 *                                  discount to apply (or why it's invalid)
 *
 *  ADMIN (auth required):
 *    GET    /api/vouchers          List all vouchers
 *    POST   /api/vouchers          Create a voucher
 *    PUT    /api/vouchers/:id      Edit a voucher
 *    DELETE /api/vouchers/:id      Delete a voucher
 *
 *  DISCOUNT CALCULATION:
 *  - percentage: subtotal * (discount_value / 100), capped at
 *    max_discount_amount if one is set (e.g. "50% off, up to 500 EGP" —
 *    without a cap, a 50%-off code on a $10,000 enterprise order would
 *    hand out a $5,000 discount, which is almost never the intent).
 *  - fixed: discount_value directly, capped at the subtotal itself (a
 *    fixed discount can never make the order total negative).
 *
 *  MULTI-CURRENCY NOTE: the cart can hold items priced in USD/EGP/AED at
 *  once. The discount is calculated per currency group in the cart
 *  (mirroring how the cart already totals per-currency) — the cap only
 *  applies to whichever currency group matches max_discount_currency;
 *  other currency groups in a mixed cart get the percentage applied
 *  uncapped, since a single numeric cap can't be meaningfully converted
 *  across currencies without a live exchange rate. This is a deliberate,
 *  documented limitation — most real orders are single-currency in
 *  practice, so it's an edge case, not the common path.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const { getDb } = require('../db/database');
const { auth } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');

function calcDiscountForCurrency(voucher, amountInThisCurrency, currency) {
  if (voucher.discount_type === 'fixed') {
    return Math.min(voucher.discount_value, amountInThisCurrency);
  }
  // percentage
  let discount = amountInThisCurrency * (voucher.discount_value / 100);
  if (voucher.max_discount_amount != null && voucher.max_discount_currency === currency) {
    discount = Math.min(discount, voucher.max_discount_amount);
  }
  return Math.min(discount, amountInThisCurrency);
}

// ── PUBLIC: validate a code at checkout ─────────────────────────────────────
// Body: { code, amounts_by_currency: { USD: 1200, EGP: 5000, ... } }
router.post('/validate', async (req, res, next) => {
  try {
    const { code, amounts_by_currency } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ valid: false, error: 'Enter a promo code.' });
    if (!amounts_by_currency || typeof amounts_by_currency !== 'object') {
      return res.status(400).json({ valid: false, error: 'Cart total is required.' });
    }
    const db = getDb();
    const voucher = await db.prepare('SELECT * FROM vouchers WHERE UPPER(code)=UPPER(?)').get(code.trim());
    if (!voucher) return res.status(404).json({ valid: false, error: 'Invalid promo code.' });
    if (!voucher.active) return res.status(400).json({ valid: false, error: 'This promo code is no longer active.' });
    if (voucher.expires_at && new Date(voucher.expires_at) < new Date()) {
      return res.status(400).json({ valid: false, error: 'This promo code has expired.' });
    }
    if (voucher.max_uses != null && voucher.times_used >= voucher.max_uses) {
      return res.status(400).json({ valid: false, error: 'This promo code has reached its usage limit.' });
    }
    const totalAcrossCurrencies = Object.values(amounts_by_currency).reduce((s, v) => s + (Number(v) || 0), 0);
    if (totalAcrossCurrencies < (voucher.min_order_amount || 0)) {
      return res.status(400).json({ valid: false, error: `This code requires a minimum order of ${voucher.min_order_amount}.` });
    }

    const discounts_by_currency = {};
    for (const [currency, amount] of Object.entries(amounts_by_currency)) {
      discounts_by_currency[currency] = Math.round(calcDiscountForCurrency(voucher, Number(amount) || 0, currency) * 100) / 100;
    }

    res.json({
      valid: true,
      code: voucher.code,
      discount_type: voucher.discount_type,
      discount_value: voucher.discount_value,
      discounts_by_currency,
    });
  } catch (err) { next(err); }
});

// ── ADMIN ────────────────────────────────────────────────────────────────────
router.get('/', auth, async (req, res, next) => {
  try {
    const vouchers = await getDb().prepare('SELECT * FROM vouchers ORDER BY created_at DESC').all();
    res.json({ vouchers });
  } catch (err) { next(err); }
});

router.post('/', auth, async (req, res, next) => {
  try {
    const { code, discount_type, discount_value, max_discount_amount, max_discount_currency, min_order_amount, max_uses, expires_at } = req.body;
    if (!code || !code.trim()) return res.status(400).json({ error: 'Code is required.' });
    if (!discount_value || Number(discount_value) <= 0) return res.status(400).json({ error: 'Discount value must be greater than 0.' });
    const type = discount_type === 'fixed' ? 'fixed' : 'percentage';
    if (type === 'percentage' && Number(discount_value) > 100) {
      return res.status(400).json({ error: 'Percentage discount cannot exceed 100.' });
    }
    const db = getDb();
    try {
      const result = await db.prepare(
        'INSERT INTO vouchers(code,discount_type,discount_value,max_discount_amount,max_discount_currency,min_order_amount,max_uses,expires_at) VALUES(?,?,?,?,?,?,?,?)'
      ).run(
        code.trim().toUpperCase(), type, Number(discount_value),
        max_discount_amount ? Number(max_discount_amount) : null,
        max_discount_currency || null,
        min_order_amount ? Number(min_order_amount) : 0,
        max_uses ? parseInt(max_uses) : null,
        expires_at || null
      );
      const created = await db.prepare('SELECT * FROM vouchers WHERE id=?').get(result.lastInsertRowid);
      logActivity(req, 'voucher.create', 'voucher', created.code, { discount_type: type, discount_value: Number(discount_value) });
      res.status(201).json({ voucher: created });
    } catch (e) {
      if (e.code === '23505') return res.status(409).json({ error: 'A voucher with this code already exists.' });
      throw e;
    }
  } catch (err) { next(err); }
});

router.put('/:id', auth, async (req, res, next) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT * FROM vouchers WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    const { code, discount_type, discount_value, max_discount_amount, max_discount_currency, min_order_amount, max_uses, expires_at, active } = req.body;
    const type = discount_type !== undefined ? (discount_type === 'fixed' ? 'fixed' : 'percentage') : existing.discount_type;
    await db.prepare(
      `UPDATE vouchers SET code=?,discount_type=?,discount_value=?,max_discount_amount=?,max_discount_currency=?,min_order_amount=?,max_uses=?,expires_at=?,active=?,updated_at=datetime('now') WHERE id=?`
    ).run(
      code ? code.trim().toUpperCase() : existing.code,
      type,
      discount_value !== undefined ? Number(discount_value) : existing.discount_value,
      max_discount_amount !== undefined ? (max_discount_amount ? Number(max_discount_amount) : null) : existing.max_discount_amount,
      max_discount_currency !== undefined ? (max_discount_currency || null) : existing.max_discount_currency,
      min_order_amount !== undefined ? Number(min_order_amount) : existing.min_order_amount,
      max_uses !== undefined ? (max_uses ? parseInt(max_uses) : null) : existing.max_uses,
      expires_at !== undefined ? (expires_at || null) : existing.expires_at,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      req.params.id
    );
    const updated = await db.prepare('SELECT * FROM vouchers WHERE id=?').get(req.params.id);
    logActivity(req, 'voucher.update', 'voucher', updated.code);
    res.json({ voucher: updated });
  } catch (err) { next(err); }
});

router.delete('/:id', auth, async (req, res, next) => {
  try {
    const existing = await getDb().prepare('SELECT code FROM vouchers WHERE id=?').get(req.params.id);
    await getDb().prepare('DELETE FROM vouchers WHERE id=?').run(req.params.id);
    if (existing) logActivity(req, 'voucher.delete', 'voucher', existing.code);
    res.json({ message: 'Deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.calcDiscountForCurrency = calcDiscountForCurrency;
