/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — API Console / Credentials Vault
 *  File: routes/credentials.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  A place to store third-party API keys (payment gateways, SMS, maps,
 *  etc.) so future integrations can pull a saved credential from here
 *  instead of needing a new Vercel environment variable + redeploy every
 *  time. Values are encrypted at rest (see lib/encryption.js) and never
 *  displayed again after saving — only a short hint like "••••••••ab12",
 *  the same pattern Stripe/AWS/most real API consoles use.
 *
 *  ADMIN (auth + admin/superadmin required — these are sensitive):
 *    GET    /api/credentials          List all (masked — no real values)
 *    POST   /api/credentials          Add a new credential
 *    PUT    /api/credentials/:id      Replace a credential's value/notes/status
 *    DELETE /api/credentials/:id      Delete
 *
 *  INTERNAL (for other backend code to actually use a saved credential):
 *    getCredentialValue(serviceName, keyLabel) — returns the decrypted
 *    value, or null if not found/inactive. This is what a future payment
 *    integration (etc.) would call instead of process.env.STRIPE_KEY.
 */
const router = require('express').Router();
const { getDb } = require('../db/database');
const { auth, requireSuperAdmin } = require('../middleware/auth');
const { encrypt, decrypt, hintFor } = require('../lib/encryption');
const { logActivity } = require('../lib/activityLog');

async function getCredentialValue(serviceName, keyLabel) {
  const db = getDb();
  const row = await db.prepare(
    'SELECT key_value_encrypted FROM api_credentials WHERE service_name=? AND key_label=? AND active=1'
  ).get(serviceName, keyLabel);
  if (!row) return null;
  try { return decrypt(row.key_value_encrypted); }
  catch (e) { console.error('[Credentials] Decrypt failed for', serviceName, keyLabel, ':', e.message); return null; }
}

router.get('/', auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const rows = await getDb().prepare(
      'SELECT id, service_name, key_label, key_hint, notes, active, created_at, updated_at FROM api_credentials ORDER BY service_name, key_label'
    ).all();
    res.json({ credentials: rows });
  } catch (err) { next(err); }
});

router.post('/', auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const { service_name, key_label, key_value, notes } = req.body;
    if (!service_name?.trim() || !key_label?.trim() || !key_value?.trim()) {
      return res.status(400).json({ error: 'Service name, key label, and value are all required.' });
    }
    const db = getDb();
    let encrypted;
    try { encrypted = encrypt(key_value.trim()); }
    catch (e) { return res.status(500).json({ error: e.message }); }
    const result = await db.prepare(
      'INSERT INTO api_credentials(service_name,key_label,key_value_encrypted,key_hint,notes) VALUES(?,?,?,?,?)'
    ).run(service_name.trim(), key_label.trim(), encrypted, hintFor(key_value.trim()), notes || '');
    const saved = await db.prepare(
      'SELECT id, service_name, key_label, key_hint, notes, active, created_at FROM api_credentials WHERE id=?'
    ).get(result.lastInsertRowid);
    logActivity(req, 'credential.create', 'credential', `${service_name.trim()} / ${key_label.trim()}`);
    res.status(201).json({ credential: saved });
  } catch (err) { next(err); }
});

router.put('/:id', auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT * FROM api_credentials WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Not found.' });
    const { service_name, key_label, key_value, notes, active } = req.body;

    let encryptedValue = existing.key_value_encrypted;
    let hint = existing.key_hint;
    // Only re-encrypt if a new value was actually provided — otherwise the
    // admin is just renaming/toggling status without meaning to change the
    // secret itself.
    if (key_value && key_value.trim()) {
      try { encryptedValue = encrypt(key_value.trim()); }
      catch (e) { return res.status(500).json({ error: e.message }); }
      hint = hintFor(key_value.trim());
    }

    await db.prepare(
      `UPDATE api_credentials SET service_name=?, key_label=?, key_value_encrypted=?, key_hint=?, notes=?, active=?, updated_at=datetime('now') WHERE id=?`
    ).run(
      service_name?.trim() || existing.service_name,
      key_label?.trim() || existing.key_label,
      encryptedValue, hint,
      notes !== undefined ? notes : existing.notes,
      active !== undefined ? (active ? 1 : 0) : existing.active,
      req.params.id
    );
    const updated = await db.prepare(
      'SELECT id, service_name, key_label, key_hint, notes, active, updated_at FROM api_credentials WHERE id=?'
    ).get(req.params.id);
    logActivity(req, 'credential.update', 'credential', `${updated.service_name} / ${updated.key_label}`, { value_changed: !!(key_value && key_value.trim()) });
    res.json({ credential: updated });
  } catch (err) { next(err); }
});

router.delete('/:id', auth, requireSuperAdmin, async (req, res, next) => {
  try {
    const existing = await getDb().prepare('SELECT service_name, key_label FROM api_credentials WHERE id=?').get(req.params.id);
    await getDb().prepare('DELETE FROM api_credentials WHERE id=?').run(req.params.id);
    if (existing) logActivity(req, 'credential.delete', 'credential', `${existing.service_name} / ${existing.key_label}`);
    res.json({ message: 'Deleted.' });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.getCredentialValue = getCredentialValue;
