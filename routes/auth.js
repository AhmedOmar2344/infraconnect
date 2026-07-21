/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Authentication Routes
 *  File: routes/auth.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  ENDPOINTS:
 *
 *  POST /api/auth/login
 *    Body: { email, password }
 *    Returns: { token, user: { id, name, email, role } }
 *    Use: Admin panel login. Returns JWT token stored in localStorage.
 *
 *  GET /api/auth/me
 *    Headers: Authorization: Bearer <token>
 *    Returns: { user } — current logged-in user info
 *    Use: Used on admin panel load to verify token is still valid.
 *
 *  POST /api/auth/change-password
 *    Headers: Authorization: Bearer <token>
 *    Body: { currentPassword, newPassword }
 *    Use: Admin password change from settings.
 *
 *  HOW JWT AUTH WORKS:
 *  1. User submits email + password to /login
 *  2. Server verifies against bcrypt hash in DB
 *  3. Server returns a signed JWT token (expires in 8 hours by default)
 *  4. Frontend stores token in localStorage as 'ic_admin_token'
 *  5. All protected routes require: Authorization: Bearer <token>
 *  6. middleware/auth.js verifies the token on every protected request
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { getDb } = require('../db/database');
const { auth } = require('../middleware/auth');
const { logActivity } = require('../lib/activityLog');
const { encrypt, decrypt } = require('../lib/encryption');

function issueSessionToken(user) {
  return jwt.sign({ id: user.id, email: user.email, role: user.role }, process.env.JWT_SECRET, { expiresIn: process.env.JWT_EXPIRES_IN || '8h' });
}

router.post('/login', async (req, res, next) => {
  try {
    const { email, password } = req.body;
    if (!email || !password) return res.status(400).json({ error: 'Email and password required.' });
    const db = getDb();
    const user = await db.prepare('SELECT * FROM users WHERE email=? AND active=1').get(email.trim().toLowerCase());
    if (!user || !bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Invalid email or password.' });

    if (user.two_factor_enabled) {
      // Password verified, but not done yet — issue a short-lived,
      // limited-purpose token that only /2fa/verify-login accepts, rather
      // than the real session token. It can't be used on any other
      // endpoint (middleware/auth.js looks up a normal user session, and
      // this token carries a different, deliberately-unusable shape for
      // that check to reject).
      const tempToken = jwt.sign({ id: user.id, purpose: '2fa_pending' }, process.env.JWT_SECRET, { expiresIn: '5m' });
      return res.json({ requires_2fa: true, temp_token: tempToken });
    }

    await db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(user.id);
    const token = issueSessionToken(user);
    req.user = user; // logActivity reads req.user — not set yet at login time since the auth middleware doesn't run on this route
    logActivity(req, 'admin.login', 'admin_user', user.email);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) { next(err); }
});

// ── 2FA: complete login after password + TOTP/backup code ──────────────────
router.post('/2fa/verify-login', async (req, res, next) => {
  try {
    const { temp_token, code } = req.body;
    if (!temp_token || !code) return res.status(400).json({ error: 'Code is required.' });
    let decoded;
    try { decoded = jwt.verify(temp_token, process.env.JWT_SECRET); }
    catch { return res.status(401).json({ error: 'Session expired — please log in again.' }); }
    if (decoded.purpose !== '2fa_pending') return res.status(401).json({ error: 'Invalid session.' });

    const db = getDb();
    const user = await db.prepare('SELECT * FROM users WHERE id=? AND active=1').get(decoded.id);
    if (!user || !user.two_factor_enabled) return res.status(401).json({ error: 'Invalid session.' });

    const { verified, usedBackupCode } = await verifyTotpOrBackupCode(user, code.trim());
    if (!verified) return res.status(401).json({ error: 'Incorrect code. Please try again.' });

    if (usedBackupCode) {
      // Backup codes are single-use — remove the one just used.
      const remaining = JSON.parse(user.two_factor_backup_codes || '[]').filter(c => c !== usedBackupCode);
      await db.prepare('UPDATE users SET two_factor_backup_codes=? WHERE id=?').run(JSON.stringify(remaining), user.id);
    }

    await db.prepare("UPDATE users SET last_login=datetime('now') WHERE id=?").run(user.id);
    const token = issueSessionToken(user);
    req.user = user;
    logActivity(req, 'admin.login', 'admin_user', user.email, usedBackupCode ? { via: 'backup_code' } : undefined);
    res.json({ token, user: { id: user.id, name: user.name, email: user.email, role: user.role } });
  } catch (err) { next(err); }
});

// Checks a submitted code against the user's TOTP secret first, then
// falls back to their backup codes (stored as plain strings — these are
// single-use, short, and already require the user's password to reach
// this check at all, so hashing adds complexity without much real benefit
// here, unlike the account password itself).
async function verifyTotpOrBackupCode(user, code) {
  if (user.two_factor_secret) {
    try {
      const { TOTP, Secret } = require('otpauth');
      const totp = new TOTP({ secret: Secret.fromBase32(decrypt(user.two_factor_secret)), digits: 6, period: 30 });
      if (totp.validate({ token: code, window: 1 }) !== null) return { verified: true, usedBackupCode: null };
    } catch (e) { console.error('[2FA] TOTP validation error:', e.message); }
  }
  const backupCodes = JSON.parse(user.two_factor_backup_codes || '[]');
  if (backupCodes.includes(code.toUpperCase())) return { verified: true, usedBackupCode: code.toUpperCase() };
  return { verified: false, usedBackupCode: null };
}

router.get('/me', auth, (req, res) => res.json({ user: req.user }));

router.post('/change-password', auth, async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body;
    if (!currentPassword || !newPassword || newPassword.length < 8) return res.status(400).json({ error: 'New password must be at least 8 characters.' });
    const db = getDb();
    const user = await db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id);
    if (!bcrypt.compareSync(currentPassword, user.password)) return res.status(401).json({ error: 'Current password incorrect.' });
    await db.prepare('UPDATE users SET password=? WHERE id=?').run(bcrypt.hashSync(newPassword, 12), req.user.id);
    res.json({ message: 'Password updated.' });
  } catch (err) { next(err); }
});

