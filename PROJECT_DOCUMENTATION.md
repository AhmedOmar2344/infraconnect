# InfraConnect — Full Project Documentation

**Live site:** [infraconnect24-7.com](https://infraconnect24-7.com)
**GitHub:** `github.com/AhmedOmar2344/infraconnect`
**Hosting:** Vercel (serverless functions + Vercel Blob for images)
**Database:** Neon (serverless Postgres)

A full-stack IT infrastructure and electronics e-commerce platform serving Egypt and the UAE, with a bilingual (English/Arabic, RTL-aware) storefront and a comprehensive admin dashboard built for managing a large, actively-growing product catalog (currently several thousand products across enterprise IT and consumer electronics).

---

## 1. Tech Stack

| Layer | Technology |
|---|---|
| Backend | Node.js + Express |
| Database | Neon Postgres, accessed through a custom compatibility shim (`db/database.js`) that mimics the `better-sqlite3` API (`.prepare().get()/.all()/.run()`) over async Postgres — this exists because the project started on SQLite and migrated without rewriting every query |
| Frontend | Vanilla JS, no framework — server-rendered HTML pages with client-side fetch-based interactivity |
| Image hosting | Vercel Blob (Vercel's filesystem is read-only in production, so **all** file writes, product photos included, go through Blob storage, never local disk) |
| Image processing | Jimp (pure JavaScript — native modules like `sharp` don't work on Vercel's serverless runtime) |
| Auth | JWT (admin, customer, and courier each have separate token types and middleware) |
| Admin dashboard | Single-page app within `public/admin/index.html` — one large file, section-based navigation, no build step |

---

## 2. Architecture Notes (read before making changes)

- **Vercel's filesystem is read-only in production.** Never write to local disk for anything user-facing — always use Vercel Blob (`lib/blobStorage.js`).
- **The DB shim auto-converts SQLite-style syntax** (`?` placeholders → Postgres `$N`, `datetime('now')` → `CURRENT_TIMESTAMP`) — when adding new queries, stick to this style rather than writing raw Postgres syntax, to stay consistent with the rest of the codebase.
- **Known bug class:** column count / placeholder count mismatches in raw SQL `INSERT` strings. Always verify these programmatically (count columns vs. count of `?` vs. count of bound arguments) before shipping a new query — this has caused real bugs multiple times in this project's history.
- **Migrations are idempotent and run on every server startup**, not just once. New columns use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`; new categories/seed data use `ON CONFLICT DO NOTHING`. The one-time category/product *seed* (in `db/database.js`) only runs if the `categories`/`products` tables are completely empty — it will **not** pick up new entries added to that seed list on an already-populated (i.e. live) database. Any change meant to reach the live site must be a proper migration below the seed block, not an edit to the seed list itself.
- **`trust proxy` is set to `1`** in `server.js` — required for `express-rate-limit` to correctly identify real client IPs behind Vercel's own proxy layer.
- **Rate limiting is deliberately three-tiered**, not one blanket limit:
  - General site traffic (public store + most admin pages): very high ceiling, not meant to shape normal traffic — see the comment in `server.js` for the history of why this kept needing to be raised (auto-refresh polling + multiple open admin tabs is legitimate, high-volume traffic, not abuse).
  - `/api/ai/*` (AI Product Creator, translate, find-images): separate, high limit — long batch jobs fire many sequential requests.
  - `/api/bulk/*` (bulk sheet import, photo library uploads): separate, high limit — same reasoning.
  - `/api/auth/*` login endpoints: kept deliberately tight (10/15min) — this is real abuse protection, unlike the others.
- **CSRF/XSS:** all admin-rendered HTML uses `escHtml()` before interpolating user-provided strings. SQL is parameterized throughout — no known injection points.

---

## 3. Environment Variables

See `.env.example` in the repo root for the full, currently-accurate list with inline comments. Grouped summary:

| Group | Variables |
|---|---|
| Database | `DATABASE_URL` |
| Auth | `JWT_SECRET`, `ADMIN_EMAIL`, `ADMIN_PASSWORD` |
| Email | `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `SMTP_FROM`, `NOTIFY_EMAIL` |
| File storage | `BLOB_READ_WRITE_TOKEN` (Vercel Blob) |
| Security | `CREDENTIALS_ENCRYPTION_KEY` (64-char hex — encrypts the API Console's stored third-party keys; generate with `node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`) |
| Scheduled jobs | `CRON_SECRET` |
| CORS | `CORS_ORIGINS` (optional — the production domain and any `*.vercel.app` preview URL work without this) |
| Google Sign-In | `GOOGLE_CLIENT_ID` (optional — can also be set through the admin API Console instead) |
| AI providers | `GEMINI_API_KEY`, `GROQ_API_KEY`, `BAZAAR_API_KEY`, `OPENAI_API_KEY`, and two unusually-named ones kept for backward compatibility: `Infraconnect` (DeepSeek's key) and `GLM-4.7` (GLM's key, read via bracket notation `process.env['GLM-4.7']` since the name isn't a valid JS identifier) |
| Search (for providers without native web search) | `TAVILY_API_KEY` |

Every AI provider key can *also* be set through **Admin → API Console** instead of an environment variable — stored encrypted at rest (AES-256-GCM), takes effect immediately with no redeploy. The API Console is checked first; the environment variable is the fallback.

**Never commit `.env`.** It's gitignored. If a real secret ever leaks into git history, rotate it and scrub the history (`git filter-repo` or BFG), not just delete it in a later commit.

---

## 4. Public-Facing Site

| Page | Purpose |
|---|---|
| `/` (`index.html`) | Homepage — hero, category showcase grid (pulled live from the categories table, including product counts), services overview, projects/portfolio section, contact form |
| `/store` | Full product catalog — sidebar category filters (split into Enterprise IT and Consumer & Home sections), search, sort, grid/list view toggle |
| `/product?slug=...` | Single product detail page |
| `/cart`, `/checkout` | Cart and checkout flow |
| `/account` | Customer login/signup (including Google Sign-In), order history, order tracking, refund requests |
| `/courier` | Courier-only login and delivery management (strictly separate from admin access) |
| `/about`, `/services`, `/projects`, `/contact` | Standard marketing/informational pages |
| `/terms`, `/privacy` | Legal pages |

**Bilingual support:** every customer-facing page supports English and Arabic (full RTL layout switch, not just translated strings) via `js/i18n.js` and a `العربية` toggle in the nav. Product data has parallel `_ar` fields (`name_ar`, `description_ar`, `specs_ar`, `badge_ar`) throughout.

**Store search and filtering are fully server-side** (not client-side array filtering) — this matters because the catalog is large enough (thousands of products) that loading everything into the browser and filtering locally was a real, previously-shipped bug (a category could show zero results if its products weren't in whatever fixed batch had been loaded). Category, search, and sort (`price-asc`, `price-desc`, `name`, `featured`) are all query parameters sent to `GET /api/products`, and results are paginated with a "Load More" button rather than fetched all at once.

**Store grid:** 5 products per row on desktop, stepping down through 3 (tablets/small laptops), 2 (phones and small tablets), matching standard mobile e-commerce conventions rather than a single oversized card per screen.

---

## 5. Admin Dashboard (`/admin`)

A single large SPA (`public/admin/index.html`) with section-based client-side navigation (no page reloads between sections). Sections live in the left sidebar, grouped as: Overview, Website Content, Store, CRM, Settings.

### 5.1 Products & Catalog Management

- Full CRUD for products, with **bulk selection** (checkboxes, including a genuine "select all N matching" — not just the currently-loaded page — via `GET /api/products/admin/all-ids`)
- Bulk actions on selected products: delete, AI-translate to Arabic, AI-find-images, assign images from the photo library
- Site-wide bulk action: **Remove All Badges** (clears the "New"/"Best Seller"-style badge field across the whole catalog in one action)
- Category management, including a **9-way split** of what had become an overly broad "Accessories" catch-all — see §5.5

### 5.2 AI Product Creator

Generates full product listings (name, description, specs, pricing, category guess, Arabic translation, and a product image) from just a product name or description, using **six selectable AI providers**:

| Provider | Model | Web search | Notes |
|---|---|---|---|
| Gemini | `gemini-3.5-flash` (auto-falls back to `gemini-flash-latest` if that model name ever stops being recognized) | Native (Google Search grounding) | |
| Groq | `groq/compound` | Native, server-side, automatic | **Recommended default** — genuinely free ongoing tier, no card required, no balance to run out |
| GLM | `glm-4.7` (via Z.ai) | Native | |
| DeepSeek | `deepseek-v4-flash` | Via Tavily (function calling) | Requires a Tavily key in addition to the DeepSeek key |
| Bazaar | `auto:free` (via bazaarlink.ai, an OpenAI-compatible multi-model gateway) | Via Tavily | |
| ChatGPT | OpenAI, current model with an automatic fallback to `gpt-4o-mini` if the primary name is ever deprecated | Via Tavily | **Paid — no free tier**, unlike the other five |

Available as both **Single Product** (one at a time, full review before saving) and **Bulk Generate** (up to 50 at once, with adjustable AI-call concurrency per provider).

All provider calls happen server-side (`routes/ai.js`) — API keys are never exposed to the browser.

### 5.3 Bulk Sheet Upload (`routes/bulk.js`)

Upload an Excel (`.xlsx`) or CSV file to insert/update many products at once, matched by name → slug (existing slug = update, new = insert).

**Architecture note — why this is batched, not one request:** an early version tried to process an entire large sheet (and any accompanying photos) in a single request, which repeatedly hit two different failure modes at scale: Vercel's serverless function execution time limit (processing hundreds of photos took longer than the platform allows a single request to run), and Vercel's platform-level function invocation rate limit (a distinct thing from this app's own rate limiting, and not something raising this app's limits can fix). The current flow is three separate steps, each staying comfortably within those limits:

1. **`POST /api/bulk/parse-sheet`** — parses the file, returns every row as JSON. Fast, no photo processing, no database writes.
2. **`POST /api/bulk/photo-library/upload`** (only if photo files are provided) — processes photos in small batches (15 at a time, with a short pacing delay between batches).
3. **`POST /api/bulk/import-rows-batch`** — the frontend loops this in small batches (25 rows at a time) until the whole sheet is processed. Each batch is a real, complete database write — the admin UI refreshes the visible product list after every batch, so products genuinely appear incrementally rather than only at 100%.

**Template columns:** `name | category_slug | brand | description | specs | price_label | price_amount | currency | badge | image_url | gallery_urls | name_ar | description_ar | specs_ar | badge_ar | featured | stock_status | installments_enabled | installment_months`

**`image_url` / `gallery_urls`** accept either a full `https://` URL (downloaded server-side) **or** a filename matching one of the photos uploaded in the same batch (see the Photo Library below) — URLs and filenames can be freely mixed in the same sheet.

### 5.4 Photo Library

A persistent, reusable image library (`photo_library` table: filename → permanent Blob URL), built specifically so the same photo file never needs re-uploading across multiple sheet imports.

- **Admin → Store → Photo Library**: upload photos (single or bulk), browse as a searchable gallery, remove entries
- Bulk sheet imports check this library automatically by filename before falling back to a fresh upload — genuinely new files only
- **Products page**: "Find Images from Library" (selected products) and "Find All Images from Library" (site-wide, batched/resumable) fuzzy-match product names against library filenames and assign confident matches automatically. Matching is deliberately conservative — it requires either a shared, distinctive model-number-like token, or a shared brand name plus several other shared words, before accepting a match. A product left without a photo is treated as a much smaller problem than a product silently showing the wrong one.
- **Edit Product modal**: "Choose from Library" opens the same searchable picker directly, for assigning one photo to one product by hand

A `library_match_checked` flag on each product prevents products with no confident match from being endlessly re-selected in every future "Find All" run (an actual bug that shipped and was fixed: without this flag, an unmatched product's `image` stays `NULL` forever, which meant it re-qualified for "missing an image" on every single batch, making the run never terminate).

### 5.5 Categories — the Accessories Split

The original 14-category seed included one broad "Accessories" catch-all. As the catalog grew (particularly after a large distributor bulk import), this became genuinely too broad — PC components, home appliances, headphones, mobile accessories, and more were all landing in one bucket. Nine new categories were split out via keyword-based reclassification of the existing catalog:

`air-conditioners`, `smart-watches`, `home-appliances`, `headphones-audio`, `pc-components`, `computer-peripherals`, `mobile-accessories`, `bags-sleeves`, `televisions`

Added as an idempotent migration (`ON CONFLICT (slug) DO NOTHING`) rather than an edit to the one-time seed list, since the seed only runs on a completely empty database and would never have applied to the live one.

**Known follow-up item:** the original seed already included a `tvs` category (0 products) which is now redundant with the newly added `televisions` category (a handful of products) — these haven't been merged, since doing so wasn't explicitly requested and could affect existing links/bookmarks to either slug.

### 5.6 Other Admin Sections

- **Site Editor, Pages, Navigation, Media & Logos** — content management for the marketing site
- **Reviews & Ratings, Vouchers & Discounts**
- **CRM:** Service Requests, Messages (with a bilingual live chat widget on the storefront), Quotes, Orders, Chat Support, Customers, Refund Requests, Couriers (including live GPS delivery tracking and load-balanced auto-assignment)
- **Company Info, SEO Settings, Admin Users** (3-tier role system: poweruser → admin → superadmin), **API Console** (encrypted third-party credential vault), **Activity Log**

---

## 6. Customer Accounts

- Email/password signup, plus **Google Sign-In** (`google.accounts.id`, explicitly forced to `ux_mode: 'popup'` — without this, the library can silently fall back to a full-page redirect flow that has nowhere configured to redirect back to, stranding the user on Google's own domain; this also requires the server to send `Cross-Origin-Opener-Policy: same-origin-allow-popups`, without which the popup opens but can never report its result back to the page)
- 4-tab dashboard: Profile, Orders, Order Tracking (live courier GPS + 4-step progress), Refund Requests
- Checkout requires an account; auto-fills from the saved profile

---

## 7. Deploy Process

1. `git add . && git commit -m "..." && git push`
2. Vercel auto-deploys on push to the connected branch
3. For **environment variable** changes specifically, also manually trigger a **Redeploy** from the Vercel dashboard — env var changes don't apply to already-running deployments otherwise

---

## 8. Known Limitations / Things Worth Revisiting

- The redundant `tvs` / `televisions` category pair (§5.5) hasn't been merged
- Photo library matching (§5.4) is deliberately conservative — some products that a human would obviously match will be left unmatched rather than risk a wrong guess; this trade-off was made intentionally, but a human review pass on "no confident match" results will still find real matches a stricter algorithm missed
- ChatGPT is the only AI provider with no free tier — treat it as an occasional-use option, not a default, given the other five cover free-tier needs
