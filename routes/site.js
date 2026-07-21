/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Site Settings Routes
 *  File: routes/site.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  WHAT THIS DOES:
 *  Manages all editable website content through a key-value settings table.
 *  The admin Site Editor reads and writes these settings.
 *  The page sections manager stores entire page layouts as JSON blobs.
 *
 *  ENDPOINTS:
 *
 *  GET /api/site
 *    Headers: Authorization: Bearer <token>
 *    Returns: { settings: [...], grouped: { hero: [...], about: [...], ... } }
 *    Returns ALL settings grouped by section for the admin editor.
 *
 *  GET /api/site/public
 *    No auth required.
 *    Returns: { settings: { key: value, ... } }
 *    Use: Frontend pages can fetch live content from this endpoint.
 *
 *  PUT /api/site
 *    Headers: Authorization: Bearer <token>
 *    Body: { settings: { key1: value1, key2: value2, ... } }
 *    Updates multiple settings at once (upsert — create or update).
 *
 *  PUT /api/site/:key
 *    Headers: Authorization: Bearer <token>
 *    Body: { value }
 *    Updates a single setting by key.
 *
 *  SPECIAL SETTINGS KEYS:
 *    pe_sections_home     → JSON array of home page section configs
 *    pe_sections_store    → JSON array of store page section configs
 *    pe_sections_request  → JSON array of request service page sections
 *    pe_sections_contact  → JSON array of contact page sections
 *    pe_sections_footer   → JSON array of footer/SEO sections
 *    hero_title           → Home page hero headline
 *    contact_email        → Company contact email (shown on website)
 *    meta_title           → SEO page title
 *    meta_description     → SEO meta description
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const { getDb } = require('../db/database');
const { auth, requireAdmin } = require('../middleware/auth');

// ── SITE SETTINGS DEFAULTS ───────────────────────────────────────────────────
// BE-02 fix: the site_settings table itself is created once in
// db/database.js's initDb() at server startup (consistent with every other
// table) instead of being created lazily inside a route handler on every
// request. This function only seeds the default rows. It's exported and
// called once from server.js's readiness gate, right after initDb()
// resolves — it used to self-invoke at module load, but now that both are
// async, that ordering has to be explicit instead of implicit.
async function seedDefaultSettings() {
  const db = getDb();

  // Seed default settings
  const defaults = [
    // Hero
    ['hero_title',      'Building <em>Future-Ready</em> IT Infrastructure', 'Hero Title',        'html',     'hero'],
    ['hero_subtitle',   'InfraConnect delivers high-performance IT infrastructure, cloud services, and managed IT support for businesses that refuse to stand still.', 'Hero Subtitle', 'textarea', 'hero'],
    ['hero_btn1_text',  'Browse Products',   'Hero Button 1 Text',  'text', 'hero'],
    ['hero_btn1_link',  '/store',            'Hero Button 1 Link',  'text', 'hero'],
    ['hero_btn2_text',  'Get in Touch',      'Hero Button 2 Text',  'text', 'hero'],
    ['hero_btn2_link',  '#contact',          'Hero Button 2 Link',  'text', 'hero'],
    // About
    ['about_title',     'Trusted IT Partner for the Middle East', 'About Title',         'text',     'about'],
    ['about_text1',     'Founded in 2023 in Cairo, Egypt, InfraConnect provides high-performance IT infrastructure and managed services. We help businesses operate efficiently, scale confidently, and adopt modern technology reliably.', 'About Paragraph 1', 'textarea', 'about'],
    ['about_text2',     'Our vision is to become the premier IT partner in the Middle East — delivering innovative solutions that drive business growth and digital transformation.', 'About Paragraph 2', 'textarea', 'about'],
    ['vision_text',     'Premier trusted IT partner in the Middle East, driving digital transformation.', 'Vision Statement', 'textarea', 'about'],
    ['mission_text',    'Empower businesses with reliable infrastructure, expert support and exceptional quality.', 'Mission Statement', 'textarea', 'about'],
    // Contact
    ['contact_email',   'info@infraconnect24-7.com', 'Contact Email',   'text', 'contact'],
    ['contact_phone1',  '+20 102 080 3988',           'Phone 1',         'text', 'contact'],
    ['contact_phone2',  '+971 55 275 5976',           'Phone 2',         'text', 'contact'],
    ['contact_address', 'Cairo, Egypt',               'Address',         'text', 'contact'],
    ['contact_region',  'Serving the Middle East region', 'Region',      'text', 'contact'],
    ['whatsapp_number', '+201020803988',               'WhatsApp Number', 'text', 'contact'],
    // Company
    ['company_name',    'InfraConnect',               'Company Name',    'text',     'company'],
    ['company_tagline', 'IT Infrastructure & Technology Solutions', 'Tagline', 'text', 'company'],
    ['company_founded', '2023',                       'Founded Year',    'text',     'company'],
    ['company_region',  'Cairo, Egypt',               'Location',        'text',     'company'],
    // SEO
    ['meta_title',      'InfraConnect — IT Infrastructure & Tech Store', 'Page Title', 'text',    'seo'],
    ['meta_description','InfraConnect provides high-performance IT infrastructure, cloud services, and managed IT in Egypt and the Middle East.', 'Meta Description', 'textarea', 'seo'],
    // Services
    ['service1_title',  'Infrastructure, Cloud & Networks', 'Service 1 Title', 'text', 'services'],
    ['service1_desc',   'End-to-end design and deployment of your physical and virtual IT backbone. Servers, storage, LAN/WAN, Wi-Fi, VPN, SD-WAN and cloud migration.', 'Service 1 Description', 'textarea', 'services'],
    ['service2_title',  'Cloud Integration & Cyber Resilience', 'Service 2 Title', 'text', 'services'],
    ['service2_desc',   'Protect your business with enterprise-grade security. 24/7 managed IT, firewalls, endpoint protection, IAM, email security and MDR.', 'Service 2 Description', 'textarea', 'services'],
    ['service3_title',  'Managed Services & Operations', 'Service 3 Title', 'text', 'services'],
    ['service3_desc',   'Keep your business running with proactive support. Backup & DR, business continuity, IT consulting and authorized IT procurement.', 'Service 3 Description', 'textarea', 'services'],
    // Store
    ['store_hero_title','IT Products & Electronics Store', 'Store Hero Title', 'text', 'store'],
    ['store_hero_sub',  'Enterprise IT infrastructure, laptops, TVs, gaming, accessories and more — all in one place.', 'Store Hero Subtitle', 'textarea', 'store'],
    ['vat_rate',        '15',                          'VAT Rate (%)',     'number',   'store'],
    ['currency',        'USD',                         'Currency',         'select',   'store'],
    // Footer
    ['footer_tagline',  'Your one-stop shop for enterprise IT and consumer electronics in Egypt and the Middle East.', 'Footer Tagline', 'textarea', 'footer'],
    ['copyright_text',  '2025 InfraConnect. All rights reserved.', 'Copyright Text', 'text', 'footer'],
  ];

  // SQLite's "INSERT OR IGNORE" doesn't exist in Postgres — the equivalent
  // is ON CONFLICT DO NOTHING (site_settings.key is the primary key).
  const ins = db.prepare('INSERT INTO site_settings(key,value,label,type,section) VALUES(?,?,?,?,?) ON CONFLICT (key) DO NOTHING');
  for (const d of defaults) { await ins.run(...d); }

  // Arabic translations for the public-facing text settings. Only fills
  // empty fields — never overwrites a translation already edited by hand.
  const { siteSettingsTranslations } = require('../db/translations-ar');
  const updSetting = db.prepare("UPDATE site_settings SET value_ar=? WHERE key=? AND (value_ar IS NULL OR value_ar='')");
  for (const [key, val] of Object.entries(siteSettingsTranslations)) { await updSetting.run(val, key); }
}

