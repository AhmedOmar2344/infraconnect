/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Authentication Middleware
 *  File: middleware/auth.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  WHAT THIS DOES:
 *  Provides Express middleware to protect admin API routes with JWT auth.
 *
 *  USAGE IN ROUTES:
 *    const { auth, requireRole } = require('../middleware/auth');
 *
 *    // Protect a route — any logged-in admin:
 *    router.get('/products', auth, (req, res) => { ... });
 *
 *    // Protect a route — only superadmin role:
 *    router.delete('/users/:id', auth, requireRole('superadmin'), (req, res) => { ... });
 *
 *  HOW auth MIDDLEWARE WORKS:
 *  1. Reads Authorization header: "Bearer <jwt_token>"
 *  2. Verifies token signature using JWT_SECRET from .env
 *  3. Looks up the user in the database to ensure they're still active
 *  4. Attaches user object to req.user for use in route handlers
 *  5. Returns 401 Unauthorized if token is missing, invalid, or expired
 *
 *  ROLES:
 *    poweruser  → Day-to-day operations only: view dashboard, manage orders,
 *                 messages, quotes, and service requests. Cannot touch
 *                 products/categories, site content, AI creator, bulk
 *                 upload, or admin users. Good for support/ops staff who
 *                 shouldn't be able to change the website itself or spend
 *                 money via the AI feature.
 *    admin      → Everything poweruser can do, PLUS products, categories,
 *                 site content editing, AI Product Creator, bulk upload.
 *                 Cannot manage other admin accounts.
 *    superadmin → All admin permissions + can create/view/delete admin
 *                 user accounts.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');

async function auth(req, res, next) {
  const token = (req.headers['authorization'] || '').split(' ')[1];
  if (!token) return res.status(401).json({ error: 'No token provided.' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Real session tokens (issued by /login or /2fa/verify-login) never
    // carry a "purpose" or "type" claim — only the short-lived,
    // single-endpoint 2FA tokens carry "purpose", and customer account
    // tokens (middleware/customerAuth.js) carry "type: customer". Without
    // this check, either of those would otherwise pass the checks below
    // just fine (valid signature, real id) and grant admin access —
    // defeating the whole point of keeping customer accounts and 2FA
    // setup completely separate from real admin sessions.
    if (decoded.purpose || decoded.type) return res.status(401).json({ error: 'Invalid or expired token.' });
    const user = await getDb().prepare('SELECT id,name,email,role,active FROM users WHERE id=?').get(decoded.id);
    if (!user || !user.active) return res.status(401).json({ error: 'User not found or disabled.' });
    req.user = user;
    next();
  } catch { res.status(401).json({ error: 'Invalid or expired token.' }); }
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user?.role)) return res.status(403).json({ error: 'Insufficient permissions.' });
    next();
  };
}

// Shorthand for the common case: routes that poweruser shouldn't reach.
// Usage: router.post('/', auth, requireAdmin, handler)
const requireAdmin = requireRole('admin', 'superadmin');
// Stricter still — for things even a regular admin shouldn't touch, like
// API keys/secrets for third-party integrations (payment gateways, etc.)
const requireSuperAdmin = requireRole('superadmin');

module.exports = { auth, requireRole, requireAdmin, requireSuperAdmin };
