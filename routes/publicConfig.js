/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Public Config Route
 *  File: routes/publicConfig.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  A handful of values from the credentials vault (routes/credentials.js,
 *  superadmin-only) that are actually SAFE and NECESSARY to expose to the
 *  public site — e.g. a Google Maps JavaScript API key. This is not a
 *  security compromise: Maps JS keys are designed to be used client-side,
 *  and are secured by domain restrictions configured in Google Cloud
 *  Console, not by being kept secret. A server-side-only key (Stripe
 *  secret key, etc.) would never belong here.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const { getDb } = require('../db/database');
const { decrypt } = require('../lib/encryption');

router.get('/maps-key', async (req, res, next) => {
  try {
    const db = getDb();
    const cred = await db.prepare(
      "SELECT key_value_encrypted FROM api_credentials WHERE service_name='Google Maps' AND key_label='API Key' AND active=1"
    ).get();
    if (!cred) return res.json({ key: null });
    res.json({ key: decrypt(cred.key_value_encrypted) });
  } catch (err) { next(err); }
});

router.get('/google-client-id', async (req, res, next) => {
  try {
    // Checks the environment variable first, falling back to the API
    // Console vault if it isn't set — either place works.
    if (process.env.GOOGLE_CLIENT_ID) {
      return res.json({ clientId: process.env.GOOGLE_CLIENT_ID });
    }
    const db = getDb();
    const cred = await db.prepare(
      "SELECT key_value_encrypted FROM api_credentials WHERE service_name='Google OAuth' AND key_label='Client ID' AND active=1"
    ).get();
    if (!cred) return res.json({ clientId: null });
    res.json({ clientId: decrypt(cred.key_value_encrypted) });
  } catch (err) { next(err); }
});

module.exports = router;
