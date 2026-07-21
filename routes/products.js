/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Products & Categories Routes
 *  File: routes/products.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  PUBLIC ENDPOINTS (no auth required — used by the storefront):
 *
 *  GET /api/products
 *    Query: ?category=<slug> &featured=1 &search=<text> &limit=100 &page=1
 *    Returns: { products: [...], total }
 *    Use: Store page product listing. Supports filtering, search, pagination.
 *
 *  GET /api/products/categories
 *    Returns: { categories: [...] } — all active categories with product counts
 *    Use: Store sidebar filter, homepage category grid.
 *
 *  GET /api/products/:slug
 *    Returns: { product, related: [...] }
 *    Use: Single product detail page.
 *
 *  ADMIN ENDPOINTS (require JWT auth token):
 *
 *  POST /api/products
 *    Body: FormData with all product fields + optional image file
 *    Returns: { product } — newly created product
 *
 *  PUT /api/products/:id
 *    Body: FormData with fields to update + optional new image
 *    Returns: { product } — updated product
 *
 *  DELETE /api/products/:id
 *    Soft-deletes product (sets active=0, not removed from DB)
 *
 *  GET /api/products/admin/categories
 *    Returns all categories including inactive ones (admin view)
 *
 *  POST /api/products/admin/categories
 *    Body: { name, description, icon }
 *    Creates a new product category.
 *
 *  PUT /api/products/admin/categories/:id
 *    Body: { name, description, icon, active }
 *    Updates a category.
 *
 *  IMAGE UPLOAD:
 *  - Uses multer memory storage + Vercel Blob (public/images/products/ on
 *    local disk would throw EROFS on Vercel — the deployed filesystem is
 *    read-only at runtime). See lib/blobStorage.js.
 *  - Max size: 5MB. Accepted: jpg, png, webp, gif
 *  - If image_url is provided instead, saves that URL directly (AI image search)
 *
 *  INSTALLMENTS:
 *  - installments_enabled: 0 or 1
 *  - installment_months: "all" or "6,12" or "6,12,18,24"
 *  - Monthly payment = (price_amount × (1 + VAT_rate)) / months
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const multer = require('multer');
const path = require('path');
const { getDb } = require('../db/database');
const { auth, requireAdmin } = require('../middleware/auth');
const { ALLOWED_IMAGE_EXT, ALLOWED_IMAGE_MIME, MIME_TO_EXT, verifyImageMagicBytesBuffer } = require('../lib/imageValidation');
const { uploadImageBuffer, deleteImageByUrl } = require('../lib/blobStorage');
const { trimImageBuffer } = require('../lib/imageTrim');
const { logActivity } = require('../lib/activityLog');

const MAX_PHOTOS_PER_PRODUCT = 8;

// Memory storage, not disk storage — Vercel's deployed filesystem is
// read-only at runtime (EROFS on any write), so files are kept as buffers
// in memory and uploaded to Vercel Blob instead of ever touching local
// disk. See lib/blobStorage.js for the full explanation.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5*1024*1024 },
  fileFilter: (req, file, cb) => {
    // SEC-07: `image/*` alone can be spoofed (e.g. image/svg+xml carrying
    // embedded JS). Require a real raster-image MIME type AND extension —
    // SVG is explicitly excluded. Content is still verified after upload
    // via verifyImageMagicBytesBuffer() since MIME/extension can be forged too.
    const ext = path.extname(file.originalname).toLowerCase();
    if (ALLOWED_IMAGE_MIME.has(file.mimetype) && ALLOWED_IMAGE_EXT.has(ext)) cb(null, true);
    else cb(new Error('Only JPG, PNG, WEBP or GIF images are allowed.'));
  }
});

// Accepts both field names: `image` (singular — the AI Product Creator and
// any other single-photo caller still uses this) and `images` (plural —
// the multi-photo gallery upload in the manual product form). Every file
// from either field is verified and uploaded to Blob the same way; the
// route handlers below combine them into one ordered gallery, with the
// first photo treated as the product's cover image everywhere else in the
// app (store cards, cart, homepage) still only shows one image.
function uploadProductImage(req, res, next) {
  upload.fields([{ name: 'image', maxCount: 1 }, { name: 'images', maxCount: MAX_PHOTOS_PER_PRODUCT }])(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message || 'Upload failed.' });
    const allFiles = [...(req.files?.image || []), ...(req.files?.images || [])];
    if (!allFiles.length) return next();
    for (const file of allFiles) {
      if (!verifyImageMagicBytesBuffer(file.buffer)) {
        return res.status(400).json({ error: `"${file.originalname}" does not match a valid image format.` });
      }
    }
    try {
      req.uploadedImageUrls = [];
      for (const file of allFiles) {
        const trimmedBuffer = await trimImageBuffer(file.buffer, file.mimetype);
        const ext = MIME_TO_EXT[file.mimetype] || path.extname(file.originalname).toLowerCase() || '.jpg';
        const suffix = Math.random().toString(36).slice(2, 7);
        const url = await uploadImageBuffer(trimmedBuffer, `prod-${Date.now()}-${suffix}${ext}`, file.mimetype);
        req.uploadedImageUrls.push(url);
      }
      next();
    } catch (e) {
      console.error('[Products] Blob upload failed:', e.message);
      return res.status(500).json({ error: 'Image upload failed: ' + e.message });
    }
  });
}

