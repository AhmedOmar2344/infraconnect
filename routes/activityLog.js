/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Activity Log Route
 *  File: routes/activityLog.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Read-only — entries are written via lib/activityLog.js from other routes,
 *  never created directly through this API. Superadmin-only: the log itself
 *  is oversight data, and letting a lower-privilege admin see everything
 *  every other admin has done would defeat some of its purpose.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const { getDb } = require('../db/database');
const { auth, requireSuperAdmin } = require('../middleware/auth');

router.get('/', auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { admin_email, action, page = 1, limit = 50 } = req.query;
    const db = getDb();
    let sql = 'SELECT * FROM activity_log';
    const conditions = [];
    const params = [];
    if (admin_email) { conditions.push('admin_email=?'); params.push(admin_email); }
    if (action) { conditions.push('action LIKE ?'); params.push(action + '%'); }
    if (conditions.length) sql += ' WHERE ' + conditions.join(' AND ');
    sql += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
    params.push(parseInt(limit), (parseInt(page) - 1) * parseInt(limit));
    const entries = await db.prepare(sql).all(...params);

    let countSql = 'SELECT COUNT(*) as c FROM activity_log';
    if (conditions.length) countSql += ' WHERE ' + conditions.join(' AND ');
    const total = Number((await db.prepare(countSql).get(...params.slice(0, conditions.length))).c);

    // Distinct admins for the filter dropdown in the UI
    const admins = await db.prepare('SELECT DISTINCT admin_email FROM activity_log ORDER BY admin_email').all();

    res.json({
      entries: entries.map(e => ({ ...e, details: e.details ? JSON.parse(e.details) : null })),
      total,
      admins: admins.map(a => a.admin_email),
    });
  } catch (err) { next(err); }
});

module.exports = router;
