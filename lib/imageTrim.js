/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Image Auto-Trim Helper
 *  File: lib/imageTrim.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Fixes a specific visual problem: some product photos (especially
 *  "cutout" PNGs) have transparent or uniform-color padding baked into the
 *  file itself around the actual product. CSS object-fit can't see through
 *  that — it scales the image's full canvas, not its visible content — so
 *  those products look small and lost inside an otherwise-uniform grid of
 *  tightly-cropped photos from other sources.
 *
 *  This trims that padding off server-side, once, at upload/download time,
 *  using Jimp — an image library written entirely in JavaScript with ZERO
 *  native dependencies. That's the deliberate reason it was chosen over the
 *  more common `sharp`: sharp ships native binaries that have a history of
 *  failing to load on Vercel's serverless runtime (the exact failure mode
 *  that originally forced this project off better-sqlite3 and onto
 *  Postgres). Jimp being pure JS means that class of failure isn't possible
 *  here, at some cost in processing speed — an acceptable trade for a
 *  one-time operation on a handful of images per product.
 *
 *  Pinned to an exact version (not a ^range) because Jimp's 1.x line
 *  restructured its API and import style; this integration targets the
 *  well-established 0.22.x callback/promise API deliberately.
 *
 *  This never blocks an upload — any failure (corrupt file, unsupported
 *  edge case, timeout) falls back to the original, untrimmed buffer rather
 *  than failing the request. A missed trim is a cosmetic non-issue; a
 *  blocked upload is not.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const Jimp = require('jimp');

const MIME_TO_JIMP = {
  'image/jpeg': Jimp.MIME_JPEG,
  'image/png': Jimp.MIME_PNG,
  'image/gif': Jimp.MIME_GIF,
  // WEBP has no Jimp write support — those pass through untouched (see below).
};

/**
 * Trims uniform/transparent padding from the edges of an image buffer.
 * @param {Buffer} buffer
 * @param {string} mimeType - e.g. 'image/png'
 * @returns {Promise<Buffer>} the trimmed buffer, or the original on failure
 */
async function trimImageBuffer(buffer, mimeType) {
  // Jimp can't re-encode WEBP — skip trimming rather than fail the upload.
  if (mimeType === 'image/webp') return buffer;
  try {
    const image = await Jimp.read(buffer);
    // cropOnlyFrames:false trims any uniform edge independently (top, right,
    // bottom, left), not just symmetric "frames" — a photo padded on only
    // one or two sides (common with product cutouts) still gets trimmed.
    // tolerance is intentionally generous (real product photos have subtle
    // gradients, shadows, and JPEG compression noise near the edges — a
    // strict tolerance misses all of that and leaves the padding in place).
    image.autocrop({ cropOnlyFrames: false, tolerance: 0.15 });
    const outputMime = MIME_TO_JIMP[mimeType] || Jimp.MIME_PNG;
    return await image.getBufferAsync(outputMime);
  } catch (e) {
    console.log('[ImageTrim] Skipped (using original):', e.message);
    return buffer;
  }
}

module.exports = { trimImageBuffer };