function slugify(s){ return s.toLowerCase().replace(/[^a-z0-9]+/g,'-').replace(/(^-|-$)/g,''); }

// PUBLIC
router.get('/', async (req, res, next) => {
  try {
    const db = getDb();
    const { category, featured, search, limit=100, page=1, sort } = req.query;
    let sql = `SELECT p.*, c.name as category_name, c.name_ar as category_name_ar, c.slug as category_slug FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.active=1`;
    const params = [];
    if (category) { sql+=' AND c.slug=?'; params.push(category); }
    if (featured==='1') { sql+=' AND p.featured=1'; }
    // Matches the same field breadth the old client-side search covered
    // (name, Arabic name, brand, description, Arabic description,
    // category name, Arabic category name) — narrowing this to fewer
    // fields when this became a server-side search would have been a
    // silent regression in what people can actually find.
    const SEARCH_CLAUSE = ' AND (p.name LIKE ? OR p.name_ar LIKE ? OR p.description LIKE ? OR p.description_ar LIKE ? OR p.brand LIKE ? OR c.name LIKE ? OR c.name_ar LIKE ?)';
    if (search) { sql+=SEARCH_CLAUSE; const s=`%${search}%`; params.push(s,s,s,s,s,s,s); }
    // Sorting happens here, server-side, against the FULL matching set —
    // sorting only the current page client-side (the previous approach)
    // meant "Price: High to Low" only ever reordered whatever page had
    // already loaded, which usually wasn't anywhere near the genuinely
    // most expensive items in the whole catalog.
    const SORT_MAP = {
      'price-asc': 'p.price_amount ASC',
      'price-desc': 'p.price_amount DESC',
      'name': 'p.name ASC',
      'featured': 'p.featured DESC, p.created_at DESC',
    };
    const orderBy = SORT_MAP[sort] || SORT_MAP.featured;
    sql+=` ORDER BY ${orderBy} LIMIT ? OFFSET ?`;
    params.push(parseInt(limit),(parseInt(page)-1)*parseInt(limit));
    const rows = await db.prepare(sql).all(...params);
    const products = rows.map(p=>({...p, specs: p.specs?p.specs.split('|'):[], specs_ar: p.specs_ar?p.specs_ar.split('|'):[]}));
    const searchParams = search ? [`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`,`%${search}%`] : [];
    const totalRow = await db.prepare(`SELECT COUNT(*) as c FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.active=1${category?' AND c.slug=?':''}${search?SEARCH_CLAUSE:''}`).get(...(category?[category]:[]),...searchParams);
    res.json({ products, total: Number(totalRow.c) });
  } catch (err) { next(err); }
});

router.get('/categories', async (req, res, next) => {
  try {
    const db = getDb();
    const cats = await db.prepare('SELECT c.*, COUNT(p.id) as product_count FROM categories c LEFT JOIN products p ON c.id=p.category_id AND p.active=1 WHERE c.active=1 GROUP BY c.id ORDER BY c.sort_order').all();
    res.json({ categories: cats.map(c => ({ ...c, product_count: Number(c.product_count) })) });
  } catch (err) { next(err); }
});

/**
 * GET /api/products/export
 * Downloads all products (including inactive/soft-deleted ones, for a
 * complete admin record) as an .xlsx file. Placed BEFORE /:slug below —
 * Express matches routes in definition order, and /:slug would otherwise
 * swallow a request to /export by treating "export" as the :slug value.
 * Admin-only, unlike the public GET / above — this exposes stock levels,
 * cost-relevant data, and inactive listings not meant for public viewing.
 */
router.get('/export', auth, requireAdmin, async (req, res, next) => {
  try {
    const XLSX = require('xlsx');
    const db = getDb();
    const rows = await db.prepare(`
      SELECT p.*, c.name as category_name FROM products p
      LEFT JOIN categories c ON p.category_id=c.id
      ORDER BY p.name
    `).all();

    const exportRows = rows.map(p => ({
      'Name': p.name,
      'Category': p.category_name || '',
      'Brand': p.brand || '',
      'Condition': p.condition || 'new',
      'Price': p.price,
      'Price Amount': p.price_amount,
      'Currency': p.currency,
      'Stock Quantity': p.stock_quantity ?? '',
      'Stock Status': p.stock_status,
      'Featured': p.featured ? 'Yes' : 'No',
      'Active': p.active ? 'Yes' : 'No',
      'Created': p.created_at,
    }));

    const ws = XLSX.utils.json_to_sheet(exportRows);
    ws['!cols'] = [{ wch: 32 }, { wch: 18 }, { wch: 14 }, { wch: 10 }, { wch: 14 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 14 }, { wch: 10 }, { wch: 8 }, { wch: 18 }];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Products');
    const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

    res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    res.setHeader('Content-Disposition', `attachment; filename="infraconnect-products-${new Date().toISOString().slice(0,10)}.xlsx"`);
    res.send(buffer);
  } catch (err) { next(err); }
});

