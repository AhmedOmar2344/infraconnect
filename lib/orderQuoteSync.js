/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Order/Quote Status Sync
 *  File: lib/orderQuoteSync.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Checkout creates BOTH an order and a quote for the same purchase (the
 *  quote acts as a CRM inbox entry, the order as the fulfillment record).
 *  Previously these were two fully independent records with no connection
 *  — updating or deleting one never touched the other, so they'd silently
 *  drift out of sync (e.g. an order marked "Completed" while its matching
 *  quote still said "New"). quotes.order_id now links them, and this file
 *  is the shared status-vocabulary mapping both routes/orders.js and
 *  routes/contact.js use to keep them in sync in both directions.
 *
 *  Orders use:  pending | processing | completed | cancelled
 *  Quotes use:  new     | in_progress | completed | cancelled
 * ═══════════════════════════════════════════════════════════════════════════
 */

const ORDER_TO_QUOTE_STATUS = {
  pending: 'new',
  processing: 'in_progress',
  completed: 'completed',
  cancelled: 'cancelled',
};

const QUOTE_TO_ORDER_STATUS = {
  new: 'pending',
  in_progress: 'processing',
  completed: 'completed',
  cancelled: 'cancelled',
};

// When an order's status changes, update any quote(s) linked to it via
// quotes.order_id so they show the equivalent status instead of going stale.
async function syncQuoteFromOrder(db, orderId, orderStatus) {
  const quoteStatus = ORDER_TO_QUOTE_STATUS[orderStatus];
  if (!quoteStatus) return;
  try {
    await db.prepare("UPDATE quotes SET status=?, updated_at=datetime('now') WHERE order_id=?").run(quoteStatus, orderId);
  } catch (e) { console.error('[OrderQuoteSync] Failed to sync quote from order:', e.message); }
}

// The reverse — when a quote linked to an order changes status, update
// that order too.
async function syncOrderFromQuote(db, orderId, quoteStatus) {
  if (!orderId) return;
  const orderStatus = QUOTE_TO_ORDER_STATUS[quoteStatus];
  if (!orderStatus) return;
  try {
    await db.prepare("UPDATE orders SET status=?, updated_at=datetime('now') WHERE id=?").run(orderStatus, orderId);
  } catch (e) { console.error('[OrderQuoteSync] Failed to sync order from quote:', e.message); }
}

module.exports = { ORDER_TO_QUOTE_STATUS, QUOTE_TO_ORDER_STATUS, syncQuoteFromOrder, syncOrderFromQuote };
