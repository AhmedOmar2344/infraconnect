/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Bulk Product Upload Routes
 *  File: routes/bulk.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  WHAT THIS DOES:
 *  Allows admins to upload an Excel (.xlsx) or CSV file to add or update
 *  multiple products at once instead of adding them one by one.
 *
 *  ENDPOINTS:
 *
 *  GET /api/bulk/template
 *    Downloads the Excel template file from public/templates/
 *    The template has 4 sheets: Products, Categories, Instructions, Sample Data
 *
 *  POST /api/bulk/upload
 *    Headers: Authorization: Bearer <token>
 *    Body: FormData with `file` field (the sheet: .xlsx, .xls, .csv) and
 *    an OPTIONAL `photos` field (multiple actual image files, uploaded
 *    directly from the admin's device)
 *    Returns: { message, inserted, updated, skipped, errors, warnings, total }
 *
 *  HOW THE UPLOAD WORKS:
 *  1. File uploaded into memory (not saved to disk)
 *  2. xlsx library parses the spreadsheet
 *  3. First sheet that isn't "Instructions", "Categories" or "Sample Data" is used
 *  4. Each row is validated:
 *     - name is required
 *     - category_slug must match an active category in the database
 *  5. If a product with the same slug already exists → UPDATE it
 *  6. If it's new → INSERT it with a new unique slug
 *  7. All rows processed in a single database transaction (all-or-nothing per row)
 *
 *  EXCEL TEMPLATE COLUMNS:
 *    name | category_slug | brand | description | specs |
 *    price_label | price_amount | currency | badge | image_url | gallery_urls |
 *    featured | stock_status | installments_enabled | installment_months
 *
 *  image_url / gallery_urls (both optional): EITHER a full https URL
 *  (downloaded server-side, validated, and re-hosted on Vercel Blob — see
 *  lib/imageDownload.js) OR just a filename (e.g. "product1.jpg") that
 *  matches, by exact original filename, one of the actual photo files
 *  uploaded alongside the sheet in the `photos` field. gallery_urls stays
 *  comma-separated for multiple entries, and can freely mix URLs and
 *  filenames in the same list. A failed download OR an unmatched filename
 *  never blocks the row from saving, the product just ends up without a
 *  photo and a note in the response's `warnings` array.
 *
 *  REQUIRES: npm install xlsx (already in package.json)
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { getDb } = require('../db/database');
const { auth, requireAdmin } = require('../middleware/auth');
const { downloadImageFromUrl } = require('../lib/imageDownload');
const { ALLOWED_IMAGE_MIME, ALLOWED_IMAGE_EXT, MIME_TO_EXT, verifyImageMagicBytesBuffer } = require('../lib/imageValidation');
const { uploadImageBuffer } = require('../lib/blobStorage');
const { trimImageBuffer } = require('../lib/imageTrim');

// ── multer: memory storage so we can parse in-memory ─────────────────────────
// Accepts both the sheet file (`file`, .xlsx/.xls/.csv) AND, optionally, a
// batch of actual photo files (`photos`) uploaded alongside it — for when
// the admin has real image files on their device rather than URLs. Each
// row's IMAGE URL / GALLERY URLS columns can then reference either a full
// https:// URL (existing behavior, downloaded server-side) OR just a
// filename (e.g. "product1.jpg") that matches one of these uploaded
// photos by exact original filename.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.fieldname === 'photos') {
      // Same validation as the manual single-product photo upload (SEC-07)
      // — real raster-image MIME + extension required, SVG excluded.
      const ext = path.extname(file.originalname).toLowerCase();
      if (ALLOWED_IMAGE_MIME.has(file.mimetype) && ALLOWED_IMAGE_EXT.has(ext)) return cb(null, true);
      return cb(new Error(`"${file.originalname}" is not a valid image file (JPG, PNG, WEBP or GIF only).`));
    }
    const ok = ['.xlsx', '.xls', '.csv'].includes(path.extname(file.originalname).toLowerCase());
    if (ok) cb(null, true); else cb(new Error('Only .xlsx, .xls or .csv files allowed'));
  }
});

