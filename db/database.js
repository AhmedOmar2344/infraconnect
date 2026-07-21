/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Database Setup & Seed Data
 *  File: db/database.js
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  WHAT THIS FILE DOES:
 *  - Creates and connects to Neon Postgres (via @neondatabase/serverless)
 *  - Creates all tables if they don't exist yet (safe to run multiple times)
 *  - Runs migrations to add new columns to existing tables
 *  - Seeds the database with default data on first run:
 *      * Admin user (from .env ADMIN_EMAIL / ADMIN_PASSWORD)
 *      * 14 product categories (Enterprise IT + Consumer/Home)
 *      * 55+ sample products across all categories
 *
 *  DATABASE TABLES:
 *    users         - Admin panel users (email, password hash, role)
 *    categories    - Product categories (name, slug, icon, sort order)
 *    products      - All store products with pricing, specs, installments
 *    orders        - Customer checkout order requests
 *    messages      - Contact form submissions
 *    quotes        - Quote requests (from contact form & request service page)
 *    site_settings - Key-value store for all editable website content
 *
 *  PRODUCT FIELDS EXPLAINED:
 *    name                 - Display name shown in store
 *    slug                 - URL-safe unique identifier (auto-generated from name)
 *    category_id          - Foreign key to categories table
 *    brand                - Manufacturer/brand name
 *    description          - Short product description
 *    specs                - Technical specs, pipe-separated: "8GB RAM|512GB SSD|..."
 *    price                - Display price string: "$1,299" or "Price on Request"
 *    price_amount         - Numeric price for cart calculations (0 = on request)
 *    currency             - USD, EGP, or AED (affects VAT rate)
 *    badge                - Short highlight: "New", "Best Seller", "Popular"
 *    image                - URL path to product image
 *    featured             - 1 = show on homepage, 0 = store only
 *    active               - 1 = visible, 0 = soft-deleted/hidden
 *    stock_status         - available | on_order | out_of_stock
 *    installments_enabled - 1 = allow installment purchase
 *    installment_months   - "all" or comma-separated: "6,12,18,24"
 *
 *  VAT RATES BY CURRENCY:
 *    USD → 15%  |  EGP → 14%  |  AED → 5%
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */
require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');

/**
 * ── Postgres migration notes ──────────────────────────────────────────────
 * This app was originally written against better-sqlite3 (synchronous,
 * `?`-placeholder SQL). It now runs on Neon Postgres instead, since Vercel's
 * filesystem can't hold a persistent SQLite file. To avoid rewriting ~106
 * individual query call sites across 8 files, getDb() returns a shim that
 * mimics better-sqlite3's `db.prepare(sql).get/all/run()` shape, but async:
 *
 *   - `?` placeholders are auto-converted to Postgres's `$1, $2, ...`
 *   - `datetime('now')` is auto-converted to `CURRENT_TIMESTAMP`
 *   - INSERT statements automatically get `RETURNING id` appended (unless
 *     already present) so `.run()` can still return `{ lastInsertRowid }`
 *
 * Every call site still needed `await` added and its enclosing function
 * made `async` — that part of the migration couldn't be avoided.
 *
 * KNOWN SIMPLIFICATION: `db.transaction(fn)` here does NOT wrap statements
 * in a real BEGIN/COMMIT — it just runs them in sequence. The two places
 * that used it (bulk settings save, bulk Excel product import) are both
 * admin-only maintenance actions, not customer-facing money paths, so a
 * partial failure isn't catastrophic — but it's not atomic. Flagging this
 * rather than quietly downgrading it without saying so.
 */

let pool;
function getPool() {
  if (!pool) {
    if (!process.env.DATABASE_URL) {
      throw new Error(
        'DATABASE_URL is not set. Add it to your .env locally (copy it from ' +
        'Vercel → Storage → your Neon database → Connection String), and make ' +
        'sure it is also set in Vercel → Settings → Environment Variables.'
      );
    }
    pool = new Pool({ connectionString: process.env.DATABASE_URL });
  }
  return pool;
}

// Converts `?` positional placeholders to Postgres's `$1, $2, ...`, and
// SQLite's `datetime('now')` to Postgres's `CURRENT_TIMESTAMP`.
function toPgSql(sql) {
  let i = 0;
  return sql
    .replace(/datetime\('now'\)/gi, 'CURRENT_TIMESTAMP')
    .replace(/\?/g, () => `$${++i}`);
}

function isInsert(sql) { return /^\s*INSERT\s/i.test(sql); }
function hasReturning(sql) { return /RETURNING/i.test(sql); }
// site_settings is the one table in this app whose primary key isn't
// called `id` (it's `key`, a text field) — auto-appending "RETURNING id"
// to an INSERT into that table throws "column \"id\" does not exist"
// in Postgres. This broke every single request, since one of those
// INSERTs runs during the startup sequence every API call waits on.
function targetsTableWithoutId(sql) { return /INTO\s+site_settings\b/i.test(sql); }

function makeStatement(sql) {
  return {
    async get(...args) {
      const flatArgs = args.flat();
      const result = await getPool().query(toPgSql(sql), flatArgs);
      return result.rows[0];
    },
    async all(...args) {
      const flatArgs = args.flat();
      const result = await getPool().query(toPgSql(sql), flatArgs);
      return result.rows;
    },
    async run(...args) {
      const flatArgs = args.flat();
      let finalSql = sql;
      const insert = isInsert(sql) && !targetsTableWithoutId(sql);
      if (insert && !hasReturning(sql)) {
        finalSql = sql.replace(/;\s*$/, '') + ' RETURNING id';
      }
      const result = await getPool().query(toPgSql(finalSql), flatArgs);
      return {
        lastInsertRowid: insert && result.rows[0] ? result.rows[0].id : undefined,
        changes: result.rowCount
      };
    }
  };
}

function getDb() {
  return {
    prepare(sql) { return makeStatement(sql); },
    // Runs a block of `;`-separated DDL statements one at a time — Postgres
    // (via this driver) doesn't execute multi-statement strings the way
    // better-sqlite3's .exec() did.
    async exec(sql) {
      const statements = sql.split(';').map(s => s.trim()).filter(Boolean);
      for (const stmt of statements) {
        await getPool().query(toPgSql(stmt));
      }
    },
    // No-op: Postgres always enforces foreign keys and manages its own WAL;
    // better-sqlite3 needed these pragmas, Postgres doesn't.
    pragma() {},
    // See the KNOWN SIMPLIFICATION note above — sequential, not atomic.
    transaction(fn) {
      return async (...args) => await fn(...args);
    }
  };
}

