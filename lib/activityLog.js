/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Activity Log Helper
 *  File: lib/activityLog.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Records who did what in the admin panel — created for accountability now
 *  that there are three different admin permission levels sharing the
 *  panel. Focused on the highest-value actions (credentials/secrets, admin
 *  user management, products, vouchers, order status, logins) rather than
 *  instrumenting every possible click, which would add a lot of surface
 *  area for a comparatively small accountability benefit.
 *
 *  admin_email is stored denormalized (copied at write time) rather than
 *  only looked up by admin_id — this is deliberate: if an admin account is
 *  later deleted, the log entry should still say who did it, not go blank
 *  or get silently deleted along with the account.
 *
 *  Never throws — a logging failure should never break the actual action
 *  it's trying to record. Fire-and-forget from the caller's perspective.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const { getDb } = require('../db/database');

/**
 * @param {object} req - the Express request (needs req.user from auth middleware)
 * @param {string} action - e.g. 'product.create', 'credential.delete', 'admin.login'
 * @param {string} entityType - e.g. 'product', 'voucher', 'credential', 'admin_user'
 * @param {string} entityLabel - human-readable identifier, e.g. product name or email
 * @param {object} [details] - optional extra context, stored as JSON
 */
async function logActivity(req, action, entityType, entityLabel, details) {
  try {
    const db = getDb();
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
    await db.prepare(
      'INSERT INTO activity_log(admin_id, admin_email, action, entity_type, entity_label, details, ip_address) VALUES(?,?,?,?,?,?,?)'
    ).run(
      req.user?.id || null,
      req.user?.email || 'unknown',
      action,
      entityType || null,
      entityLabel || null,
      details ? JSON.stringify(details) : null,
      ip
    );
  } catch (e) {
    console.error('[ActivityLog] Failed to record entry (non-fatal):', e.message);
  }
}

module.exports = { logActivity };
