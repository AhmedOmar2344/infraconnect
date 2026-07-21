/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Orders Routes
 *  File: routes/orders.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  HOW ORDERS WORK:
 *  1. Customer fills checkout form on /checkout
 *  2. POST /api/orders creates the order record
 *  3. POST /api/contact/quote also creates a quote for the same items
 *     (so the admin sees it in both Orders and Quotes sections)
 *  4. Admin reviews in dashboard, updates status, contacts customer
 *
 *  PUBLIC ENDPOINTS:
 *
 *  POST /api/orders
 *    Body: { client_name, client_email, client_phone, client_company,
 *            items, notes, total_label, subtotal }
 *    - items: string summary of cart items with quantities and prices
 *    - total_label: formatted total string shown in admin
 *    - subtotal: numeric total for records
 *    Returns: { order } with auto-generated order_number (IC-YYYYMMDD-XXXX)
 *
 *  ADMIN ENDPOINTS (require JWT):
 *
 *  GET /api/orders
 *    Query: ?status=pending|processing|completed|cancelled &page=1 &limit=20
 *
 *  GET /api/orders/:id
 *    Returns full order details with parsed items
 *
 *  PUT /api/orders/:id
 *    Body: { status, notes, total_label }
 *
 *  DELETE /api/orders/:id
 *
 *  ORDER STATUSES:
 *    pending     → New order, awaiting review
 *    processing  → Team is working on it / preparing quote
 *    completed   → Order fulfilled and delivered
 *    cancelled   → Order cancelled
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');
const { auth, requireAdmin } = require('../middleware/auth');
const { sendMail } = require('../lib/mailer');
const { syncQuoteFromOrder } = require('../lib/orderQuoteSync');
const { logActivity } = require('../lib/activityLog');

// BUG-02 fix: 6-digit suffix (was 4) cuts same-day collision odds ~90x, and
// genUniqueOrderNum() checks the DB and retries on the rare remaining
// collision instead of letting a UNIQUE constraint crash the request.
function genOrderNum() { const d=new Date(); return `IC-${d.getFullYear()}${String(d.getMonth()+1).padStart(2,'0')}${String(d.getDate()).padStart(2,'0')}-${Math.floor(100000+Math.random()*900000)}`; }

async function genUniqueOrderNum(db, maxAttempts = 10) {
  for (let i = 0; i < maxAttempts; i++) {
    const candidate = genOrderNum();
    const exists = await db.prepare('SELECT 1 FROM orders WHERE order_number=?').get(candidate);
    if (!exists) return candidate;
  }
  // Last resort: fall back to a value that cannot collide.
  return `IC-${Date.now()}`;
}

const LOW_STOCK_THRESHOLD = 5;