function slugify(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

// ── Download template ──────────────────────────────────────────────────────
router.get('/template', auth, requireAdmin, (req, res) => {
  const tplPath = path.join(__dirname, '../public/templates/infraconnect_products_template.xlsx');
  if (fs.existsSync(tplPath)) {
    res.download(tplPath, 'infraconnect_products_template.xlsx');
  } else {
    res.status(404).json({ error: 'Template not found. Please regenerate it.' });
  }
});

/**
 * Parses a sheet buffer (CSV or XLSX) into row objects — extracted into
 * its own function so both /parse-sheet and the row-batch endpoint below
 * can reuse the exact same parsing logic without duplicating it.
 */
function parseSheetBuffer(buffer, originalname) {
  const ext = path.extname(originalname).toLowerCase();
  let rows = [];

  if (ext === '.csv') {
    const text = buffer.toString('utf-8');
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
    if (lines.length < 2) throw new Error('CSV file appears empty.');
    const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim().toLowerCase());
    rows = lines.slice(1).map(line => {
      const vals = line.match(/(".*?"|[^,]+)(?=,|$)/g) || [];
      const obj = {};
      headers.forEach((h, i) => { obj[h] = (vals[i] || '').replace(/^"|"$/g, '').trim(); });
      return obj;
    });
  } else {
    const XLSX = require('xlsx');
    const wb = XLSX.read(buffer, { type: 'buffer' });
    const sheetName = wb.SheetNames.find(n =>
      !['instructions','categories','sample data'].includes(n.toLowerCase())
    ) || wb.SheetNames[0];
    const ws = wb.Sheets[sheetName];
    const raw = XLSX.utils.sheet_to_json(ws, { defval: '' });
    rows = raw.map(r => {
      const obj = {};
      Object.keys(r).forEach(k => {
        // r[k] can genuinely be undefined/null for an empty cell even
        // with defval: '' set above (a known inconsistency in how this
        // library handles CSV-sourced data specifically vs true .xlsx
        // files) — String(undefined) produces the literal TEXT
        // "undefined" (7 real characters, truthy, non-empty), not an
        // empty string.
        const val = (r[k] === undefined || r[k] === null) ? '' : String(r[k]).trim();
        obj[k.toLowerCase().replace(/\s+/g,'_')] = val;
      });
      return obj;
    });
  }

  // Filter out empty/example rows
  return rows.filter(r => r.name && r.name.length > 0 && !r.name.includes('EXAMPLE'));
}

/**
 * POST /api/bulk/parse-sheet
 * Body: multipart form, `file` field (the sheet)
 * Returns: { rows: [...], total: N }
 *
 * Parsing alone is fast even for thousands of rows (no photo processing,
 * no database writes) — this exists so the frontend can get the full row
 * list up front, then drive its own small, real batches through
 * /import-rows-batch below, rather than sending the whole sheet to a
 * single all-in-one endpoint.
 */
router.post('/parse-sheet', auth, requireAdmin, upload.fields([{ name: 'file', maxCount: 1 }]), async (req, res, next) => {
  try {
    const sheetFile = req.files?.file?.[0];
    if (!sheetFile) return res.status(400).json({ error: 'No file uploaded.' });
    let rows;
    try {
      rows = parseSheetBuffer(sheetFile.buffer, sheetFile.originalname);
    } catch (e) {
      return res.status(400).json({ error: 'Failed to parse file: ' + e.message });
    }
    if (rows.length === 0) return res.status(400).json({ error: 'No valid product rows found. Make sure you have data starting from row 7 and the NAME column is filled.' });
    res.json({ rows, total: rows.length });
  } catch (err) { next(err); }
});

/**
 * POST /api/bulk/import-rows-batch
 * Body: multipart form —
 *   `rows`: JSON string, an array of ALREADY-PARSED row objects (a small
 *           batch, not the whole sheet — see the admin panel JS)
 *   `photos`: any actual photo files THIS SPECIFIC BATCH needs (the
 *             frontend figures out which ones by checking each row's
 *             image_url/gallery_urls against the full selected photo set)
 * Returns: { inserted, updated, skipped, errors, warnings }
 *
 * This is what actually creates/updates products — called repeatedly by
 * the frontend, once per small batch, rather than once for the entire
 * sheet. Two real benefits from this: each request stays small enough to
 * never risk Vercel's platform-level function invocation rate limit
 * (distinct from and not fixable by this app's own rate limiter — hitting
 * hundreds of large requests in quick succession can trip it regardless
 * of what this Express app allows), and every batch's inserted/updated
 * products are immediately real, queryable rows — the admin can refresh
 * the product list after each batch and watch it actually grow, not just
 * see a percentage tick up with nothing to show for it until the very end.
 */
