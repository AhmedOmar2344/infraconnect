/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Blob Storage Helper
 *  File: lib/blobStorage.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Vercel's deployed filesystem is READ-ONLY at runtime (the same
 *  constraint that originally forced the database off SQLite and onto
 *  Postgres) — only /tmp is writable, and it's ephemeral. Writing an
 *  uploaded image to ./public/images/products/ throws EROFS in production;
 *  it can only ever have worked in local development, never on the live
 *  site. This is the equivalent fix for images: upload the bytes to Vercel
 *  Blob instead of the local disk, and store the public Blob URL in the
 *  database instead of a local path.
 *
 *  SETUP: connect a Blob store via Vercel → your project → Storage → Create
 *  → Blob. This auto-injects BLOB_READ_WRITE_TOKEN into your environment
 *  variables (same pattern as the Neon Postgres integration) — no manual
 *  token copying needed on Vercel. For local development, run
 *  `vercel env pull .env.development.local` (or copy the token manually
 *  from Vercel's dashboard into your .env) so uploads work locally too.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const { put, del } = require('@vercel/blob');

/**
 * Uploads a buffer to Vercel Blob and returns its public URL.
 * @param {Buffer} buffer - the file's raw bytes
 * @param {string} filename - desired filename (a random suffix is added
 *   automatically by Vercel Blob to prevent collisions, so this doesn't
 *   need to be globally unique on its own)
 * @param {string} contentType - e.g. 'image/jpeg'
 * @returns {Promise<string>} the public URL, or throws on failure
 */
async function uploadImageBuffer(buffer, filename, contentType) {
  // Not pre-checking for BLOB_READ_WRITE_TOKEN specifically here — when a
  // Blob store is connected via Vercel's dashboard, the SDK can also
  // authenticate through an auto-rotating OIDC token instead (no static
  // token needed at all in that case). Let put() attempt its own
  // credential resolution and only surface an error if that actually fails.
  try {
    const blob = await put(`products/${filename}`, buffer, {
      access: 'public',
      contentType,
      addRandomSuffix: true,
    });
    return blob.url;
  } catch (e) {
    throw new Error(
      `Blob upload failed: ${e.message}. If this is happening on Vercel, connect a Blob store ` +
      `at Storage → Create → Blob. Locally, run \`vercel env pull .env.development.local\` or set ` +
      `BLOB_READ_WRITE_TOKEN in your .env manually.`
    );
  }
}

/**
 * Deletes a blob given its full public URL. Safe to call on a URL that
 * isn't actually a Blob URL (e.g. a leftover external image_url from
 * before this migration) — errors are caught and ignored, since a failed
 * cleanup delete should never break the calling request.
 */
async function deleteImageByUrl(url) {
  if (!url || !url.includes('.blob.vercel-storage.com/')) return;
  try { await del(url); } catch (e) { console.log('[BlobStorage] Delete failed (non-fatal):', e.message); }
}

module.exports = { uploadImageBuffer, deleteImageByUrl };