router.get('/:slug', async (req, res, next) => {
  try {
    const db = getDb();
    const p = await db.prepare('SELECT p.*, c.name as category_name, c.name_ar as category_name_ar, c.slug as category_slug FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.slug=? AND p.active=1').get(req.params.slug);
    if (!p) return res.status(404).json({ error: 'Product not found.' });
    p.specs = p.specs ? p.specs.split('|') : [];
    p.specs_ar = p.specs_ar ? p.specs_ar.split('|') : [];
    try { p.images = p.images ? JSON.parse(p.images) : (p.image ? [p.image] : []); } catch { p.images = p.image ? [p.image] : []; }
    const relatedRows = await db.prepare('SELECT p.*, c.name as category_name, c.name_ar as category_name_ar, c.slug as category_slug FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.category_id=? AND p.slug!=? AND p.active=1 LIMIT 4').all(p.category_id, p.slug);
    const related = relatedRows.map(r=>({...r,specs:r.specs?r.specs.split('|'):[],specs_ar:r.specs_ar?r.specs_ar.split('|'):[]}));
    res.json({ product: p, related });
  } catch (err) { next(err); }
});

// ADMIN
// Reconciles stock_status with stock_quantity so the two can't end up
// contradicting each other — e.g. an admin raising quantity from 0 back up
// to 15 but stock_status silently staying "Out of Stock" because nothing
// told it to change. This is what makes the tracking actually "dynamic":
//  - quantity not tracked (NULL) → status is fully manual, unchanged
//  - quantity <= 0 → always "out_of_stock", no exceptions
//  - quantity > 0 but submitted status says "out_of_stock" → that's the
//    exact contradiction that caused the bug, so it's corrected to
//    "available" here rather than trusted as-is
//  - anything else (available / on_order with positive quantity) → respected
function resolveStockStatus(stockQty, submittedStatus) {
  if (stockQty === null || stockQty === undefined) return submittedStatus || 'available';
  if (stockQty <= 0) return 'out_of_stock';
  if (submittedStatus === 'out_of_stock') return 'available';
  return submittedStatus || 'available';
}