// Decrements stock_quantity for each ordered product, auto-marks a product
// out_of_stock the moment it hits 0, and emails the admin once when a
// product first drops below the low-stock threshold and again the moment
// it actually runs out — not on every subsequent order after that, so one
// popular item selling out doesn't spam the inbox on every sale.
// Products with stock_quantity = NULL are "not tracked" (e.g. made-to-order
// enterprise gear) and are skipped entirely — existing behavior for them
// is unchanged.
async function decrementStockForOrder(db, cartItems) {
  if (!Array.isArray(cartItems) || !cartItems.length) return;
  for (const item of cartItems) {
    const slug = item.slug || item.id;
    const qty = parseInt(item.qty) || 1;
    if (!slug) continue;
    try {
      const product = await db.prepare('SELECT id, name, stock_quantity FROM products WHERE slug=?').get(slug);
      if (!product || product.stock_quantity === null || product.stock_quantity === undefined) continue; // not tracked
      const oldQty = product.stock_quantity;
      const newQty = Math.max(0, oldQty - qty);
      const newStatus = newQty <= 0 ? 'out_of_stock' : 'available';
      await db.prepare('UPDATE products SET stock_quantity=?, stock_status=? WHERE id=?').run(newQty, newStatus, product.id);

      if (!process.env.NOTIFY_EMAIL) continue;
      if (oldQty > 0 && newQty <= 0) {
        await sendMail(process.env.NOTIFY_EMAIL, `Out of Stock: ${product.name}`,
          `<h2>Product Out of Stock</h2><p><b>${product.name}</b> just sold out and has been automatically marked "Out of Stock" on the store — customers can no longer add it to their cart.</p><p>Restock the item and update its Stock Quantity in the admin panel to bring it back.</p>`);
      } else if (oldQty >= LOW_STOCK_THRESHOLD && newQty < LOW_STOCK_THRESHOLD && newQty > 0) {
        await sendMail(process.env.NOTIFY_EMAIL, `Low Stock: ${product.name} (${newQty} left)`,
          `<h2>Low Stock Alert</h2><p><b>${product.name}</b> is down to <b>${newQty}</b> units.</p><p>Consider restocking soon — it'll automatically switch to "Out of Stock" on the store once it reaches 0.</p>`);
      }
    } catch (e) {
      console.error(`[Stock] Failed to update stock for "${slug}":`, e.message);
      // Never let a stock-tracking failure break the order itself.
    }
  }
}

const { calcDiscountForCurrency } = require('./vouchers');