// ── 2FA: setup (generates a secret + QR code, not yet enabled) ─────────────
router.post('/2fa/setup', auth, async (req, res, next) => {
  try {
    const { Secret, TOTP } = require('otpauth');
    const QRCode = require('qrcode');
    const secret = new Secret({ size: 20 });
    const totp = new TOTP({ issuer: 'InfraConnect', label: req.user.email, secret, digits: 6, period: 30 });
    const qrDataUrl = await QRCode.toDataURL(totp.toString());
    // Not saved to the DB yet — only committed once /2fa/confirm verifies
    // the admin actually scanned it correctly, so a setup attempt that's
    // abandoned midway never leaves a half-configured, unusable 2FA state.
    const pendingToken = jwt.sign({ id: req.user.id, purpose: '2fa_setup', secret: secret.base32 }, process.env.JWT_SECRET, { expiresIn: '10m' });
    res.json({ qr_code: qrDataUrl, manual_key: secret.base32, pending_token: pendingToken });
  } catch (err) { next(err); }
});

router.post('/2fa/confirm', auth, async (req, res, next) => {
  try {
    const { pending_token, code } = req.body;
    if (!pending_token || !code) return res.status(400).json({ error: 'Code is required.' });
    let decoded;
    try { decoded = jwt.verify(pending_token, process.env.JWT_SECRET); }
    catch { return res.status(400).json({ error: 'Setup session expired — please start again.' }); }
    if (decoded.purpose !== '2fa_setup' || decoded.id !== req.user.id) return res.status(400).json({ error: 'Invalid setup session.' });

    const { TOTP, Secret } = require('otpauth');
    const totp = new TOTP({ secret: Secret.fromBase32(decoded.secret), digits: 6, period: 30 });
    if (totp.validate({ token: code.trim(), window: 1 }) === null) {
      return res.status(400).json({ error: 'Incorrect code — check your authenticator app and try again.' });
    }

    // Generate 8 backup codes (used once each if the device is lost).
    const crypto = require('crypto');
    const backupCodes = Array.from({ length: 8 }, () => crypto.randomBytes(4).toString('hex').toUpperCase());

    const db = getDb();
    await db.prepare('UPDATE users SET two_factor_secret=?, two_factor_enabled=1, two_factor_backup_codes=? WHERE id=?')
      .run(encrypt(decoded.secret), JSON.stringify(backupCodes), req.user.id);
    logActivity(req, 'admin.2fa_enabled', 'admin_user', req.user.email);
    res.json({ message: '2FA enabled.', backup_codes: backupCodes });
  } catch (err) { next(err); }
});

router.post('/2fa/disable', auth, async (req, res, next) => {
  try {
    const { password } = req.body;
    if (!password) return res.status(400).json({ error: 'Confirm your password to disable 2FA.' });
    const db = getDb();
    const user = await db.prepare('SELECT password FROM users WHERE id=?').get(req.user.id);
    if (!bcrypt.compareSync(password, user.password)) return res.status(401).json({ error: 'Incorrect password.' });
    await db.prepare('UPDATE users SET two_factor_secret=NULL, two_factor_enabled=0, two_factor_backup_codes=NULL WHERE id=?').run(req.user.id);
    logActivity(req, 'admin.2fa_disabled', 'admin_user', req.user.email);
    res.json({ message: '2FA disabled.' });
  } catch (err) { next(err); }
});

module.exports = router;