router.post('/', auth, requireAdmin, uploadProductImage, async (req, res, next) => {
  try {
    const { name, category_id, brand, description, specs, price, price_amount, currency, badge, featured, name_ar, description_ar, specs_ar, badge_ar, condition, stock_quantity, stock_status } = req.body;
    if (!name || !category_id) return res.status(400).json({ error: 'Name and category required.' });
    const db = getDb();
    let slug = slugify(name);
    const existing = await db.prepare('SELECT id FROM products WHERE slug=?').get(slug);
    if (existing) slug = slug + '-' + Date.now();
    // Gallery: newly uploaded files (any order) become the full photo set.
    // `image_url` is the AI Product Creator's fallback path when it
    // couldn't auto-download a photo — treated as a single-photo gallery.
    const uploadedUrls = req.uploadedImageUrls || [];
    const images = uploadedUrls.length ? uploadedUrls : (req.body.image_url ? [req.body.image_url] : []);
    const image = images[0] || null; // cover photo — what store cards/cart/homepage show
    const specsStr = Array.isArray(specs) ? specs.join('|') : (specs||'');
    const specsArStr = Array.isArray(specs_ar) ? specs_ar.join('|') : (specs_ar||'');
    const amt = parseFloat(price_amount) || 0;
    const cur = currency || 'USD';
    const inst_enabled = req.body.installments_enabled === '1' ? 1 : 0;
    const inst_months  = req.body.installment_months || '';
    const cond = condition === 'used' ? 'used' : 'new';
    // Empty string / undefined means "not tracked" — stored as NULL, distinct
    // from 0 (tracked and currently out). stock_status still defaults to
    // 'available' unless explicitly set (e.g. by the admin, or automatically
    // once an order drops a tracked quantity to 0 — see routes/orders.js).
    const stockQty = (stock_quantity !== undefined && stock_quantity !== '') ? parseInt(stock_quantity) : null;
    const stockStatus = resolveStockStatus(stockQty, stock_status);
    // uploadedUrls (not the image_url fallback) went through trimImageBuffer
    // in uploadProductImage above — this flag is what the batch
    // re-processing tool uses to skip images that don't need it.
    const imagesTrimmed = uploadedUrls.length > 0 ? 1 : 0;
    const result = await db.prepare('INSERT INTO products(name,slug,category_id,brand,description,specs,name_ar,description_ar,specs_ar,badge_ar,price,price_amount,currency,badge,image,images,images_trimmed,featured,installments_enabled,installment_months,condition,stock_quantity,stock_status) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(name,slug,category_id,brand||'',description||'',specsStr,name_ar||'',description_ar||'',specsArStr,badge_ar||'',price||'Price on Request',amt,cur,badge||'',image,JSON.stringify(images),imagesTrimmed,featured==='1'?1:0,inst_enabled,inst_months,cond,stockQty,stockStatus);
    const product = await db.prepare('SELECT p.*,c.name as category_name, c.name_ar as category_name_ar FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.id=?').get(result.lastInsertRowid);
    product.images = images;
    logActivity(req, 'product.create', 'product', product.name);
    res.status(201).json({ message:'Product created.', product });
  } catch (err) { next(err); }
});

router.put('/:id', auth, requireAdmin, uploadProductImage, async (req, res, next) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT * FROM products WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: 'Product not found.' });
    const { name, category_id, brand, description, specs, price, price_amount, currency, badge, featured, active, stock_status, name_ar, description_ar, specs_ar, badge_ar, condition, stock_quantity } = req.body;

    // Gallery: the admin form sends `existing_images` as a JSON array of
    // the URLs it wants to KEEP from the current set (the rest were
    // removed via the ✕ button in the UI), plus any newly uploaded files.
    // Anything present in the OLD gallery but absent from the final one is
    // deleted from Blob storage below, so removed photos don't just sit
    // there unused forever.
    let oldImages = [];
    try { oldImages = existing.images ? JSON.parse(existing.images) : (existing.image ? [existing.image] : []); } catch { oldImages = existing.image ? [existing.image] : []; }
    let keptImages = oldImages;
    if (req.body.existing_images !== undefined) {
      try { keptImages = JSON.parse(req.body.existing_images); if (!Array.isArray(keptImages)) keptImages = oldImages; } catch { keptImages = oldImages; }
    }
    const newlyUploaded = req.uploadedImageUrls || [];
    const images = [...keptImages, ...newlyUploaded].slice(0, 8); // cap matches MAX_PHOTOS_PER_PRODUCT
    const image = images[0] || (req.body.image_url || null);

    const removedImages = oldImages.filter(url => !images.includes(url));
    removedImages.forEach(url => deleteImageByUrl(url).catch(() => {}));

    const specsStr = Array.isArray(specs) ? specs.join('|') : (specs !== undefined ? specs : existing.specs);
    const specsArStr = Array.isArray(specs_ar) ? specs_ar.join('|') : (specs_ar !== undefined ? specs_ar : existing.specs_ar);
    const amt = price_amount !== undefined ? parseFloat(price_amount) || 0 : existing.price_amount;
    const cur = currency || existing.currency || 'USD';
    const inst_enabled = req.body.installments_enabled !== undefined ? (req.body.installments_enabled === '1' ? 1 : 0) : existing.installments_enabled;
    const inst_months  = req.body.installment_months !== undefined ? req.body.installment_months : existing.installment_months;
    const cond = condition !== undefined ? (condition === 'used' ? 'used' : 'new') : existing.condition;
    const stockQty = (stock_quantity !== undefined) ? (stock_quantity === '' ? null : parseInt(stock_quantity)) : existing.stock_quantity;
    const stockStatus = resolveStockStatus(stockQty, stock_status || existing.stock_status);
    const imagesTrimmed = newlyUploaded.length > 0 ? 1 : existing.images_trimmed;
    await db.prepare(`UPDATE products SET name=?,category_id=?,brand=?,description=?,specs=?,name_ar=?,description_ar=?,specs_ar=?,badge_ar=?,price=?,price_amount=?,currency=?,badge=?,image=?,images=?,images_trimmed=?,featured=?,active=?,stock_status=?,installments_enabled=?,installment_months=?,condition=?,stock_quantity=?,updated_at=datetime('now') WHERE id=?`).run(
      name||existing.name, category_id||existing.category_id, brand??existing.brand,
      description??existing.description, specsStr,
      name_ar??existing.name_ar, description_ar??existing.description_ar, specsArStr, badge_ar??existing.badge_ar,
      price||existing.price, amt, cur, badge??existing.badge,
      image, JSON.stringify(images), imagesTrimmed, featured!==undefined?(featured==='1'?1:0):existing.featured,
      active!==undefined?(active==='1'?1:0):existing.active,
      stockStatus, inst_enabled, inst_months, cond, stockQty, req.params.id
    );
    const updated = await db.prepare('SELECT p.*,c.name as category_name, c.name_ar as category_name_ar FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.id=?').get(req.params.id);
    updated.specs = updated.specs ? updated.specs.split('|') : [];
    updated.specs_ar = updated.specs_ar ? updated.specs_ar.split('|') : [];
    updated.images = images;
    logActivity(req, 'product.update', 'product', updated.name);
    res.json({ message:'Product updated.', product: updated });
  } catch (err) { next(err); }
});