router.post('/', async (req, res, next) => {
  try {
    const { client_name, client_email, client_phone, client_company, items, items_detail, cart_items, notes, total_label, voucher_code, amounts_by_currency } = req.body;
    if (!client_name || !client_email || !items) return res.status(400).json({ error:'Name, email and items required.' });
    const db = getDb();
    const order_number = await genUniqueOrderNum(db);
    const itemsStr = typeof items==='string' ? items : JSON.stringify(items);
    const itemsDetailStr = items_detail ? JSON.stringify(items_detail) : null;

    // Optional: link this order to a logged-in customer account, if one
    // sent their token — checkout still works exactly the same for guests
    // who never created an account at all.
    let customerId = null;
    const custToken = (req.headers['authorization'] || '').split(' ')[1];
    if (custToken) {
      try {
        const decoded = jwt.verify(custToken, process.env.JWT_SECRET);
        if (decoded.type === 'customer') customerId = decoded.id;
      } catch { /* not a valid/customer token — order just proceeds as guest */ }
    }
    const subtotal = amounts_by_currency ? Object.values(amounts_by_currency).reduce((s, v) => s + (Number(v) || 0), 0) : 0;

    // Re-validate and recalculate the discount server-side — never trust a
    // discount amount computed client-side, since that's trivially
    // editable in browser dev tools before the order is submitted.
    let appliedVoucherCode = null;
    let discountAmount = 0;
    let voucherRow = null;
    if (voucher_code && amounts_by_currency) {
      try {
        voucherRow = await db.prepare('SELECT * FROM vouchers WHERE UPPER(code)=UPPER(?)').get(voucher_code.trim());
        const stillValid = voucherRow && voucherRow.active
          && (!voucherRow.expires_at || new Date(voucherRow.expires_at) >= new Date())
          && (voucherRow.max_uses == null || voucherRow.times_used < voucherRow.max_uses)
          && subtotal >= (voucherRow.min_order_amount || 0);
        if (stillValid) {
          for (const [currency, amount] of Object.entries(amounts_by_currency)) {
            discountAmount += calcDiscountForCurrency(voucherRow, Number(amount) || 0, currency);
          }
          discountAmount = Math.round(discountAmount * 100) / 100;
          appliedVoucherCode = voucherRow.code;
        }
        // If it's no longer valid (expired/used up between checkout page
        // load and order submission), the order still goes through — just
        // without the discount — rather than blocking a real purchase over
        // a race condition on a promo code.
      } catch (e) {
        console.error('[Orders] Voucher re-validation error (order proceeds without discount):', e.message);
      }
    }

    try {
      const result = await db.prepare('INSERT INTO orders(order_number,client_name,client_email,client_phone,client_company,items,items_detail,notes,total_label,subtotal,voucher_code,discount_amount,customer_id) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(order_number,client_name,client_email,client_phone||'',client_company||'',itemsStr,itemsDetailStr,notes||'',total_label||'',subtotal,appliedVoucherCode,discountAmount,customerId);
      if (appliedVoucherCode) {
        db.prepare('UPDATE vouchers SET times_used = times_used + 1 WHERE id=?').run(voucherRow.id).catch(e => console.error('[Orders] Failed to increment voucher usage:', e.message));
      }
      res.status(201).json({ order: await db.prepare('SELECT * FROM orders WHERE id=?').get(result.lastInsertRowid) });
      // Fire-and-forget: the customer's order confirmation doesn't need to
      // wait on stock bookkeeping, and a stock-update failure should never
      // fail the order itself (caught inside decrementStockForOrder too).
      decrementStockForOrder(db, cart_items).catch(e => console.error('[Stock] decrementStockForOrder error:', e.message));
    } catch (e) {
      // Postgres unique-violation error code is 23505 (SQLite's driver used
      // to put "UNIQUE" in the message text instead — different format).
      if (e.code === '23505') return res.status(409).json({ error: 'Could not generate a unique order number, please try again.' });
      throw e;
    }
  } catch (err) { next(err); }
});

router.get('/', auth, async (req, res, next) => {
  try {
    const { status, page=1, limit=20 } = req.query;
    const db = getDb();
    let sql='SELECT o.*, q.id as linked_quote_id FROM orders o LEFT JOIN quotes q ON q.order_id=o.id', p=[];
    if (status) { sql+=' WHERE o.status=?'; p.push(status); }
    sql+=` ORDER BY o.created_at DESC LIMIT ? OFFSET ?`; p.push(parseInt(limit),(parseInt(page)-1)*parseInt(limit));
    const orders = await db.prepare(sql).all(...p);
    orders.forEach(o => { try { o.items_detail = o.items_detail ? JSON.parse(o.items_detail) : null; } catch { o.items_detail = null; } });
    const total = Number((await db.prepare(`SELECT COUNT(*) as c FROM orders${status?' WHERE status=?':''}`).get(...(status?[status]:[]))).c);
    res.json({ orders, total });
  } catch (err) { next(err); }
});

/**
 * GET /api/orders/export
 * Downloads all orders as an .xlsx file. Placed BEFORE /:id below — Express
 * matches routes in definition order, and /:id would otherwise swallow a
 * request to /export by treating "export" as the :id value.
 */
router.get('/export', auth, async (req, res, next) => {
  try {
    const XLSX = require('xlsx');
    const db = getDb();
    const { status } = req.query;
    let sql = 'SELECT * FROM orders';
    const params = [];
    if (status) { sql += ' WHERE status=?'; params.push(status); }
    sql += ' ORDER BY created_at DESC';
    const orders = await db.prepare(sql).all(...params);

    const rows = orders.map(o => ({
      'Order #': o.order_number,
      'Date': o.created_at,
      'Client Name': o.client_name,
      'Email': o.client_email,
      'Phone': o.client_phone,
      'Company': o.client_company,
      'Items': o.items,
      'Total': o.total_label,
      'Subtotal': o.subtotal,
      'Voucher': o.voucher_code || '',
      'Discount': o.discount_amount || 0,
      'Status': o.status,
      'Notes': o.notes,
    }));

    const ws = XLSX.utils.json_to_sheet(rows);
    ws['!cols'] = [{ wch: 16 }, { wch: 18 }, { wch: 20 }, { wch: 24 }, { wch: 15 }, { wch: 20 }, { wch: 40 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 10 }, { wch: 12 }, { wch: 30 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Orders');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="infraconnect-orders-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buffer);
  } catch (err) { next(err); }
});

router.get('/:id', auth, async (req, res, next) => {
  try {
    const o = await getDb().prepare('SELECT o.*, q.id as linked_quote_id FROM orders o LEFT JOIN quotes q ON q.order_id=o.id WHERE o.id=?').get(req.params.id);
    if (!o) return res.status(404).json({ error:'Not found.' });
    try { o.items = JSON.parse(o.items); } catch {}
    try { o.items_detail = o.items_detail ? JSON.parse(o.items_detail) : null; } catch { o.items_detail = null; }
    res.json({ order: o });
  } catch (err) { next(err); }
});

/**
 * GET /api/orders/:id/invoice
 * Downloads a PDF invoice. Works two ways, since there's no customer login
 * system to check against:
 *  - Admin: a valid Bearer token in the Authorization header skips the
 *    email check entirely.
 *  - Customer: no token, but the request must include ?email= matching
 *    the order's client_email — prevents casually guessing a sequential
 *    order ID to pull up someone else's invoice, without requiring a full
 *    account system just to view one PDF.
 */
router.get('/:id/invoice', async (req, res, next) => {
  try {
    const db = getDb();
    const o = await db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Order not found.' });

    let isAuthorized = false;
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (token) {
      try {
        jwt.verify(token, process.env.JWT_SECRET);
        isAuthorized = true; // any valid admin token — this is oversight data, not role-restricted further
      } catch { /* falls through to email check below */ }
    }
    if (!isAuthorized) {
      const email = (req.query.email || '').trim().toLowerCase();
      if (!email || email !== (o.client_email || '').toLowerCase()) {
        return res.status(403).json({ error: 'Provide the email address used on this order to view its invoice.' });
      }
    }

    let itemsDetail = [];
    try { itemsDetail = o.items_detail ? JSON.parse(o.items_detail) : null; } catch { itemsDetail = null; }

    const PDFDocument = require('pdfkit');
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="invoice-${o.order_number}.pdf"`);
    doc.pipe(res);

    // Header
    doc.fontSize(20).fillColor('#1a56db').text('InfraConnect', 50, 50);
    doc.fontSize(9).fillColor('#64748b').text('Cairo, Egypt — infraconnect24-7.com', 50, 75);
    doc.fontSize(16).fillColor('#111827').text('INVOICE', 400, 50, { align: 'right' });
    doc.fontSize(10).fillColor('#64748b').text(`Order #: ${o.order_number}`, 400, 75, { align: 'right' });
    doc.text(`Date: ${new Date(o.created_at).toLocaleDateString()}`, 400, 90, { align: 'right' });

    doc.moveTo(50, 115).lineTo(545, 115).strokeColor('#e2e8f0').stroke();

    // Bill-to
    doc.fontSize(10).fillColor('#111827').text('Bill To:', 50, 130);
    doc.fontSize(10).fillColor('#374151').text(o.client_name || '', 50, 146);
    if (o.client_company) doc.text(o.client_company, 50, 160);
    doc.text(o.client_email || '', 50, o.client_company ? 174 : 160);
    if (o.client_phone) doc.text(o.client_phone, 50, o.client_company ? 188 : 174);

    // Items table
    let y = 230;
    doc.fontSize(9).fillColor('#ffffff');
    doc.rect(50, y, 495, 22).fill('#1a56db');
    doc.fillColor('#ffffff').text('Item', 58, y + 6).text('Qty', 380, y + 6, { width: 50, align: 'right' }).text('Total', 480, y + 6, { width: 58, align: 'right' });
    y += 22;

    const lineItems = Array.isArray(itemsDetail) && itemsDetail.length
      ? itemsDetail.map(i => ({ name: i.name, qty: i.qty, total: i.lineTotal ?? (i.priceAmount ? i.priceAmount * i.qty : null), currency: i.currency }))
      : [{ name: o.items, qty: '', total: null, currency: '' }];

    doc.fontSize(9);
    lineItems.forEach((item, idx) => {
      if (idx % 2 === 1) { doc.rect(50, y, 495, 20).fill('#f8fafc'); }
      doc.fillColor('#374151').text(String(item.name || ''), 58, y + 5, { width: 310 });
      doc.text(item.qty !== '' ? String(item.qty) : '', 380, y + 5, { width: 50, align: 'right' });
      doc.text(item.total != null ? `${item.total.toLocaleString()} ${item.currency || ''}` : '—', 440, y + 5, { width: 98, align: 'right' });
      y += 20;
    });

    y += 10;
    doc.moveTo(50, y).lineTo(545, y).strokeColor('#e2e8f0').stroke();
    y += 12;

    if (o.discount_amount > 0) {
      doc.fontSize(10).fillColor('#16a34a').text(`Discount${o.voucher_code ? ` (${o.voucher_code})` : ''}: -${o.discount_amount}`, 350, y, { width: 195, align: 'right' });
      y += 16;
    }
    doc.fontSize(12).fillColor('#111827').text(`Total: ${o.total_label || 'TBD'}`, 350, y, { width: 195, align: 'right' });

    if (o.notes) {
      y += 40;
      doc.fontSize(9).fillColor('#64748b').text('Notes:', 50, y);
      doc.fontSize(9).fillColor('#374151').text(o.notes, 50, y + 14, { width: 495 });
    }

    doc.fontSize(8).fillColor('#94a3b8').text('This invoice was generated automatically by InfraConnect.', 50, 770, { align: 'center', width: 495 });

    doc.end();
  } catch (err) { next(err); }
});

/**
 * PUT /api/orders/:id/confirm
 * Stage 1 of delivery tracking — a deliberate ADMIN action, not automatic
 * on order creation, so nothing enters the delivery pipeline until
 * someone has actually verified it's ready to go out.
 */
router.put('/:id/confirm', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const o = await db.prepare('SELECT id, order_number FROM orders WHERE id=?').get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Not found.' });
    await db.prepare("UPDATE orders SET delivery_stage='confirmed', confirmed_at=datetime('now') WHERE id=?").run(req.params.id);
    logActivity(req, 'order.confirm', 'order', o.order_number);
    res.json({ message: 'Order confirmed.' });
  } catch (err) { next(err); }
});

/**
 * PUT /api/orders/:id/assign-courier
 * Admin hands the order off to a courier — from this point on, stage
 * advancement (dispatched → delivering → delivered) happens from the
 * courier's own portal, not the admin panel.
 */
router.put('/:id/assign-courier', auth, requireAdmin, async (req, res, next) => {
  try {
    const { courier_id } = req.body;
    const db = getDb();
    const order = await db.prepare('SELECT id, order_number FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });
    if (courier_id) {
      const courier = await db.prepare('SELECT id, name FROM couriers WHERE id=? AND active=1').get(courier_id);
      if (!courier) return res.status(404).json({ error: 'Courier not found or inactive.' });
      await db.prepare('UPDATE orders SET courier_id=? WHERE id=?').run(courier_id, req.params.id);
      logActivity(req, 'order.assign_courier', 'order', order.order_number, { courier: courier.name });
    } else {
      await db.prepare('UPDATE orders SET courier_id=NULL WHERE id=?').run(req.params.id);
    }
    res.json({ message: 'Updated.' });
  } catch (err) { next(err); }
});

/**
 * PUT /api/orders/:id/auto-assign-courier
 * Picks whichever ACTIVE courier currently has the fewest orders still in
 * progress (delivery_stage set, not yet delivered) — load-balanced rather
 * than round-robin, so a courier who's been quick to finish their last few
 * deliveries naturally gets the next one instead of everyone waiting in a
 * fixed rotation regardless of how busy they actually are right now.
 */
router.put('/:id/auto-assign-courier', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const order = await db.prepare('SELECT id, order_number FROM orders WHERE id=?').get(req.params.id);
    if (!order) return res.status(404).json({ error: 'Order not found.' });

    const candidate = await db.prepare(`
      SELECT c.id, c.name, COUNT(o.id) as active_count
      FROM couriers c
      LEFT JOIN orders o ON o.courier_id = c.id AND o.delivery_stage IS NOT NULL AND o.delivery_stage != 'delivered'
      WHERE c.active = 1
      GROUP BY c.id
      ORDER BY active_count ASC, c.name ASC
      LIMIT 1
    `).get();
    if (!candidate) return res.status(404).json({ error: 'No active couriers available — add one in Admin → Couriers first.' });

    await db.prepare('UPDATE orders SET courier_id=? WHERE id=?').run(candidate.id, req.params.id);
    logActivity(req, 'order.assign_courier', 'order', order.order_number, { courier: candidate.name, via: 'auto' });
    res.json({ message: `Assigned to ${candidate.name}.`, courier: { id: candidate.id, name: candidate.name } });
  } catch (err) { next(err); }
});

