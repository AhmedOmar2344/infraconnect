/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Credential Encryption Helper
 *  File: lib/encryption.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Used by the API Console (routes/credentials.js) to encrypt third-party
 *  API keys (payment gateways, SMS providers, etc.) before storing them in
 *  Postgres. Without this, anyone with direct database access (a DB
 *  backup, a compromised connection string, etc.) would see every stored
 *  credential in plain text — encrypting at rest means the database alone
 *  isn't enough to read them; CREDENTIALS_ENCRYPTION_KEY is also needed.
 *
 *  Uses Node's built-in `crypto` module (AES-256-GCM) — no dependency,
 *  works identically everywhere Node runs, including Vercel's serverless
 *  functions.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const crypto = require('crypto');

function getKey() {
  const raw = process.env.CREDENTIALS_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      'CREDENTIALS_ENCRYPTION_KEY is not set. Generate one with: ' +
      'node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))" ' +
      'and add it to your environment variables (see .env.example).'
    );
  }
  // Accepts a 64-char hex string (32 bytes) — the format the generation
  // command above produces. Buffer.from(raw, 'hex') does NOT throw on
  // invalid input — it silently stops at the first non-hex character and
  // returns whatever it managed to parse, which is the wrong length. That
  // wrong-length buffer then fails deep inside crypto.createCipheriv with
  // a generic "Invalid key length" error that gives no hint the actual
  // problem is the environment variable's value. Checking explicitly here
  // catches the exact failure mode from a real incident on this project:
  // CREDENTIALS_ENCRYPTION_KEY briefly held a Google Client ID's value
  // (a similar-looking but structurally different string) by mistake.
  if (!/^[0-9a-fA-F]{64}$/.test(raw.trim())) {
    throw new Error(
      'CREDENTIALS_ENCRYPTION_KEY is set but is not a valid 64-character hex string ' +
      '(got ' + raw.trim().length + ' characters). This usually means the wrong value ' +
      'ended up in this environment variable — double-check it in Vercel. Generate a ' +
      'correct one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"'
    );
  }
  return Buffer.from(raw.trim(), 'hex');
}

function encrypt(plaintext) {
  const key = getKey();
  const iv = crypto.randomBytes(12); // 96-bit IV, standard for GCM
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const authTag = cipher.getAuthTag();
  // Store iv + authTag + ciphertext together as one base64 string so
  // there's only one column to manage.
  return Buffer.concat([iv, authTag, encrypted]).toString('base64');
}

function decrypt(stored) {
  const key = getKey();
  const buf = Buffer.from(stored, 'base64');
  const iv = buf.subarray(0, 12);
  const authTag = buf.subarray(12, 28);
  const ciphertext = buf.subarray(28);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
}

// A short, safe-to-display hint (e.g. "••••••••ab12") — shown in the admin
// UI so an admin can recognize which key is which without ever displaying
// the full secret again after it's saved.
function hintFor(plaintext) {
  const last4 = plaintext.slice(-4);
  return '••••••••' + last4;
}

module.exports = { encrypt, decrypt, hintFor };