router.post('/import-rows-batch', auth, requireAdmin, upload.fields([{ name: 'photos', maxCount: 30 }]), async (req, res, next) => {
  try {
    let rows;
    try { rows = JSON.parse(req.body.rows || '[]'); } catch { return res.status(400).json({ error: 'Malformed rows payload.' }); }
    if (!Array.isArray(rows) || !rows.length) return res.status(400).json({ error: 'No rows in this batch.' });

    // Process only the photos this specific batch actually needs —
    // same validate/trim/upload pipeline as before, just scoped small.
    const photoFiles = req.files?.photos || [];
    const photoMap = {};
    const warnings = [];
    for (const file of photoFiles) {
      try {
        if (!verifyImageMagicBytesBuffer(file.buffer)) {
          warnings.push(`Photo "${file.originalname}" doesn't match a valid image format — skipped.`);
          continue;
        }
        const trimmedBuffer = await trimImageBuffer(file.buffer, file.mimetype);
        const ext = MIME_TO_EXT[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.jpg';
        const suffix = Math.random().toString(36).slice(2, 7);
        const url = await uploadImageBuffer(trimmedBuffer, `bulk-${Date.now()}-${suffix}${ext}`, file.mimetype);
        photoMap[file.originalname] = url;
      } catch (e) {
        warnings.push(`Photo "${file.originalname}" failed to process: ${e.message}`);
      }
    }

    const db = getDb();
    const getCatId = db.prepare('SELECT id FROM categories WHERE slug=? AND active=1');
    const checkSlug = db.prepare('SELECT id FROM products WHERE slug=?');
    const insertProd = db.prepare(`
      INSERT INTO products
        (name,slug,category_id,brand,description,specs,price,price_amount,currency,
         badge,featured,active,stock_status,installments_enabled,installment_months,image,images,
         name_ar,description_ar,specs_ar,badge_ar)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?)
    `);
    const updateProd = db.prepare(`
      UPDATE products SET
        name=?,category_id=?,brand=?,description=?,specs=?,price=?,price_amount=?,
        currency=?,badge=?,featured=?,stock_status=?,installments_enabled=?,
        installment_months=?,image=COALESCE(?,image),images=COALESCE(?,images),
        name_ar=COALESCE(NULLIF(?,''),name_ar),description_ar=COALESCE(NULLIF(?,''),description_ar),
        specs_ar=COALESCE(NULLIF(?,''),specs_ar),badge_ar=COALESCE(NULLIF(?,''),badge_ar),
        updated_at=datetime('now')
      WHERE slug=?
    `);

    const results = { inserted: 0, updated: 0, skipped: 0, errors: [], warnings };

    // Prefetch any library entries this batch's filenames might need, in
    // one query rather than one per row — collects every non-URL
    // image_url/gallery_urls entry across all rows in this batch first.
    const referencedFilenames = new Set();
    for (const row of rows) {
      const iu = (row.image_url || row['image url'] || '').trim();
      if (iu && !/^https?:\/\//i.test(iu)) referencedFilenames.add(iu);
      const gu = (row.gallery_urls || row['gallery urls'] || '').trim();
      if (gu) gu.split(',').map(s => s.trim()).filter(Boolean).forEach(f => { if (!/^https?:\/\//i.test(f)) referencedFilenames.add(f); });
    }
    let libraryMap = {};
    if (referencedFilenames.size) {
      const names = Array.from(referencedFilenames);
      const placeholders = names.map(() => '?').join(',');
      const libRows = await db.prepare(`SELECT filename, blob_url FROM photo_library WHERE filename IN (${placeholders})`).all(...names);
      libRows.forEach(r => { libraryMap[r.filename] = r.blob_url; });
    }

    async function resolveImageEntry(entry) {
      const trimmed = entry.trim();
      if (!trimmed) return null;
      if (/^https?:\/\//i.test(trimmed)) return await downloadImageFromUrl(trimmed, 'bulk');
      // Check this batch's own freshly-uploaded photos first, then fall
      // back to the persistent library — a filename can be resolved
      // either way without the sheet needing to say which.
      return photoMap[trimmed] || libraryMap[trimmed] || null;
    }

    for (const row of rows) {
      try {
        const name = row.name || '';
        if (!name) { results.errors.push('A row with no name was skipped.'); results.skipped++; continue; }

        const catSlug = (row.category_slug || row.category || '').toLowerCase().trim();
        const catRow = catSlug ? await getCatId.get(catSlug) : null;
        const categoryId = catRow ? catRow.id : null;
        if (!categoryId) { results.errors.push(`${name}: unknown category "${catSlug}"`); results.skipped++; continue; }

        let slug = slugify(name);
        const existing = await checkSlug.get(slug);

        const brand = row.brand || '';
        const description = row.description || '';
        const specs = row.specs || '';
        const priceLabel = row.price_label || row.price || 'Price on Request';
        const priceAmount = parseFloat(row.price_amount || row.amount || 0) || 0;
        const currency = ['USD','EGP','AED'].includes((row.currency||'USD').toUpperCase())
          ? (row.currency||'USD').toUpperCase() : 'USD';
        const badge = row.badge || '';
        const featured = ['1','true','yes'].includes(String(row.featured||'').toLowerCase()) ? 1 : 0;
        const stockStatus = ['available','on_order','out_of_stock'].includes(row.stock_status||'')
          ? row.stock_status : 'available';
        const instEnabled = ['1','true','yes'].includes(String(row.installments_enabled||'').toLowerCase()) ? 1 : 0;
        const instMonths = row.installment_months || '';
        const nameAr = row.name_ar || row['name ar'] || row['arabic name'] || '';
        const descriptionAr = row.description_ar || row['description ar'] || row['arabic description'] || '';
        const specsAr = row.specs_ar || row['specs ar'] || row['arabic specs'] || '';
        const badgeAr = row.badge_ar || row['badge ar'] || row['arabic badge'] || '';

        let image = null;
        let images = null;
        let imageUrl = (row.image_url || row['image url'] || '').trim();
        if (imageUrl === 'undefined' || imageUrl === 'null') imageUrl = '';
        const galleryUrls = (row.gallery_urls || row['gallery urls'] || '').trim();

        if (imageUrl) {
          const uploaded = await resolveImageEntry(imageUrl);
          if (uploaded) {
            const galleryEntries = galleryUrls ? galleryUrls.split(',').map(s => s.trim()).filter(Boolean) : [];
            const galleryResolved = [];
            for (const entry of galleryEntries) {
              const g = await resolveImageEntry(entry);
              if (g) galleryResolved.push(g);
            }
            image = uploaded;
            images = JSON.stringify([uploaded, ...galleryResolved]);
          } else {
            const isFilename = !/^https?:\/\//i.test(imageUrl);
            results.warnings.push(
              isFilename
                ? `${name}: no uploaded photo named "${imageUrl}" was found — product saved without a photo`
                : `${name}: image download failed — product saved without a photo`
            );
          }
        }

        if (existing) {
          await updateProd.run(name, categoryId, brand, description, specs, priceLabel, priceAmount,
            currency, badge, featured, stockStatus, instEnabled, instMonths, image, images,
            nameAr, descriptionAr, specsAr, badgeAr, slug);
          results.updated++;
        } else {
          let finalSlug = slug;
          let counter = 1;
          while (await checkSlug.get(finalSlug)) { finalSlug = slug + '-' + counter++; }
          await insertProd.run(name, finalSlug, categoryId, brand, description, specs, priceLabel,
            priceAmount, currency, badge, featured, stockStatus, instEnabled, instMonths, image, images,
            nameAr, descriptionAr, specsAr, badgeAr);
          results.inserted++;
        }
      } catch (e) {
        results.errors.push(`${row.name || 'unnamed'}: ${e.message}`);
        results.skipped++;
      }
    }

    res.json(results);
  } catch (err) { next(err); }
});

/**
 * POST /api/bulk/photo-library/upload
 * Body: multipart form, `photos` field (a batch of files)
 * Returns: { added: N, updated: N, warnings: [...] }
 *
 * Uploads photos into a PERSISTENT library (filename -> Blob URL,
 * upserted by exact filename) rather than a one-time, per-request map.
 * The point: upload each photo file once, ever — every future bulk
 * import that references the same filename finds it automatically via
 * resolveImageEntry() below, with no need to re-select or re-upload the
 * same photo set again for a second or third import of an updated sheet.
 */
router.post('/photo-library/upload', auth, requireAdmin, upload.fields([{ name: 'photos', maxCount: 30 }]), async (req, res, next) => {
  try {
    const photoFiles = req.files?.photos || [];
    const db = getDb();
    const upsert = db.prepare(`
      INSERT INTO photo_library (filename, blob_url) VALUES (?, ?)
      ON CONFLICT (filename) DO UPDATE SET blob_url = EXCLUDED.blob_url
    `);
    let added = 0;
    const warnings = [];
    for (const file of photoFiles) {
      try {
        if (!verifyImageMagicBytesBuffer(file.buffer)) {
          warnings.push(`Photo "${file.originalname}" doesn't match a valid image format — skipped.`);
          continue;
        }
        const trimmedBuffer = await trimImageBuffer(file.buffer, file.mimetype);
        const ext = MIME_TO_EXT[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.jpg';
        const suffix = Math.random().toString(36).slice(2, 7);
        const url = await uploadImageBuffer(trimmedBuffer, `lib-${Date.now()}-${suffix}${ext}`, file.mimetype);
        await upsert.run(file.originalname, url);
        added++;
      } catch (e) {
        warnings.push(`Photo "${file.originalname}" failed to process: ${e.message}`);
      }
    }
    res.json({ added, warnings });
  } catch (err) { next(err); }
});

/**
 * POST /api/bulk/photo-library/check
 * Body: { filenames: [...] }
 * Returns: { existing: [...] } — which of these filenames are ALREADY in
 * the library. Lets the frontend skip re-uploading photos it's already
 * added before, rather than blindly re-sending the whole selected batch
 * every time.
 */
router.post('/photo-library/check', auth, requireAdmin, async (req, res, next) => {
  try {
    const filenames = Array.isArray(req.body.filenames) ? req.body.filenames : [];
    if (!filenames.length) return res.json({ existing: [] });
    const db = getDb();
    const placeholders = filenames.map(() => '?').join(',');
    const rows = await db.prepare(`SELECT filename FROM photo_library WHERE filename IN (${placeholders})`).all(...filenames);
    res.json({ existing: rows.map(r => r.filename) });
  } catch (err) { next(err); }
});

/**
 * GET /api/bulk/photo-library?search=&page=&limit=
 * Returns: { photos: [{id, filename, blob_url, created_at}], total: N }
 * Paginated and searchable (by filename substring) — powers the actual
 * gallery view, not just a count.
 */
router.get('/photo-library', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const search = (req.query.search || '').trim();
    const page = Math.max(1, parseInt(req.query.page) || 1);
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit) || 60));
    const offset = (page - 1) * limit;

    const whereClause = search ? 'WHERE filename LIKE ?' : '';
    const params = search ? [`%${search}%`] : [];

    const photos = await db.prepare(
      `SELECT id, filename, blob_url, created_at FROM photo_library ${whereClause} ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).all(...params, limit, offset);
    const totalRow = await db.prepare(`SELECT COUNT(*) as c FROM photo_library ${whereClause}`).get(...params);

    res.json({ photos, total: Number(totalRow.c) });
  } catch (err) { next(err); }
});

/**
 * DELETE /api/bulk/photo-library/:id
 * Removes a photo from the library's index only — deliberately does NOT
 * delete the underlying Blob file, since existing products may already
 * reference that exact URL as their image. This only stops it from being
 * found/reused for FUTURE imports or library picks, without risking
 * breaking a photo that's actively in use somewhere.
 */
router.delete('/photo-library/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    await db.prepare('DELETE FROM photo_library WHERE id=?').run(req.params.id);
    res.json({ message: 'Removed from library.' });
  } catch (err) { next(err); }
});

module.exports = router;