/**
 * GET /api/orders/:id/tracking
 * Customer-facing — same email-verification pattern as the invoice
 * endpoint (auth OR matching email, no separate token needed), returns
 * just what the tracker UI needs: current stage, timestamps, and the
 * courier's live location while "delivering".
 */
router.get('/:id/tracking', async (req, res, next) => {
  try {
    const db = getDb();
    const o = await db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) return res.status(404).json({ error: 'Order not found.' });

    let isAuthorized = false;
    const token = (req.headers['authorization'] || '').split(' ')[1];
    if (token) {
      try { jwt.verify(token, process.env.JWT_SECRET); isAuthorized = true; } catch {}
    }
    if (!isAuthorized) {
      const email = (req.query.email || '').trim().toLowerCase();
      if (!email || email !== (o.client_email || '').toLowerCase()) {
        return res.status(403).json({ error: 'Provide the email address used on this order to view tracking.' });
      }
    }

    res.json({
      order_number: o.order_number,
      status: o.status,
      delivery_stage: o.delivery_stage,
      confirmed_at: o.confirmed_at,
      dispatched_at: o.dispatched_at,
      delivering_at: o.delivering_at,
      delivered_at: o.delivered_at,
      courier_location: (o.delivery_stage === 'delivering' && o.courier_lat != null)
        ? { lat: o.courier_lat, lng: o.courier_lng, updated_at: o.courier_location_at }
        : null,
    });
  } catch (err) { next(err); }
});

