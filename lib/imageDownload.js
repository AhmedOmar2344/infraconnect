/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Image-from-URL Download Helper
 *  File: lib/imageDownload.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Downloads an image from an external URL and re-hosts it on Vercel Blob,
 *  instead of just storing the external URL directly. Originally built for
 *  the AI Product Creator (Gemini-suggested image URLs are frequently
 *  unreliable — hotlink protection, stale links, URLs pointing to a product
 *  *page* rather than the image file) and extracted here so the bulk Excel
 *  upload's IMAGE URL / GALLERY URLS columns can reuse the exact same
 *  proven, security-checked pipeline rather than a second, parallel one.
 *
 *  Every check below earns its place from a real failure mode already hit
 *  in this project or a known risk of "download whatever a spreadsheet
 *  column says": timeout (slow/hanging host), content-type validation,
 *  size limits (both claimed and actual), magic-byte verification (a
 *  Content-Type header can be spoofed — this can't), and Jimp instead of
 *  sharp (sharp's native binaries have a history of failing on Vercel's
 *  serverless runtime, the same failure mode that forced this project off
 *  better-sqlite3 originally).
 *
 *  Returns null on any failure rather than throwing — a bad image URL in
 *  one row of a 200-row bulk upload should never abort the other 199.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const { MIME_TO_EXT, ALLOWED_IMAGE_MIME, verifyImageMagicBytesBuffer } = require('./imageValidation');
const { uploadImageBuffer } = require('./blobStorage');
const { trimImageBuffer } = require('./imageTrim');

const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // matches the manual-upload limit in routes/products.js

/**
 * @param {string} url - the image URL to download
 * @param {string} [prefix] - filename prefix, e.g. 'ai' or 'bulk' — purely
 *   for making Blob storage browsable/debuggable, has no functional effect
 * @returns {Promise<string|null>} the public Blob URL, or null on failure
 */
async function downloadImageFromUrl(url, prefix = 'img') {
  if (!url || typeof url !== 'string' || !/^https?:\/\//i.test(url)) return null;
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        // Some retailer/manufacturer sites block requests with no browser-like
        // User-Agent (treating them as bots) — this reduces false rejections.
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
      }
    });
    clearTimeout(timeout);

    if (!response.ok) {
      console.log(`[ImageDownload] Download failed (${response.status}): ${url}`);
      return null;
    }
    const contentType = (response.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!ALLOWED_IMAGE_MIME.has(contentType)) {
      console.log(`[ImageDownload] Rejected — not an image content-type (${contentType}): ${url}`);
      return null;
    }
    const contentLength = parseInt(response.headers.get('content-length') || '0');
    if (contentLength > MAX_IMAGE_BYTES) {
      console.log(`[ImageDownload] Rejected — too large (${contentLength} bytes): ${url}`);
      return null;
    }

    const arrayBuffer = await response.arrayBuffer();
    const buf = Buffer.from(arrayBuffer);
    if (buf.length > MAX_IMAGE_BYTES) {
      console.log(`[ImageDownload] Rejected — exceeded size limit after download: ${url}`);
      return null;
    }
    // Same magic-byte check manual uploads go through (SEC-07) — a
    // Content-Type header can be spoofed/misconfigured, this can't.
    if (!verifyImageMagicBytesBuffer(buf)) {
      console.log(`[ImageDownload] Rejected — content doesn't match a real image format: ${url}`);
      return null;
    }

    const ext = MIME_TO_EXT[contentType] || '.jpg';
    const trimmedBuf = await trimImageBuffer(buf, contentType);
    return await uploadImageBuffer(trimmedBuf, `${prefix}-${Date.now()}${ext}`, contentType);
  } catch (e) {
    console.log(`[ImageDownload] Download error for ${url}:`, e.message);
    return null;
  }
}

/**
 * Downloads multiple gallery images from a comma-separated URL string.
 * Processes in small batches (parallel within a batch, sequential between
 * batches) rather than all at once — bounds how many concurrent outbound
 * requests + Blob uploads a single spreadsheet row can trigger, which
 * matters once a bulk upload has many rows each with multiple gallery URLs.
 * A failed individual image is simply omitted from the result, not treated
 * as an error — a product with 2 of 3 gallery photos is still fine.
 *
 * @param {string} urlsString - comma-separated URLs
 * @param {number} [batchSize=3]
 * @returns {Promise<string[]>} array of Blob URLs (only the successes)
 */
async function downloadGalleryFromUrls(urlsString, batchSize = 3) {
  if (!urlsString || typeof urlsString !== 'string') return [];
  const urls = urlsString.split(',').map(u => u.trim()).filter(Boolean);
  const results = [];
  for (let i = 0; i < urls.length; i += batchSize) {
    const batch = urls.slice(i, i + batchSize);
    const downloaded = await Promise.all(batch.map(u => downloadImageFromUrl(u, 'gallery')));
    results.push(...downloaded.filter(Boolean));
  }
  return results;
}

module.exports = { downloadImageFromUrl, downloadGalleryFromUrls };