router.delete('/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const existing = await db.prepare('SELECT id, name FROM products WHERE id=?').get(req.params.id);
    if (!existing) return res.status(404).json({ error:'Not found.' });
    await db.prepare("UPDATE products SET active=0, updated_at=datetime('now') WHERE id=?").run(req.params.id);
    logActivity(req, 'product.delete', 'product', existing.name);
    res.json({ message:'Product deleted.' });
  } catch (err) { next(err); }
});

/**
 * POST /api/products/bulk-delete
 * Body: { ids: [1, 2, 3, ...] }
 * Same soft-delete as the single endpoint above (active=0, not a real
 * row deletion), just applied to many products from one admin action —
 * built for the admin panel's multi-select checkboxes.
 */
/**
 * POST /api/products/remove-all-badges
 * Clears the badge field on every active product — a single, cheap SQL
 * update regardless of catalog size (not AI-driven work, so no batching
 * needed the way translate/find-images require).
 */
router.post('/remove-all-badges', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const result = await db.prepare(`UPDATE products SET badge='', badge_ar='', updated_at=datetime('now') WHERE active=1 AND (badge != '' OR badge_ar != '')`).run();
    const count = result?.changes ?? result?.rowCount ?? 0;
    logActivity(req, 'product.bulk_clear_badges', 'product', `${count} products`);
    res.json({ message: `Removed badges from ${count} product(s).`, count });
  } catch (err) { next(err); }
});

router.post('/bulk-delete', auth, requireAdmin, async (req, res, next) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'No product IDs provided.' });
    if (ids.length > 500) return res.status(400).json({ error: 'Maximum 500 products per bulk delete — select fewer at a time.' });
    const db = getDb();
    let deleted = 0;
    for (const id of ids) {
      const existing = await db.prepare('SELECT id, name FROM products WHERE id=? AND active=1').get(id);
      if (!existing) continue; // already inactive or doesn't exist — skip quietly rather than error the whole batch
      await db.prepare("UPDATE products SET active=0, updated_at=datetime('now') WHERE id=?").run(id);
      deleted++;
    }
    logActivity(req, 'product.bulk_delete', 'product', `${deleted} products`);
    res.json({ message: `${deleted} product(s) deleted.`, deleted });
  } catch (err) { next(err); }
});

/**
 * POST /api/products/bulk-assign-from-library
 * Body: { ids: [1, 2, 3, ...] }
 * For each selected product missing an image, fuzzy-matches its name
 * against every filename in the photo library and assigns the best
 * confident match. Deliberately conservative — the same principle proven
 * out in an earlier one-off matching task for this project: a product
 * left without an image is a much smaller problem than a product showing
 * a confidently-wrong photo, so this requires either a shared, genuinely
 * distinctive model-number-like token, or a shared brand name plus
 * several other shared words, before accepting a match at all.
 */