router.put('/:id', auth, async (req, res, next) => {
  try {
    const { status, notes, total_label } = req.body;
    const db = getDb();
    const o = await db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id);
    if (!o) return res.status(404).json({ error:'Not found.' });
    const newStatus = status || o.status;
    await db.prepare("UPDATE orders SET status=?,notes=?,total_label=?,updated_at=datetime('now') WHERE id=?").run(newStatus,notes??o.notes,total_label||o.total_label,req.params.id);
    // Keep the linked quote (if this order came from checkout, which
    // creates both) showing the same status instead of going stale.
    if (status && status !== o.status) {
      await syncQuoteFromOrder(db, req.params.id, newStatus);
      logActivity(req, 'order.status_change', 'order', o.order_number, { from: o.status, to: newStatus });
    }
    res.json({ order: await db.prepare('SELECT * FROM orders WHERE id=?').get(req.params.id) });
  } catch (err) { next(err); }
});

router.delete('/:id', auth, async (req, res, next) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT order_number FROM orders WHERE id=?').get(req.params.id);
    // Delete the linked quote too — it represents the same purchase, so
    // leaving an orphaned quote behind after its order is gone would be
    // confusing rather than useful.
    await db.prepare('DELETE FROM quotes WHERE order_id=?').run(req.params.id);
    await db.prepare('DELETE FROM orders WHERE id=?').run(req.params.id);
    if (existing) logActivity(req, 'order.delete', 'order', existing.order_number);
    res.json({ message:'Deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
