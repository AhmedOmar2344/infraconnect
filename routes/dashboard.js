const router = require('express').Router();
const { getDb } = require('../db/database');
const { auth } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
router.use(auth);
router.get('/stats', async (req, res, next) => {
  try {
    const db = getDb();
    const [
      productsTotal, productsFeatured, messagesTotal, messagesUnread,
      quotesTotal, quotesNew, ordersTotal, ordersPending,
      categories, recentMessages, recentQuotes, recentOrders, visitsThisMonth
    ] = await Promise.all([
      db.prepare('SELECT COUNT(*) as c FROM products WHERE active=1').get(),
      db.prepare('SELECT COUNT(*) as c FROM products WHERE active=1 AND featured=1').get(),
      db.prepare('SELECT COUNT(*) as c FROM messages').get(),
      db.prepare("SELECT COUNT(*) as c FROM messages WHERE status='unread'").get(),
      db.prepare('SELECT COUNT(*) as c FROM quotes').get(),
      db.prepare("SELECT COUNT(*) as c FROM quotes WHERE status='new'").get(),
      db.prepare('SELECT COUNT(*) as c FROM orders').get(),
      db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='pending'").get(),
      db.prepare('SELECT c.name as name, COUNT(p.id) as count FROM categories c LEFT JOIN products p ON c.id=p.category_id AND p.active=1 WHERE c.active=1 GROUP BY c.id, c.name').all(),
      db.prepare('SELECT * FROM messages ORDER BY created_at DESC LIMIT 5').all(),
      db.prepare('SELECT * FROM quotes ORDER BY created_at DESC LIMIT 5').all(),
      db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT 5').all(),
      db.prepare(`SELECT COUNT(*) as c FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE)`).get(),
    ]);
    res.json({
      // Postgres returns COUNT(*) as a string (bigint) — Number() here
      // avoids "0" !== 0 style bugs anywhere the frontend compares these.
      products: { total: Number(productsTotal.c), featured: Number(productsFeatured.c) },
      messages: { total: Number(messagesTotal.c), unread: Number(messagesUnread.c) },
      quotes: { total: Number(quotesTotal.c), new: Number(quotesNew.c) },
      orders: { total: Number(ordersTotal.c), pending: Number(ordersPending.c) },
      visits: { this_month: Number(visitsThisMonth.c) },
      categories: categories.map(c => ({ ...c, count: Number(c.count) })),
      recent: { messages: recentMessages, quotes: recentQuotes, orders: recentOrders }
    });
  } catch (err) { next(err); }
});
router.get('/users', async (req, res, next) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error:'Forbidden.' });
    res.json({ users: await getDb().prepare('SELECT id,name,email,role,active,created_at,last_login FROM users').all() });
  } catch (err) { next(err); }
});
router.post('/users', async (req, res, next) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error:'Forbidden.' });
    const { name, email, password, role } = req.body;
    if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required.' });
    // SEC-06 fix: the endpoint accepted a 1-character password before hashing.
    if (typeof password !== 'string' || password.length < 8) {
      return res.status(400).json({ error: 'Password must be at least 8 characters.' });
    }
    const bcrypt = require('bcryptjs');
    const db = getDb();
    try {
      const r = await db.prepare('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)').run(name,email,bcrypt.hashSync(password,12),role||'admin');
      logActivity(req, 'admin_user.create', 'admin_user', email, { role: role || 'admin' });
      res.status(201).json({ user: await db.prepare('SELECT id,name,email,role,active FROM users WHERE id=?').get(r.lastInsertRowid) });
    } catch (e) {
      // Postgres unique-violation code (SQLite's driver signaled this via a
      // message-text check instead — different format, see routes/orders.js).
      if (e.code === '23505') return res.status(409).json({ error:'Email already exists.' });
      throw e;
    }
  } catch (err) { next(err); }
});
router.delete('/users/:id', async (req, res, next) => {
  try {
    if (req.user.role !== 'superadmin') return res.status(403).json({ error:'Forbidden.' });
    if (parseInt(req.params.id) === req.user.id) return res.status(400).json({ error:"Can't delete yourself." });
    const target = await getDb().prepare('SELECT email FROM users WHERE id=?').get(req.params.id);
    await getDb().prepare('DELETE FROM users WHERE id=?').run(req.params.id);
    if (target) logActivity(req, 'admin_user.delete', 'admin_user', target.email);
    res.json({ message:'Deleted.' });
  } catch (err) { next(err); }
});
module.exports = router;