const GENERIC_SPEC_TERMS = new Set([
  'win11','win10','win7','ci3','ci5','ci7','ci9','r3','r5','r7','r9',
  '4gb','8gb','16gb','32gb','64gb','128gb','256gb','512gb','1tb','2tb',
  'wifi','wifi6','usb2','usb3','4k','2k','1080p','720p','fhd','uhd','qhd',
  'rtx','gtx','5g','laptop','desktop','monitor','printer','scanner',
  'wireless','black','white','grey','gray','blue','red','silver','new',
  'pro','plus','edition','series','inch','inches','with','for','the','and',
]);
const KNOWN_BRANDS_JS = new Set([
  'apple','asus','hp','lenovo','dell','msi','acer','samsung','microsoft',
  'lg','sony','canon','epson','brother','logitech','corsair','razer',
  'kingston','sandisk','lexar','seagate','western','wd','tplink','dlink',
  'cisco','ubiquiti','apc','schneider','fresh','toshiba','gigabyte',
  'cougar','intel','amd','nvidia','belkin','anker','huawei','xiaomi',
  'realme','oneplus','jbl','bose','philips','tornado',
]);
// Distinguishes WHAT an item actually is, not just its brand or specs —
// a likely real cause of wrong matches: two products can easily share a
// brand plus a few generic words (e.g. both "Apple" and "wireless")
// while being completely different items (a charger vs. a case). If the
// product name names one of these, the candidate photo's filename must
// name the same one — otherwise the match is rejected outright,
// regardless of how well everything else scores.
const PRODUCT_TYPE_WORDS = new Set([
  'charger','cable','case','cover','mouse','keyboard','headset','headphone',
  'headphones','earphone','earbuds','speaker','watch','band','bag','sleeve',
  'backpack','adapter','holder','stand','mount','tripod','powerbank','bank',
  'screen','protector','hub','dock','printer','scanner','router','switch',
  'camera','webcam','microphone','mic','fan','cooler','psu','motherboard',
  'ram','ssd','hdd','gpu','cpu','monitor','tv','television','oven',
  'kettle','blender','fryer','mixer','dryer','straightener','vacuum',
]);
function tokenizeForMatch(text) {
  return (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(t => t.length > 1 && !GENERIC_SPEC_TERMS.has(t));
}
function isModelToken(tok) {
  return /[a-z]/.test(tok) && /[0-9]/.test(tok) && tok.length >= 6 && !GENERIC_SPEC_TERMS.has(tok);
}

router.post('/bulk-assign-from-library', auth, requireAdmin, async (req, res, next) => {
  try {
    const { ids, batch_size } = req.body;
    const db = getDb();
    // Explicit ids (selection-scoped) OR, when omitted, a batch of
    // whatever's missing an image site-wide — same resumable batch+offset
    // pattern as auto-translate/auto-find-images, since running this
    // against the whole catalog could mean thousands of products, too
    // many to process in a single request safely.
    const useAllMode = !Array.isArray(ids) || !ids.length;
    const limit = Math.min(50, Math.max(1, parseInt(batch_size) || 30));

    let products;
    if (useAllMode) {
      // library_match_checked=0 excludes products already tried in a
      // previous batch (matched or not) — this is what makes the run
      // actually terminate, instead of re-selecting the same unmatchable
      // products by "image IS NULL" forever since a failed match never
      // changes that condition on its own.
      products = await db.prepare(`SELECT id, name FROM products WHERE active=1 AND image IS NULL AND library_match_checked=0 ORDER BY id LIMIT ?`).all(limit);
    } else {
      const placeholders = ids.map(() => '?').join(',');
      products = await db.prepare(`SELECT id, name FROM products WHERE id IN (${placeholders}) AND active=1`).all(...ids);
    }

    const libraryPhotos = await db.prepare('SELECT filename, blob_url FROM photo_library').all();
    if (!libraryPhotos.length) return res.json({ matched: 0, total: products.length, results: [], remaining: useAllMode ? Number((await db.prepare(`SELECT COUNT(*) as c FROM products WHERE active=1 AND image IS NULL AND library_match_checked=0`).get()).c) : 0, error: 'Library is empty — nothing to match against.' });

    const libIndexed = libraryPhotos.map(p => ({
      filename: p.filename, blob_url: p.blob_url,
      tokens: new Set(tokenizeForMatch(p.filename.replace(/\.[a-z0-9]+$/i, ''))),
    }));

    const results = [];
    let matched = 0;
    for (const product of products) {
      const productTokens = new Set(tokenizeForMatch(product.name));
      const productBrand = new Set([...productTokens].filter(t => KNOWN_BRANDS_JS.has(t)));
      const productModels = new Set([...productTokens].filter(isModelToken));
      const productType = new Set([...productTokens].filter(t => PRODUCT_TYPE_WORDS.has(t)));

      let best = null, bestScore = 0;
      for (const lib of libIndexed) {
        const libBrand = new Set([...lib.tokens].filter(t => KNOWN_BRANDS_JS.has(t)));
        if (productBrand.size && libBrand.size && ![...productBrand].some(b => libBrand.has(b))) continue;

        // Hard rejection: if the product names a specific kind of item
        // (charger, case, watch, etc.) and the candidate photo's filename
        // names a DIFFERENT specific kind, reject outright — this is what
        // let a same-brand, wrong-item mismatch through before (e.g. an
        // Apple charger scoring well against an Apple case purely on
        // brand + a few shared generic words).
        const libType = new Set([...lib.tokens].filter(t => PRODUCT_TYPE_WORDS.has(t)));
        if (productType.size && libType.size && ![...productType].some(t => libType.has(t))) continue;

        const shared = [...productTokens].filter(t => lib.tokens.has(t));
        const sharedModels = [...productModels].filter(t => lib.tokens.has(t));
        const sharedBrand = [...productBrand].filter(t => lib.tokens.has(t));

        let score = 0;
        if (sharedModels.length) score = 10 + shared.length;
        else if (sharedBrand.length && shared.length >= 4) score = shared.length;
        else continue;

        if (score > bestScore) { bestScore = score; best = lib; }
      }

      if (best) {
        await db.prepare(`UPDATE products SET image=?, images=?, library_match_checked=1, updated_at=datetime('now') WHERE id=?`)
          .run(best.blob_url, JSON.stringify([best.blob_url]), product.id);
        matched++;
        results.push({ id: product.id, name: product.name, status: 'matched', matched_file: best.filename });
      } else {
        // Still marked checked even without a match — this single line is
        // the actual fix. Without it, this product's image stays NULL and
        // it gets pulled into every subsequent batch's WHERE clause again.
        await db.prepare(`UPDATE products SET library_match_checked=1 WHERE id=?`).run(product.id);
        results.push({ id: product.id, name: product.name, status: 'no confident match found' });
      }
    }

    const remaining = useAllMode
      ? Number((await db.prepare(`SELECT COUNT(*) as c FROM products WHERE active=1 AND image IS NULL AND library_match_checked=0`).get()).c)
      : 0;

    logActivity(req, 'product.bulk_library_match', 'product', `${matched} products matched from library`);
    res.json({ matched, total: products.length, results, remaining });
  } catch (err) { next(err); }
});

// CATEGORIES CRUD (admin)
/**
 * GET /api/products/admin/all-ids?search=&category=
 * Returns EVERY product id matching the current filter — not paginated.
 * Powers a genuine "select all N products" in the admin panel, as
 * opposed to only selecting whatever page happens to be currently
 * loaded (which is all the header checkbox could reach before this).
 * Reuses the exact same filter logic as the main listing endpoint above,
 * so "select all" always matches what's actually visible under the same
 * search/category filter.
 */
router.get('/admin/all-ids', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const { category, search } = req.query;
    let sql = `SELECT p.id FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.active=1`;
    const params = [];
    if (category) { sql += ' AND c.slug=?'; params.push(category); }
    if (search) {
      sql += ' AND (p.name LIKE ? OR p.name_ar LIKE ? OR p.description LIKE ? OR p.description_ar LIKE ? OR p.brand LIKE ? OR c.name LIKE ? OR c.name_ar LIKE ?)';
      const s = `%${search}%`; params.push(s,s,s,s,s,s,s);
    }
    const rows = await db.prepare(sql).all(...params);
    res.json({ ids: rows.map(r => r.id), total: rows.length });
  } catch (err) { next(err); }
});