// GET all settings (grouped by section)
router.get('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const db = getDb();
    // NOTE: SQLite's implicit `rowid` doesn't exist in Postgres — site_settings
    // has no natural insertion-order column, so this orders by key instead.
    const rows = await db.prepare('SELECT * FROM site_settings ORDER BY section, key').all();
    const grouped = {};
    rows.forEach(r => {
      if (!grouped[r.section]) grouped[r.section] = [];
      grouped[r.section].push(r);
    });
    res.json({ settings: rows, grouped });
  } catch (err) { next(err); }
});

// GET single setting (public)
router.get('/public', async (req, res, next) => {
  try {
    const rows = await getDb().prepare('SELECT key, value, value_ar FROM site_settings').all();
    const map = {}, mapAr = {};
    rows.forEach(r => { map[r.key] = r.value; mapAr[r.key] = r.value_ar; });
    res.json({ settings: map, settings_ar: mapAr });
  } catch (err) { next(err); }
});

// PUT update settings (bulk) — accepts { settings: {key:value}, settings_ar: {key:value_ar} }
router.put('/', auth, requireAdmin, async (req, res, next) => {
  try {
    const { settings, settings_ar } = req.body;
    if (!settings || typeof settings !== 'object') return res.status(400).json({ error: 'settings object required.' });
    const db = getDb();
    const upd = db.prepare("INSERT INTO site_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at");
    const updAr = db.prepare("UPDATE site_settings SET value_ar=?, updated_at=datetime('now') WHERE key=?");
    // See the KNOWN SIMPLIFICATION note in db/database.js — this runs
    // sequentially rather than in a true atomic transaction.
    for (const [k, v] of Object.entries(settings)) { await upd.run(k, v); }
    if (settings_ar) { for (const [k, v] of Object.entries(settings_ar)) { await updAr.run(v, k); } }
    res.json({ message: `${Object.keys(settings).length} settings saved.` });
  } catch (err) { next(err); }
});

// PUT single setting — accepts { value, value_ar }
router.put('/:key', auth, requireAdmin, async (req, res, next) => {
  try {
    const { value, value_ar } = req.body;
    const db = getDb();
    await db.prepare("INSERT INTO site_settings(key,value,updated_at) VALUES(?,?,datetime('now')) ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at").run(req.params.key, value);
    if (value_ar !== undefined) await db.prepare("UPDATE site_settings SET value_ar=?, updated_at=datetime('now') WHERE key=?").run(value_ar, req.params.key);
    res.json({ message: 'Saved.' });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.seedDefaultSettings = seedDefaultSettings;