async function initDb() {
  const db = getDb();
  await db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'admin', active INTEGER DEFAULT 1,
      two_factor_secret TEXT, two_factor_enabled INTEGER DEFAULT 0, two_factor_backup_codes TEXT,
      created_at TEXT DEFAULT (datetime('now')), last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS categories (
      id SERIAL PRIMARY KEY,
      name TEXT UNIQUE NOT NULL, slug TEXT UNIQUE NOT NULL,
      description TEXT, icon TEXT, sort_order INTEGER DEFAULT 0,
      name_ar TEXT, description_ar TEXT, category_type TEXT DEFAULT 'consumer',
      active INTEGER DEFAULT 1, created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS products (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL, slug TEXT UNIQUE NOT NULL, category_id INTEGER REFERENCES categories(id),
      brand TEXT, description TEXT, specs TEXT,
      name_ar TEXT, description_ar TEXT, specs_ar TEXT, badge_ar TEXT,
      price TEXT DEFAULT 'Price on Request',
      price_amount REAL DEFAULT 0,
      currency TEXT DEFAULT 'USD',
      badge TEXT, image TEXT, images TEXT, images_trimmed INTEGER DEFAULT 0, featured INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
      condition TEXT DEFAULT 'new', stock_quantity INTEGER,
      stock_status TEXT DEFAULT 'available',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS orders (
      id SERIAL PRIMARY KEY,
      order_number TEXT UNIQUE NOT NULL, client_name TEXT NOT NULL,
      client_email TEXT NOT NULL, client_phone TEXT, client_company TEXT,
      items TEXT NOT NULL, items_detail TEXT, notes TEXT, status TEXT DEFAULT 'pending',
      total_label TEXT, subtotal REAL DEFAULT 0,
      voucher_code TEXT, discount_amount REAL DEFAULT 0,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS messages (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL, last_name TEXT, email TEXT NOT NULL,
      phone TEXT, service TEXT, message TEXT NOT NULL,
      status TEXT DEFAULT 'unread', notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS quotes (
      id SERIAL PRIMARY KEY,
      first_name TEXT NOT NULL, last_name TEXT, email TEXT NOT NULL,
      phone TEXT, company TEXT, product_names TEXT, items_detail TEXT, service TEXT,
      message TEXT, status TEXT DEFAULT 'new', notes TEXT, order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS site_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      value_ar TEXT,
      label TEXT,
      type TEXT DEFAULT 'text',
      section TEXT DEFAULT 'general',
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS page_visits (
      id SERIAL PRIMARY KEY,
      path TEXT NOT NULL,
      referrer TEXT,
      user_agent TEXT,
      visitor_hash TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS monthly_reports (
      id SERIAL PRIMARY KEY,
      month TEXT UNIQUE NOT NULL,
      total_visits INTEGER DEFAULT 0,
      unique_visitors INTEGER DEFAULT 0,
      top_pages TEXT,
      top_referrers TEXT,
      device_breakdown TEXT,
      email_sent INTEGER DEFAULT 0,
      generated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS reviews (
      id SERIAL PRIMARY KEY,
      product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
      customer_name TEXT NOT NULL,
      customer_email TEXT,
      rating INTEGER NOT NULL CHECK (rating >= 1 AND rating <= 5),
      comment TEXT,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS vouchers (
      id SERIAL PRIMARY KEY,
      code TEXT UNIQUE NOT NULL,
      discount_type TEXT DEFAULT 'percentage',
      discount_value REAL NOT NULL,
      max_discount_amount REAL,
      max_discount_currency TEXT,
      min_order_amount REAL DEFAULT 0,
      max_uses INTEGER,
      times_used INTEGER DEFAULT 0,
      expires_at TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS api_credentials (
      id SERIAL PRIMARY KEY,
      service_name TEXT NOT NULL,
      key_label TEXT NOT NULL,
      key_value_encrypted TEXT NOT NULL,
      key_hint TEXT,
      notes TEXT,
      active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS photo_library (
      id SERIAL PRIMARY KEY,
      filename TEXT NOT NULL UNIQUE,
      blob_url TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chat_conversations (
      id SERIAL PRIMARY KEY,
      session_id TEXT UNIQUE NOT NULL,
      visitor_name TEXT,
      visitor_email TEXT,
      status TEXT DEFAULT 'open',
      unread_by_admin INTEGER DEFAULT 0,
      unread_by_visitor INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      last_message_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS chat_messages (
      id SERIAL PRIMARY KEY,
      conversation_id INTEGER NOT NULL REFERENCES chat_conversations(id) ON DELETE CASCADE,
      sender TEXT NOT NULL,
      message TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS activity_log (
      id SERIAL PRIMARY KEY,
      admin_id INTEGER,
      admin_email TEXT,
      action TEXT NOT NULL,
      entity_type TEXT,
      entity_label TEXT,
      details TEXT,
      ip_address TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS customers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT,
      google_id TEXT,
      phone TEXT, company TEXT, address TEXT, admin_notes TEXT, active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')), last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS couriers (
      id SERIAL PRIMARY KEY,
      name TEXT NOT NULL, email TEXT UNIQUE NOT NULL, password TEXT NOT NULL,
      phone TEXT, active INTEGER DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')), last_login TEXT
    );
    CREATE TABLE IF NOT EXISTS refund_requests (
      id SERIAL PRIMARY KEY,
      order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
      customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL,
      reason TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      admin_notes TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // ── Migrations ──────────────────────────────────────────────────────────
  // Postgres supports "ADD COLUMN IF NOT EXISTS" natively, so unlike the old
  // SQLite version of this file, there's no need to catch "duplicate column"
  // errors here — genuine errors (permissions, connection issues) now just
  // surface normally instead of needing a special case.
  await db.exec(`
    ALTER TABLE products ADD COLUMN IF NOT EXISTS price_amount REAL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS currency TEXT DEFAULT 'USD';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS subtotal REAL DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS installments_enabled INTEGER DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS installment_months TEXT DEFAULT '';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS updated_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS updated_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS name_ar TEXT;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS description_ar TEXT;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS category_type TEXT DEFAULT 'consumer';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS name_ar TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS description_ar TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS specs_ar TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS badge_ar TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS condition TEXT DEFAULT 'new';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS images TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS images_trimmed INTEGER DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_quantity INTEGER;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS items_detail TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS items_detail TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS order_id INTEGER REFERENCES orders(id) ON DELETE SET NULL;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_secret TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_enabled INTEGER DEFAULT 0;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor_backup_codes TEXT;
    -- The following block exists because voucher_code/discount_amount/
    -- total_label on orders were added to the base CREATE TABLE
    -- statement above but never given a matching ALTER TABLE migration.
    -- Since orders already existed on the live database before those
    -- columns were introduced, CREATE TABLE IF NOT EXISTS silently
    -- skipped them entirely — the columns were never actually created,
    -- and every order submission failed with "column ... does not exist"
    -- until this was caught. ADD COLUMN IF NOT EXISTS is a safe no-op on
    -- a column that already exists, so this block covers every column
    -- across every long-lived table as a blanket fix for the same risk,
    -- not just the ones that happened to surface as errors first.
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS order_number TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_name TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_email TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_phone TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS client_company TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS items TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'pending';
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS created_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS updated_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS first_name TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS last_name TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS company TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS product_names TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS service TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS message TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'new';
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE quotes ADD COLUMN IF NOT EXISTS created_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE users ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS password TEXT;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS role TEXT DEFAULT 'admin';
    ALTER TABLE users ADD COLUMN IF NOT EXISTS active INTEGER DEFAULT 1;
    ALTER TABLE users ADD COLUMN IF NOT EXISTS created_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS first_name TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS last_name TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS service TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS message TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS status TEXT DEFAULT 'unread';
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS notes TEXT;
    ALTER TABLE messages ADD COLUMN IF NOT EXISTS created_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS slug TEXT;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS icon TEXT;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS sort_order INTEGER DEFAULT 0;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS active INTEGER DEFAULT 1;
    ALTER TABLE categories ADD COLUMN IF NOT EXISTS created_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE products ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS slug TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS category_id INTEGER REFERENCES categories(id);
    ALTER TABLE products ADD COLUMN IF NOT EXISTS brand TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS description TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS specs TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS price TEXT DEFAULT 'Price on Request';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS badge TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS image TEXT;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS featured INTEGER DEFAULT 0;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS active INTEGER DEFAULT 1;
    ALTER TABLE products ADD COLUMN IF NOT EXISTS stock_status TEXT DEFAULT 'available';
    ALTER TABLE products ADD COLUMN IF NOT EXISTS created_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE products ADD COLUMN IF NOT EXISTS updated_at TEXT DEFAULT (datetime('now'));
    -- site_settings.key is that table's actual PRIMARY KEY (special-cased
    -- elsewhere in db/database.js's shim — its INSERTs are never given a
    -- RETURNING id, unlike every other table), so it's deliberately NOT
    -- included here — adding a new primary key column via ALTER TABLE to a
    -- table that may already have rows would be both wrong and unsafe.
    ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS value TEXT;
    ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS label TEXT;
    ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS type TEXT DEFAULT 'text';
    ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS section TEXT DEFAULT 'general';
    ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS updated_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS name TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS email TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS password TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS phone TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS company TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS active INTEGER DEFAULT 1;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS created_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS last_login TEXT;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS code TEXT;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS discount_type TEXT DEFAULT 'percentage';
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS discount_value REAL;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS max_discount_amount REAL;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS max_discount_currency TEXT;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS min_order_amount REAL DEFAULT 0;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS max_uses INTEGER;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS times_used INTEGER DEFAULT 0;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS expires_at TEXT;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS active INTEGER DEFAULT 1;
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS created_at TEXT DEFAULT (datetime('now'));
    ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS updated_at TEXT DEFAULT (datetime('now'));

    ALTER TABLE orders ADD COLUMN IF NOT EXISTS total_label TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS voucher_code TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS discount_amount REAL DEFAULT 0;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS customer_id INTEGER REFERENCES customers(id) ON DELETE SET NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_stage TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_id INTEGER REFERENCES couriers(id) ON DELETE SET NULL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS confirmed_at TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS dispatched_at TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivering_at TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivered_at TEXT;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_lat REAL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_lng REAL;
    ALTER TABLE orders ADD COLUMN IF NOT EXISTS courier_location_at TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS address TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS admin_notes TEXT;
    ALTER TABLE customers ADD COLUMN IF NOT EXISTS google_id TEXT;
    -- Google-only accounts (no password ever set) need this dropped on any
    -- database where the customers table already existed before Google
    -- Sign-In was added — DROP NOT NULL is a safe no-op if already nullable.
    ALTER TABLE customers ALTER COLUMN password DROP NOT NULL;
    ALTER TABLE site_settings ADD COLUMN IF NOT EXISTS value_ar TEXT;
    -- Tracks whether a product has already been checked against the photo
    -- library, regardless of whether a match was found. Without this, a
    -- product with no confident match stays image=NULL forever, which
    -- meant it kept getting re-selected by "WHERE image IS NULL" on every
    -- single batch — the same handful of unmatchable products looping
    -- forever with the "remaining" count never decreasing. This lets that
    -- query exclude already-checked products going forward, so a run
    -- actually terminates once everything's been looked at once.
    ALTER TABLE products ADD COLUMN IF NOT EXISTS library_match_checked INTEGER DEFAULT 0;
  `);

  // Backfill category_type for the categories that were previously
  // hardcoded as "Enterprise IT" in store.html's ENTERPRISE_CATS array —
  // now that's a real column instead of a client-side hardcoded list.
  // Only touches rows still on the 'consumer' default, so it won't
  // overwrite a type an admin has already deliberately changed.
  await db.exec(`
    UPDATE categories SET category_type='enterprise'
    WHERE slug IN ('servers-storage','networking','security','wireless','cloud-software','ups-power')
    AND (category_type IS NULL OR category_type='consumer');
  `);

  // New categories split out of what had become an overly broad
  // "Accessories" catch-all (PC parts, home appliances, audio, mobile
  // accessories, etc. were all landing in one bucket) — ON CONFLICT DO
  // NOTHING makes this safe to re-run on every startup and correctly
  // applies to the live, already-populated database (the categories seed
  // above only ever runs once, on a completely empty database, so simply
  // adding entries there wouldn't have taken effect here).
  await db.exec(`
    INSERT INTO categories (name, slug, description, icon, sort_order, category_type, name_ar) VALUES
      ('Air Conditioners','air-conditioners','Split and window air conditioners','wind',20,'consumer','مكيفات الهواء'),
      ('Smart Watches','smart-watches','Smartwatches and fitness trackers','watch',21,'consumer','الساعات الذكية'),
      ('Home Appliances','home-appliances','Kitchen and home appliances','home',22,'consumer','الأجهزة المنزلية'),
      ('Headphones & Audio','headphones-audio','Headphones, earbuds and speakers','headphones',23,'consumer','سماعات وصوتيات'),
      ('PC Components','pc-components','Cases, coolers, PSUs, motherboards and internal parts','cpu',24,'consumer','مكونات الحاسوب'),
      ('Computer Peripherals','computer-peripherals','Mice, keyboards, webcams and hubs','mouse',25,'consumer','ملحقات الحاسوب'),
      ('Mobile Accessories','mobile-accessories','Cables, chargers, cases and phone accessories','smartphone',26,'consumer','إكسسوارات الموبايل'),
      ('Bags & Sleeves','bags-sleeves','Laptop bags, sleeves and cases','briefcase',27,'consumer','حقائب وأغلفة'),
      ('Televisions','televisions','Smart TVs and displays','tv',28,'consumer','تلفزيونات')
    ON CONFLICT (slug) DO NOTHING;
  `);
  // Backfill for the live database specifically — these 9 categories
  // already exist there (inserted by an earlier deployment of the block
  // above, before it included name_ar at all), so ON CONFLICT DO NOTHING
  // above never touches them. This is why their labels were showing in
  // English even with the site set to Arabic — there was no translation
  // to fall back to. Only fills in name_ar where it's currently empty,
  // so it won't overwrite a manual edit made in the meantime.
  await db.exec(`
    UPDATE categories SET name_ar='مكيفات الهواء' WHERE slug='air-conditioners' AND (name_ar IS NULL OR name_ar='');
    UPDATE categories SET name_ar='الساعات الذكية' WHERE slug='smart-watches' AND (name_ar IS NULL OR name_ar='');
    UPDATE categories SET name_ar='الأجهزة المنزلية' WHERE slug='home-appliances' AND (name_ar IS NULL OR name_ar='');
    UPDATE categories SET name_ar='سماعات وصوتيات' WHERE slug='headphones-audio' AND (name_ar IS NULL OR name_ar='');
    UPDATE categories SET name_ar='مكونات الحاسوب' WHERE slug='pc-components' AND (name_ar IS NULL OR name_ar='');
    UPDATE categories SET name_ar='ملحقات الحاسوب' WHERE slug='computer-peripherals' AND (name_ar IS NULL OR name_ar='');
    UPDATE categories SET name_ar='إكسسوارات الموبايل' WHERE slug='mobile-accessories' AND (name_ar IS NULL OR name_ar='');
    UPDATE categories SET name_ar='حقائب وأغلفة' WHERE slug='bags-sleeves' AND (name_ar IS NULL OR name_ar='');
    UPDATE categories SET name_ar='تلفزيونات' WHERE slug='televisions' AND (name_ar IS NULL OR name_ar='');
  `);

  // One-time cleanup for products already affected by a translation bug —
  // the AI occasionally returned a bare "0" (or similar) instead of a
  // real Arabic name, and it was getting stored as-is (a non-empty string
  // like "0" passed the old validation, which only checked for empty).
  // Now fixed at the source (see isValidTranslatedText in routes/ai.js),
  // but any product already written with this bad value needs resetting
  // back to empty here so the (now-validated) auto-translate cron picks
  // it back up and properly retranslates it, rather than leaving "0"
  // permanently stuck as a product's displayed name in Arabic mode.
  await db.exec(`
    UPDATE products SET name_ar=NULL WHERE name_ar ~ '^[0-9]+$' OR name_ar IN ('0','null','undefined','n/a','none');
  `);

  // DB-01 fix: indexes on the columns that are actually filtered/sorted on
  // in every listing and lookup query (store browsing, admin tables).
  await db.exec(`
    CREATE INDEX IF NOT EXISTS idx_products_category   ON products(category_id);
    CREATE INDEX IF NOT EXISTS idx_products_slug        ON products(slug);
    CREATE INDEX IF NOT EXISTS idx_products_active      ON products(active);
    CREATE INDEX IF NOT EXISTS idx_categories_slug       ON categories(slug);
    CREATE INDEX IF NOT EXISTS idx_orders_status         ON orders(status);
    CREATE INDEX IF NOT EXISTS idx_orders_created_at     ON orders(created_at);
    CREATE INDEX IF NOT EXISTS idx_messages_status       ON messages(status);
    CREATE INDEX IF NOT EXISTS idx_messages_created_at   ON messages(created_at);
    CREATE INDEX IF NOT EXISTS idx_quotes_status         ON quotes(status);
    CREATE INDEX IF NOT EXISTS idx_quotes_created_at     ON quotes(created_at);
    CREATE INDEX IF NOT EXISTS idx_quotes_order_id        ON quotes(order_id);
    CREATE INDEX IF NOT EXISTS idx_visits_created_at      ON page_visits(created_at);
    CREATE INDEX IF NOT EXISTS idx_visits_path            ON page_visits(path);
    CREATE INDEX IF NOT EXISTS idx_visits_visitor_hash    ON page_visits(visitor_hash);
    CREATE INDEX IF NOT EXISTS idx_reviews_product_id      ON reviews(product_id);
    CREATE INDEX IF NOT EXISTS idx_reviews_status          ON reviews(status);
    CREATE INDEX IF NOT EXISTS idx_vouchers_code            ON vouchers(code);
    CREATE INDEX IF NOT EXISTS idx_chat_messages_conv        ON chat_messages(conversation_id);
    CREATE INDEX IF NOT EXISTS idx_chat_conversations_status ON chat_conversations(status);
    CREATE INDEX IF NOT EXISTS idx_activity_log_created_at    ON activity_log(created_at);
    CREATE INDEX IF NOT EXISTS idx_activity_log_admin_id      ON activity_log(admin_id);
    CREATE INDEX IF NOT EXISTS idx_orders_customer_id         ON orders(customer_id);
    CREATE INDEX IF NOT EXISTS idx_orders_courier_id           ON orders(courier_id);
    CREATE INDEX IF NOT EXISTS idx_refund_requests_order_id   ON refund_requests(order_id);
    CREATE INDEX IF NOT EXISTS idx_refund_requests_status     ON refund_requests(status);
  `);

  // Seed admin
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    console.error(
      '⚠️  ADMIN_EMAIL / ADMIN_PASSWORD are not set — skipping admin account creation.\n' +
      '    Locally: check your .env file. On Vercel/Render/Railway: set them in the\n' +
      '    platform\'s dashboard under Environment Variables — a local .env file is\n' +
      '    never deployed. The app will keep running, but no admin login will exist\n' +
      '    until this is fixed and the server is restarted.'
    );
  } else {
    const admin = await db.prepare('SELECT id FROM users WHERE email=?').get(process.env.ADMIN_EMAIL);
    if (!admin) {
      await db.prepare('INSERT INTO users(name,email,password,role) VALUES(?,?,?,?)').run(
        'Super Admin', process.env.ADMIN_EMAIL,
        bcrypt.hashSync(process.env.ADMIN_PASSWORD, 12), 'superadmin'
      );
      console.log('✅ Admin created:', process.env.ADMIN_EMAIL);
    }
  }

  // Seed categories
  const catCount = (await db.prepare('SELECT COUNT(*) as c FROM categories').get()).c;
  if (Number(catCount) === 0) {
    const cats = [
      // Enterprise IT
      ['Servers & Storage','servers-storage','Enterprise servers, NAS, SAN and storage arrays','server',1],
      ['Networking','networking','Switches, routers, SD-WAN and network infrastructure','network',2],
      ['Security','security','Firewalls, endpoint protection and identity management','shield',3],
      ['Wireless','wireless','Wi-Fi 6 and Wi-Fi 6E enterprise access points','wifi',4],
      ['Cloud & Software','cloud-software','Microsoft 365, Azure, AWS and backup solutions','cloud',5],
      ['UPS & Power','ups-power','UPS systems, server racks and power distribution','zap',6],
      // Consumer & Home
      ['Laptops','laptops','Business and personal laptops from top brands','laptop',7],
      ['Desktops & All-in-One','desktops','Desktop computers and all-in-one PCs','monitor',8],
      ['Monitors & Screens','monitors','4K monitors, curved screens and displays','tv',9],
      ['TVs','tvs','Smart TVs, OLED and QLED televisions','tv',10],
      ['Gaming','gaming','Gaming laptops, consoles, accessories and peripherals','gamepad',11],
      ['Accessories','accessories','Keyboards, mice, headsets, webcams and cables','headphones',12],
      ['Printers & Scanners','printers','Laser printers, inkjet and document scanners','printer',13],
      ['Phones & Tablets','phones-tablets','Smartphones, tablets and mobile accessories','smartphone',14],
    ];
    const ins = db.prepare('INSERT INTO categories(name,slug,description,icon,sort_order) VALUES(?,?,?,?,?)');
    for (const c of cats) { await ins.run(...c); }
    console.log('✅ Categories seeded');
  }

  // Seed products
  const prodCount = (await db.prepare('SELECT COUNT(*) as c FROM products').get()).c;
  if (Number(prodCount) === 0) {
    // Pre-fetch every category id into a plain object so getCat() below can
    // stay a synchronous lookup — the products array literal calls
    // getCat('slug') inline ~62 times, and turning that into an async call
    // would have meant restructuring every single product entry.
    const catRows = await db.prepare('SELECT id, slug FROM categories').all();
    const catMap = {};
    catRows.forEach(r => { catMap[r.slug] = r.id; });
    const getCat = (slug) => catMap[slug];
    const ins = db.prepare(`INSERT INTO products
      (name,slug,category_id,brand,description,specs,price,price_amount,currency,badge,featured)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`);

    const products = [
      // ── SERVERS & STORAGE ───────────────────────────────────────────────────
      ['Dell PowerEdge R750','dell-poweredge-r750',getCat('servers-storage'),'Dell',
       '2U rack server for enterprise workloads — virtualization, databases, and cloud-native apps.',
       'Dual Intel Xeon Scalable|Up to 3TB DDR4|24x NVMe drives|iDRAC9|Redundant 800W PSU',
       '$4,299',4299,'USD','New',1],
      ['HP ProLiant DL380 Gen11','hp-proliant-dl380',getCat('servers-storage'),'HP',
       'Versatile 2U server for mixed workloads with HPE iLO management.',
       'Intel Xeon Scalable 4th Gen|Up to 2TB DDR5|HPE iLO 6|PCIe Gen5|Redundant PSU',
       '$3,799',3799,'USD','',1],
      ['Dell EMC PowerStore 500T','dell-emc-powerstore',getCat('servers-storage'),'Dell EMC',
       'All-flash storage array with AI-driven automation for enterprise SAN and NAS.',
       'NVMe-oF ready|Inline dedup & compression|Scale to 4PB|CloudIQ AIOps',
       '$8,500',8500,'USD','Popular',0],
      ['Synology RS3621RPxs','synology-rs3621rpxs',getCat('servers-storage'),'Synology',
       '12-bay 2U NAS for data-intensive environments with hot-swap and redundancy.',
       '12-bay hot-swap|Dual 10GbE SFP+|Redundant PSU|Up to 128GB ECC RAM',
       '$2,199',2199,'USD','',0],

      // ── NETWORKING ──────────────────────────────────────────────────────────
      ['Cisco Catalyst 9300','cisco-catalyst-9300',getCat('networking'),'Cisco',
       'Enterprise stackable access switch with SD-Access and Cisco DNA Center support.',
       '48x PoE+ ports|4x 25G uplinks|StackWise-480|MACsec encryption',
       '$3,200',3200,'USD','Best Seller',1],
      ['Fortinet FortiGate 100F','fortinet-fortigate-100f',getCat('networking'),'Fortinet',
       'NGFW with built-in SD-WAN, IPS, and SSL inspection for mid-size enterprises.',
       '20 Gbps firewall|Built-in SD-WAN|SSL VPN + IPsec|Application control',
       '$2,450',2450,'USD','',1],
      ['Aruba 6300M Switch','aruba-6300m',getCat('networking'),'Aruba',
       'Campus core switch with AIOps and zero-touch provisioning.',
       '48x 1G PoE+|4x 50G uplinks|Aruba Central|VSF stacking',
       '$1,899',1899,'USD','',0],
      ['Cisco ISR 4331 Router','cisco-isr-4331',getCat('networking'),'Cisco',
       'Branch WAN router with SD-WAN and VPN capabilities.',
       '100-300 Mbps throughput|3x GE ports|SD-WAN capable|Cisco IOS XE',
       '$1,299',1299,'USD','',0],

      // ── SECURITY ────────────────────────────────────────────────────────────
      ['Fortinet FortiGate 60F','fortinet-fortigate-60f',getCat('security'),'Fortinet',
       'Compact NGFW for SMBs with full UTM security suite.',
       '10 Gbps firewall|SSL VPN + IPsec|Web filtering|Email security',
       '$895',895,'USD','Recommended',1],
      ['Check Point 3200 Appliance','checkpoint-3200',getCat('security'),'Check Point',
       'Enterprise security gateway with SandBlast zero-day protection.',
       '3.9 Gbps threat prevention|SandBlast AI|ThreatCloud|Centralized mgmt',
       '$3,100',3100,'USD','',0],
      ['CrowdStrike Falcon Endpoint','crowdstrike-falcon',getCat('security'),'CrowdStrike',
       'Cloud-native EDR with AI threat intelligence and 24/7 MDR.',
       'Next-gen antivirus|EDR visibility|Threat hunting|Zero-trust ready',
       '$150/user/yr',150,'USD','',0],

      // ── WIRELESS ────────────────────────────────────────────────────────────
      ['Cisco Catalyst 9136 AP','cisco-ap-9136',getCat('wireless'),'Cisco',
       'Tri-band Wi-Fi 6E AP for high-density enterprise environments.',
       '802.11ax Wi-Fi 6E|9.6 Gbps aggregate|6 GHz band|4x4 MU-MIMO',
       '$799',799,'USD','Wi-Fi 6E',1],
      ['Aruba AP-635','aruba-ap-635',getCat('wireless'),'Aruba',
       'Indoor Wi-Fi 6E AP with IoT radio for enterprise deployments.',
       'Wi-Fi 6E tri-band|BLE 5 + Zigbee|Aruba Central|WPA3',
       '$649',649,'USD','',0],
      ['Ubiquiti UniFi U6 Pro','ubiquiti-u6-pro',getCat('wireless'),'Ubiquiti',
       'Dual-band Wi-Fi 6 AP for high-density office deployments.',
       'Wi-Fi 6 / 802.11ax|300 devices|UniFi Controller|PoE+',
       '$179',179,'USD','',0],

      // ── CLOUD & SOFTWARE ─────────────────────────────────────────────────────
      ['Microsoft 365 Business Premium','m365-business-premium',getCat('cloud-software'),'Microsoft',
       'Full productivity and security suite — per user/month.',
       'All Microsoft 365 Apps|Exchange Online|Teams|Defender|Intune MDM',
       '$22/user/mo',22,'USD','Top Pick',1],
      ['Microsoft Azure Cloud','microsoft-azure',getCat('cloud-software'),'Microsoft',
       'Enterprise cloud infrastructure deployed and managed by InfraConnect.',
       'Compute + storage|Hybrid multi-cloud|Migration support|24/7 monitoring',
       'From $200/mo',200,'USD','',0],
      ['Veeam Backup & Replication','veeam-backup',getCat('cloud-software'),'Veeam',
       'Industry-leading backup and DR for virtual, physical, and cloud workloads.',
       'VM + physical backup|Cloud replication|Ransomware protection|Instant recovery',
       '$499/socket/yr',499,'USD','',0],

      // ── UPS & POWER ──────────────────────────────────────────────────────────
      ['APC Smart-UPS SRT 3000VA','apc-smart-ups-3000',getCat('ups-power'),'APC',
       'Online double-conversion UPS with pure sine wave output.',
       '3000VA / 2700W|Double-conversion|Pure sine wave|Network Card|Hot-swap batteries',
       '$1,199',1199,'USD','Recommended',1],
      ['Eaton 9PX 6000VA','eaton-9px-6000',getCat('ups-power'),'Eaton',
       'High-efficiency online UPS for data center racks.',
       '6000VA / 5400W|99% efficiency|Li-ion option|Eaton IPM software',
       '$2,499',2499,'USD','',0],
      ['APC NetShelter SX 42U','apc-netshelter-42u',getCat('ups-power'),'APC',
       'Industry-standard 42U server rack with cable management.',
       '42U 19" rack|1070mm depth|Perforated doors|1360kg capacity',
       '$899',899,'USD','',0],

      // ── LAPTOPS ──────────────────────────────────────────────────────────────
      ['Apple MacBook Pro 14" M4','macbook-pro-m4',getCat('laptops'),'Apple',
       'The most powerful MacBook Pro ever with M4 chip for professionals and creatives.',
       'Apple M4 Pro chip|16GB/24GB RAM|512GB/1TB SSD|14" Liquid Retina XDR|Up to 22hr battery|MagSafe 3|Thunderbolt 4',
       '$1,999',1999,'USD','New',1],
      ['Apple MacBook Air 13" M3','macbook-air-m3',getCat('laptops'),'Apple',
       'Incredibly thin and light with all-day battery life and M3 performance.',
       'Apple M3 chip|8GB/16GB RAM|256GB/512GB SSD|13.6" Liquid Retina|Up to 18hr battery|MagSafe 3',
       '$1,099',1099,'USD','',1],
      ['Dell XPS 15','dell-xps-15',getCat('laptops'),'Dell',
       'Premium 15.6" laptop with OLED display for creators and professionals.',
       'Intel Core i7-13700H|32GB DDR5|1TB NVMe SSD|15.6" 3.5K OLED Touch|NVIDIA RTX 4060|Windows 11',
       '$1,649',1649,'USD','',1],
      ['Lenovo ThinkPad X1 Carbon Gen 12','thinkpad-x1-carbon',getCat('laptops'),'Lenovo',
       'Ultra-light business laptop with military-grade durability and all-day battery.',
       'Intel Core Ultra 7|32GB LPDDR5|1TB SSD|14" 2.8K OLED|Up to 15hr battery|4G LTE optional|Win 11 Pro',
       '$1,849',1849,'USD','Best Seller',1],
      ['HP Spectre x360 14','hp-spectre-x360',getCat('laptops'),'HP',
       'Premium 2-in-1 convertible with OLED display and HP Wolf Security.',
       'Intel Core Ultra 7|16GB LPDDR5|1TB SSD|14" 2.8K OLED Touch|HP Wolf Security|360° hinge',
       '$1,399',1399,'USD','',0],
      ['ASUS ROG Zephyrus G14','asus-rog-zephyrus-g14',getCat('laptops'),'ASUS',
       'Compact gaming powerhouse with AMD Ryzen 9 and RTX 4070.',
       'AMD Ryzen 9 7940HS|16GB DDR5|1TB NVMe|14" QHD+ 165Hz|NVIDIA RTX 4070|AniMe Matrix display',
       '$1,499',1499,'USD','Gaming',0],
      ['Microsoft Surface Pro 10','surface-pro-10',getCat('laptops'),'Microsoft',
       'The most versatile laptop with detachable keyboard and pen support.',
       'Intel Core Ultra 7|16GB RAM|256GB SSD|13" PixelSense 2K Touch|Windows 11 Pro|5G optional',
       '$1,299',1299,'USD','',0],

      // ── DESKTOPS ─────────────────────────────────────────────────────────────
      ['Apple Mac mini M4','mac-mini-m4',getCat('desktops'),'Apple',
       'Incredibly capable desktop in a tiny footprint powered by Apple M4.',
       'Apple M4 chip|16GB/24GB RAM|256GB-2TB SSD|Thunderbolt 4 x3|HDMI 2.1|Wi-Fi 6E',
       '$599',599,'USD','New',1],
      ['Apple iMac 24" M4','imac-24-m4',getCat('desktops'),'Apple',
       'All-in-one desktop with stunning 4.5K Retina display and M4 chip.',
       'Apple M4 chip|16GB/24GB RAM|256GB-1TB SSD|24" 4.5K Retina|1080p FaceTime HD camera|Magic Keyboard + Mouse',
       '$1,299',1299,'USD','',1],
      ['Dell OptiPlex 7010 Tower','dell-optiplex-7010',getCat('desktops'),'Dell',
       'Business tower desktop built for reliability and easy management.',
       'Intel Core i7-13700|16GB DDR4|512GB SSD|Intel UHD 770|USB-C|Windows 11 Pro',
       '$899',899,'USD','',0],
      ['ASUS ROG Strix G15','asus-rog-strix-tower',getCat('desktops'),'ASUS',
       'High-performance gaming tower with RTX 4080 for extreme gaming.',
       'Intel Core i9-13900K|32GB DDR5|2TB NVMe|NVIDIA RTX 4080|700W PSU|RGB lighting',
       '$2,199',2199,'USD','Gaming',0],

      // ── MONITORS ─────────────────────────────────────────────────────────────
      ['LG 27" 4K UltraFine Display','lg-27-4k-ultrafine',getCat('monitors'),'LG',
       'Stunning 4K IPS display perfect for professionals and creative work.',
       '27" IPS 4K (3840x2160)|USB-C 96W charging|Thunderbolt 3|HDR 400|99% sRGB|Height adjustable',
       '$699',699,'USD','Popular',1],
      ['Samsung 34" Odyssey G8 Curved','samsung-odyssey-g8',getCat('monitors'),'Samsung',
       'Ultra-wide curved gaming monitor with OLED panel and 175Hz refresh rate.',
       '34" OLED 3440x1440|175Hz refresh|0.1ms response|HDR 400|USB-C 90W|Height adjustable',
       '$999',999,'USD','',1],
      ['Dell U2722D 27" USB-C','dell-u2722d',getCat('monitors'),'Dell',
       'Professional 27" 4K monitor with USB-C hub and factory-calibrated colors.',
       '27" IPS 4K|USB-C 90W|HDMI + DP|USB hub|99% sRGB|Factory calibrated|Height + swivel',
       '$549',549,'USD','Best Seller',1],
      ['Apple Pro Display XDR 32"','apple-pro-display-xdr',getCat('monitors'),'Apple',
       'The world\'s best pro display with Extreme Dynamic Range and 6K resolution.',
       '32" 6K Retina (6016x3384)|XDR 1600 nits|P3 wide color|True Tone|Thunderbolt 3|Nano-texture glass option',
       '$4,999',4999,'USD','Pro',0],
      ['ASUS ProArt PA278QV 27"','asus-proart-pa278qv',getCat('monitors'),'ASUS',
       'Professional 27" WQHD monitor with factory calibration and ProArt Preset.',
       '27" IPS 2560x1440|100% sRGB|75Hz|USB hub|Height + swivel + pivot|Eye Care tech',
       '$329',329,'USD','',0],

      // ── TVs ───────────────────────────────────────────────────────────────────
      ['Samsung 65" QLED 4K QN90D','samsung-qn90d-65',getCat('tvs'),'Samsung',
       'Brilliant 4K Neo QLED TV with powerful AI processing and 144Hz gaming.',
       '65" Neo QLED 4K|Quantum Matrix Pro|144Hz for gaming|Dolby Atmos|4x HDMI 2.1|Tizen OS|Anti-glare',
       '$1,499',1499,'USD','Best Seller',1],
      ['LG 55" OLED evo C4','lg-oled-c4-55',getCat('tvs'),'LG',
       'Perfect blacks and infinite contrast with LG\'s award-winning OLED evo panel.',
       '55" OLED evo 4K|α9 AI Processor|120Hz|Dolby Vision IQ|Dolby Atmos|4x HDMI 2.1|webOS 24|Gaming hub',
       '$1,299',1299,'USD','Award Winner',1],
      ['Sony 75" Bravia XR X90L','sony-bravia-xr-75',getCat('tvs'),'Sony',
       'Google TV with cognitive processor XR for lifelike picture and sound.',
       '75" 4K Full Array LED|XR Contrast Booster|120Hz|Dolby Vision|Dolby Atmos|HDMI 2.1|Google TV|Works with Alexa',
       '$1,799',1799,'USD','',1],
      ['TCL 50" 4K QLED S5',  'tcl-50-qled-s5',getCat('tvs'),'TCL',
       'Affordable QLED 4K TV with Google TV and Dolby Vision for everyday viewing.',
       '50" QLED 4K|60Hz|Dolby Vision|DTS Virtual:X|Google TV|2x HDMI|AirPlay 2|Chromecast built-in',
       '$399',399,'USD','Value Pick',0],
      ['Samsung 85" Crystal UHD 4K','samsung-crystal-85',getCat('tvs'),'Samsung',
       'Massive 85" 4K screen for large living rooms and home theaters.',
       '85" 4K Crystal UHD|Crystal Processor 4K|60Hz|HDR|PurColor|Tizen OS|3x HDMI|Solar remote',
       '$1,199',1199,'USD','',0],

      // ── GAMING ───────────────────────────────────────────────────────────────
      ['Sony PlayStation 5 Slim','ps5-slim',getCat('gaming'),'Sony',
       'The slim version of the world\'s best-selling next-gen gaming console.',
       'AMD Ryzen Zen 2 CPU|10.28 TFLOPS GPU|825GB SSD|4K 120fps|Ray tracing|DualSense controller|Blu-ray',
       '$449',449,'USD','Hot',1],
      ['Microsoft Xbox Series X','xbox-series-x',getCat('gaming'),'Microsoft',
       'The most powerful Xbox ever with 4K gaming and Xbox Game Pass.',
       'AMD Zen 2 CPU|12 TFLOPS GPU|1TB NVMe SSD|4K 120fps|Ray tracing|DirectX 12 Ultimate|Quick Resume',
       '$499',499,'USD','',1],
      ['Nintendo Switch OLED','nintendo-switch-oled',getCat('gaming'),'Nintendo',
       'Enhanced Switch with vibrant OLED screen for gaming anywhere.',
       '7" OLED touchscreen|Adjustable stand|64GB storage|Wired LAN port|White/Neon colors|TV & handheld mode',
       '$349',349,'USD','',0],
      ['ASUS ROG Ally X Gaming Handheld','asus-rog-ally-x',getCat('gaming'),'ASUS',
       'Windows gaming handheld with AMD Z1 Extreme for PC gaming on the go.',
       'AMD Ryzen Z1 Extreme|24GB LPDDR5|1TB SSD|7" FHD 120Hz|Windows 11|XG Mobile compatible',
       '$899',899,'USD','New',0],
      ['Razer BlackShark V2 Pro Headset','razer-blackshark-v2-pro',getCat('gaming'),'Razer',
       'Pro wireless gaming headset with THX Spatial Audio for competitive gaming.',
       '50mm TriForce drivers|THX Spatial Audio|Noise-cancelling mic|Bluetooth + 2.4GHz|70hr battery',
       '$149',149,'USD','',0],
      ['Logitech G Pro X Superlight 2','logitech-g-pro-superlight',getCat('gaming'),'Logitech',
       'Ultra-lightweight pro gaming mouse used by esports pros worldwide.',
       'HERO 2 25K sensor|32000 DPI|Lightspeed wireless|51g weight|90hr battery|5 programmable buttons',
       '$159',159,'USD','Pro Choice',0],

      // ── ACCESSORIES ──────────────────────────────────────────────────────────
      ['Apple AirPods Pro 2nd Gen','airpods-pro-2',getCat('accessories'),'Apple',
       'The best wireless earbuds with Active Noise Cancellation and Adaptive Audio.',
       'Active Noise Cancellation|Transparency mode|Adaptive Audio|H2 chip|6hr ANC battery|MagSafe case',
       '$249',249,'USD','Best Seller',1],
      ['Sony WH-1000XM5 Headphones','sony-wh-1000xm5',getCat('accessories'),'Sony',
       'Industry-leading noise cancelling headphones with 30-hour battery.',
       'Industry-best ANC|30hr battery|Quick Charge (3min=3hr)|LDAC|Multipoint connection|Foldable',
       '$349',349,'USD','Award Winner',1],
      ['Logitech MX Keys S Keyboard','logitech-mx-keys-s',getCat('accessories'),'Logitech',
       'Advanced wireless keyboard with perfect typing experience for professionals.',
       'Backlit spherical keys|Bluetooth + Logi Bolt|3 device pairing|10 day battery|Quiet typing|Mac & Windows',
       '$109',109,'USD','',0],
      ['Logitech MX Master 3S Mouse','logitech-mx-master-3s',getCat('accessories'),'Logitech',
       'The most advanced mouse for creatives and professionals.',
       '8K DPI MagSpeed scroll|Quiet clicks|Bluetooth + USB-C|70 day battery|3 device pairing|Ergonomic',
       '$99',99,'USD','',1],
      ['Anker 10-in-1 USB-C Hub','anker-usb-c-hub',getCat('accessories'),'Anker',
       'Expand your laptop ports with 10 connections in one compact hub.',
       '4K HDMI|100W Power Delivery|USB-C 3.2|4x USB-A|SD & microSD|Gigabit Ethernet|3.5mm audio',
       '$59',59,'USD','',0],
      ['Jabra Evolve2 85 Headset','jabra-evolve2-85',getCat('accessories'),'Jabra',
       'Professional wireless headset with world-class ANC for office and remote work.',
       '10-mic ANC|37hr battery|Jabra Advanced ANC|USB-A/C|Teams & Zoom certified|Busy light',
       '$379',379,'USD','',0],
      ['Webcam Logitech Brio 4K','logitech-brio-4k',getCat('accessories'),'Logitech',
       'Ultra HD 4K webcam with HDR and Windows Hello for video conferencing.',
       '4K 30fps / 1080p 60fps|HDR|5x digital zoom|Windows Hello|USB-C|AI field of view|Privacy shutter',
       '$199',199,'USD','',0],
      ['Dell 65W USB-C Adapter','dell-65w-usb-c',getCat('accessories'),'Dell',
       'Compact USB-C power adapter for Dell laptops and other USB-C devices.',
       '65W USB-C|GaN technology|Compact design|Universal compatibility|LED indicator',
       '$49',49,'USD','',0],

      // ── PRINTERS ─────────────────────────────────────────────────────────────
      ['HP LaserJet Pro M404n','hp-laserjet-m404n',getCat('printers'),'HP',
       'Fast mono laser printer for small businesses with 40ppm print speed.',
       '40ppm mono|Up to 1200 DPI|250-sheet tray|USB + Ethernet|HP JetIntelligence|Duty cycle 80K/mo',
       '$279',279,'USD','Best Seller',1],
      ['Canon PIXMA G7020 MegaTank','canon-pixma-g7020',getCat('printers'),'Canon',
       'Wireless all-in-one inkjet with supertank for ultra-low-cost printing.',
       'Print/Copy/Scan/Fax|Wi-Fi + USB|Auto Duplex|3 year ink supply|6000 B&W / 7700 color pages|Airprint',
       '$349',349,'USD','',0],
      ['Brother MFC-L8905CDW Color Laser','brother-mfc-l8905cdw',getCat('printers'),'Brother',
       'Professional color laser all-in-one for medium workgroups.',
       '33ppm color|Duplex print/scan|Wi-Fi + Ethernet|2-sided scan|NFC|Touchscreen|250-sheet tray',
       '$499',499,'USD','',0],

      // ── PHONES & TABLETS ─────────────────────────────────────────────────────
      ['Apple iPhone 16 Pro 256GB','iphone-16-pro',getCat('phones-tablets'),'Apple',
       'The most advanced iPhone with A18 Pro chip and 4K 120fps ProRes video.',
       'A18 Pro chip|48MP Main camera|4K 120fps ProRes video|6.3" Super Retina XDR|Action Button|USB-C 3|Face ID',
       '$999',999,'USD','New',1],
      ['Samsung Galaxy S25 Ultra','samsung-s25-ultra',getCat('phones-tablets'),'Samsung',
       'The ultimate Galaxy with built-in S Pen and Galaxy AI features.',
       'Snapdragon 8 Elite|200MP camera|S Pen built-in|6.9" Dynamic AMOLED 2X|5000mAh|Galaxy AI|5G',
       '$1,299',1299,'USD','',1],
      ['Apple iPad Pro 13" M4','ipad-pro-m4',getCat('phones-tablets'),'Apple',
       'The thinnest Apple product ever with M4 chip and Ultra Retina XDR display.',
       'Apple M4 chip|13" Ultra Retina XDR OLED|8GB/16GB RAM|256GB-2TB|Apple Pencil Pro|Nano-texture glass',
       '$1,299',1299,'USD','New',1],
      ['Samsung Galaxy Tab S10+','samsung-tab-s10-plus',getCat('phones-tablets'),'Samsung',
       'Premium Android tablet with S Pen for productivity and creativity.',
       '12.4" Dynamic AMOLED 2X|Snapdragon 8 Gen 3|12GB RAM|256GB/512GB|S Pen included|DeX mode|Wi-Fi 7',
       '$999',999,'USD','',0],
    ];

    for (const p of products) { await ins.run(...p); }
    console.log(`✅ ${products.length} products seeded`);
  }

  // ── Arabic translation backfill (categories & products) ────────────────
  // Runs every startup (not just on first seed) so it also fills in
  // translations for databases that already existed before this feature
  // was added. Only fills empty fields — never overwrites a translation an
  // admin has already edited by hand in the admin panel. (site_settings
  // translations are backfilled separately in routes/site.js, since that
  // table isn't seeded until seedDefaultSettings() runs after this file.)
  const { categoryTranslations, productTranslations } = require('./translations-ar');
  const updCat = db.prepare("UPDATE categories SET name_ar=?, description_ar=? WHERE slug=? AND (name_ar IS NULL OR name_ar='')");
  for (const [slug, t] of Object.entries(categoryTranslations)) { await updCat.run(t.name, t.description, slug); }
  const updProd = db.prepare("UPDATE products SET name_ar=?, description_ar=?, specs_ar=?, badge_ar=? WHERE slug=? AND (name_ar IS NULL OR name_ar='')");
  for (const [slug, t] of Object.entries(productTranslations)) { await updProd.run(t.name, t.description, t.specs, t.badge || '', slug); }
  console.log('✅ Arabic translations backfilled (categories & products)');

  console.log('✅ Database ready');
  return db;
}

module.exports = { getDb, initDb };