/**
 * GET /api/products/admin/by-id/:id
 * Full current data for one product, admin-only (includes inactive
 * products and all fields, unlike the public /:slug route). Used to
 * refresh the Edit Product modal in place after a per-product AI action
 * (translate, find image) without closing and reopening it, which would
 * lose any other unsaved edits the admin has made.
 */
router.get('/admin/by-id/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const p = await db.prepare('SELECT p.*, c.name as category_name FROM products p LEFT JOIN categories c ON p.category_id=c.id WHERE p.id=?').get(req.params.id);
    if (!p) return res.status(404).json({ error: 'Not found.' });
    res.json({ product: { ...p, specs: p.specs ? p.specs.split('|') : [], specs_ar: p.specs_ar ? p.specs_ar.split('|') : [] } });
  } catch (err) { next(err); }
});

router.get('/admin/categories', auth, async (req, res, next) => {
  try {
    res.json({ categories: await getDb().prepare('SELECT * FROM categories ORDER BY sort_order').all() });
  } catch (err) { next(err); }
});
router.post('/admin/categories', auth, requireAdmin, async (req, res, next) => {
  try {
    const { name, description, icon, name_ar, description_ar, category_type } = req.body;
    if (!name) return res.status(400).json({ error:'Name required.' });
    const db = getDb();
    let slug = slugify(name);
    const existing = await db.prepare('SELECT id FROM categories WHERE slug=?').get(slug);
    if (existing) slug = slug + '-' + Date.now();
    const result = await db.prepare('INSERT INTO categories(name,slug,description,icon,name_ar,description_ar,category_type) VALUES(?,?,?,?,?,?,?)').run(name,slug,description||'',icon||'',name_ar||'',description_ar||'',category_type==='enterprise'?'enterprise':'consumer');
    res.status(201).json({ category: await db.prepare('SELECT * FROM categories WHERE id=?').get(result.lastInsertRowid) });
  } catch (err) { next(err); }
});
router.put('/admin/categories/:id', auth, requireAdmin, async (req, res, next) => {
  try {
    const { name, description, icon, active, name_ar, description_ar, category_type } = req.body;
    const db = getDb();
    const cat = await db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id);
    if (!cat) return res.status(404).json({ error:'Not found.' });
    await db.prepare('UPDATE categories SET name=?,description=?,icon=?,active=?,name_ar=?,description_ar=?,category_type=? WHERE id=?').run(name||cat.name,description??cat.description,icon??cat.icon,active!==undefined?(active==='1'?1:0):cat.active,name_ar??cat.name_ar,description_ar??cat.description_ar,category_type!==undefined?(category_type==='enterprise'?'enterprise':'consumer'):cat.category_type,req.params.id);
    res.json({ category: await db.prepare('SELECT * FROM categories WHERE id=?').get(req.params.id) });
  } catch (err) { next(err); }
});

/**
 * POST /api/products/reprocess-images
 * Retroactively trims padding from EXISTING product images (the auto-trim
 * on new uploads only applies going forward, not to what's already saved).
 *
 * Processes a small batch of PRODUCTS per call (not images — a product can
 * have up to 8) rather than everything at once, since a serverless
 * function has an execution time limit and fetching + trimming +
 * re-uploading every image on a real catalog in one request risks timing
 * out. The admin panel calls this repeatedly until `remaining` is 0,
 * showing progress between calls.
 *
 * Safe to retry/interrupt: images_trimmed is only set to 1 AFTER a
 * product's images are successfully reprocessed, so a request that times
 * out or fails partway through doesn't lose track of anything — the next
 * call just picks up where it left off.
 */
