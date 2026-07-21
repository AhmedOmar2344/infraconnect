/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Shared Image Validation
 *  File: lib/imageValidation.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Extracted from routes/products.js (SEC-07) so the AI Product Creator's
 *  image-download feature can reuse the exact same magic-byte verification
 *  as manual uploads, instead of a second, potentially-looser copy of the
 *  same security-critical check.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const fs = require('fs');

const ALLOWED_IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.webp', '.gif']);
const ALLOWED_IMAGE_MIME = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

const MIME_TO_EXT = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/gif': '.gif',
};

// SEC-07: confirms bytes actually match a real image format, regardless of
// what MIME type / extension was claimed. Returns true if OK.
function verifyImageMagicBytes(filepath) {
  let fd;
  try {
    fd = fs.openSync(filepath, 'r');
    const buf = Buffer.alloc(12);
    fs.readSync(fd, buf, 0, 12, 0);
    fs.closeSync(fd);
    const isPng  = buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47;
    const isJpg  = buf[0]===0xFF && buf[1]===0xD8 && buf[2]===0xFF;
    const isGif  = buf.toString('ascii',0,4)==='GIF8';
    const isWebp = buf.toString('ascii',0,4)==='RIFF' && buf.toString('ascii',8,12)==='WEBP';
    return isPng || isJpg || isGif || isWebp;
  } catch { if (fd !== undefined) try { fs.closeSync(fd); } catch {} return false; }
}

// Same check directly against an in-memory buffer, for the AI image
// downloader which has the bytes in memory before ever writing to disk.
function verifyImageMagicBytesBuffer(buf) {
  if (!buf || buf.length < 12) return false;
  const isPng  = buf[0]===0x89 && buf[1]===0x50 && buf[2]===0x4E && buf[3]===0x47;
  const isJpg  = buf[0]===0xFF && buf[1]===0xD8 && buf[2]===0xFF;
  const isGif  = buf.toString('ascii',0,4)==='GIF8';
  const isWebp = buf.toString('ascii',0,4)==='RIFF' && buf.toString('ascii',8,12)==='WEBP';
  return isPng || isJpg || isGif || isWebp;
}

module.exports = {
  ALLOWED_IMAGE_EXT, ALLOWED_IMAGE_MIME, MIME_TO_EXT,
  verifyImageMagicBytes, verifyImageMagicBytesBuffer,
};