/**
 * POST /api/products/reprocess-images
 * Retroactively trims padding from EXISTING product images (the auto-trim
 * on new uploads only applies going forward, not to what's already saved).
 *
 * Processes a small batch of PRODUCTS per call (not images — a product can
 * have up to 8) rather than everything at once, since a serverless
 * function has an execution time limit and fetching + trimming +
 * re-uploading every image on a real catalog in one request risks timing
 * out. The admin panel calls this repeatedly until `remaining` is 0,
 * showing progress between calls.
 *
 * Normal mode: only products not yet marked images_trimmed=1. Safe to
 * retry/interrupt — the flag is only set AFTER success, so a request that
 * times out or fails partway through doesn't lose track of anything.
 *
 * force=true: re-checks EVERY product regardless of images_trimmed,
 * needed after adjusting the trim tolerance itself (a product already
 * marked "done" under the old, stricter tolerance may not have actually
 * been trimmed at all). Since the flag can't distinguish "done under old
 * settings" from "done under new settings," force mode pages through
 * everything by offset instead of by the flag.
 */
router.post('/reprocess-images', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    const batchSize = Math.min(parseInt(req.body.batch_size) || 2, 5);
    const force = req.body.force === true || req.body.force === 'true';
    const offset = parseInt(req.body.offset) || 0;

    const products = force
      ? await db.prepare(
          `SELECT id, name, image, images FROM products WHERE (image IS NOT NULL OR images IS NOT NULL) ORDER BY id LIMIT ? OFFSET ?`
        ).all(batchSize, offset)
      : await db.prepare(
          `SELECT id, name, image, images FROM products WHERE (images_trimmed IS NULL OR images_trimmed = 0) AND (image IS NOT NULL OR images IS NOT NULL) LIMIT ?`
        ).all(batchSize);

    const results = [];
    for (const product of products) {
      try {
        let imgs = [];
        try { imgs = product.images ? JSON.parse(product.images) : (product.image ? [product.image] : []); } catch { imgs = product.image ? [product.image] : []; }
        if (!imgs.length) {
          await db.prepare('UPDATE products SET images_trimmed=1 WHERE id=?').run(product.id);
          results.push({ id: product.id, name: product.name, status: 'skipped (no images)' });
          continue;
        }
        const newUrls = [];
        for (const url of imgs) {
          try {
            const resp = await fetch(url);
            if (!resp.ok) { newUrls.push(url); continue; } // keep original if it can't be fetched
            const contentType = (resp.headers.get('content-type') || 'image/jpeg').split(';')[0].trim();
            const buf = Buffer.from(await resp.arrayBuffer());
            const trimmed = await trimImageBuffer(buf, contentType);
            const ext = MIME_TO_EXT[contentType] || '.jpg';
            const newUrl = await uploadImageBuffer(trimmed, `prod-retrim-${Date.now()}-${Math.random().toString(36).slice(2,7)}${ext}`, contentType);
            newUrls.push(newUrl);
            deleteImageByUrl(url).catch(() => {}); // cleanup the old file, non-blocking
          } catch (e) {
            console.error(`[Reprocess] Failed on image ${url}:`, e.message);
            newUrls.push(url); // keep the original rather than losing the photo
          }
        }
        await db.prepare('UPDATE products SET image=?, images=?, images_trimmed=1 WHERE id=?').run(newUrls[0] || null, JSON.stringify(newUrls), product.id);
        results.push({ id: product.id, name: product.name, status: 'processed' });
      } catch (e) {
        console.error(`[Reprocess] Failed on product ${product.id}:`, e.message);
        // Mark done anyway so a broken product can't get retried forever.
        await db.prepare('UPDATE products SET images_trimmed=1 WHERE id=?').run(product.id).catch(() => {});
        results.push({ id: product.id, name: product.name, status: 'error: ' + e.message });
      }
    }

    let remaining, nextOffset;
    if (force) {
      const total = Number((await db.prepare(
        "SELECT COUNT(*) as c FROM products WHERE (image IS NOT NULL OR images IS NOT NULL)"
      ).get()).c);
      nextOffset = offset + products.length;
      remaining = Math.max(0, total - nextOffset);
    } else {
      remaining = Number((await db.prepare(
        "SELECT COUNT(*) as c FROM products WHERE (images_trimmed IS NULL OR images_trimmed = 0) AND (image IS NOT NULL OR images IS NOT NULL)"
      ).get()).c);
    }
    res.json({ processed: results, remaining, next_offset: nextOffset });
  } catch (err) { next(err); }
});

module.exports = router;
