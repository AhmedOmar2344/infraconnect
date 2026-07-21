/**
 * ═══════════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Main Server Entry Point
 *  File: server.js
 * ═══════════════════════════════════════════════════════════════════════════════
 *
 *  WHAT THIS FILE DOES:
 *  - Starts the Express web server on port 3000 (or PORT env variable)
 *  - Loads all middleware (security headers, CORS, rate limiting, JSON parsing)
 *  - Registers all API routes under /api/...
 *  - Serves the frontend HTML files for all pages
 *  - Initialises the Neon Postgres database on startup
 *
 *  HOW TO RUN:
 *    Development:  npm run dev      (auto-restarts on file change via nodemon)
 *    Production:   npm start        (plain node, no auto-restart)
 *
 *  ENVIRONMENT VARIABLES (set in .env file):
 *    PORT              - HTTP port (default: 3000)
 *    JWT_SECRET        - Secret key for JSON Web Token signing (CHANGE IN PRODUCTION)
 *    ADMIN_EMAIL       - First admin user email created on first run
 *    ADMIN_PASSWORD    - First admin user password created on first run
 *    DATABASE_URL      - Neon Postgres connection string
 *    SMTP_HOST/PORT    - Email server settings for contact form notifications
 *    SMTP_USER/PASS    - Email credentials
 *    NOTIFY_EMAIL      - Where to send contact form notification emails
 *
 *  API ROUTES REGISTERED:
 *    /api/auth         → routes/auth.js        (login, logout, change password)
 *    /api/products     → routes/products.js    (product & category CRUD)
 *    /api/contact      → routes/contact.js     (contact form, quote requests)
 *    /api/orders       → routes/orders.js      (order management)
 *    /api/dashboard    → routes/dashboard.js   (stats, admin users)
 *    /api/site         → routes/site.js        (website content settings)
 *    /api/bulk         → routes/bulk.js        (Excel bulk product upload)
 *
 *  PAGE ROUTES (serve HTML files):
 *    /                 → public/index.html          (homepage)
 *    /store            → public/store.html          (product store)
 *    /product          → public/product.html        (single product detail)
 *    /cart             → public/cart.html           (shopping cart)
 *    /checkout         → public/checkout.html       (checkout form)
 *    /confirmation     → public/confirmation.html   (order confirmation)
 *    /request-service  → public/request-service.html
 *    /admin            → public/admin/index.html    (admin dashboard SPA)
 *
 * ═══════════════════════════════════════════════════════════════════════════════
 */
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const path = require('path');
const { initDb } = require('./db/database');

const app = express();
const PORT = process.env.PORT || 3000;

// Vercel sits in front of this app as a single reverse proxy layer,
// adding an X-Forwarded-For header with the visitor's real IP on every
// request. Express doesn't trust that header by default — without this,
// express-rate-limit falls back to seeing every single visitor as coming
// from the same proxy IP, which means either everyone shares one rate
// limit bucket (one busy visitor locks out everyone else) or per-IP
// limiting silently does nothing at all. `1` means "trust exactly one
// hop" — matching Vercel's architecture specifically, not a blanket
// "trust every proxy" setting, which would let a client fake their own
// IP by sending their own X-Forwarded-For header.
app.set('trust proxy', 1);

// BE-06 fix: a real CSP instead of disabling the header outright. Adjust
// the source lists if you add a CDN, external fonts, or a payment widget.
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      // Inline <style>/<script> blocks AND inline onclick="..." handlers
      // are used throughout the current frontend (see ARCH-03 in the
      // audit) — 'unsafe-inline' is required for those to keep working.
      // IMPORTANT: helmet has a separate stricter default for inline
      // event-handler attributes (script-src-attr, defaults to 'none')
      // that is NOT covered by scriptSrc alone — it must be set
      // explicitly or every onclick="..." in the app silently stops
      // working, which is exactly what happened here.
      styleSrc: ["'self'", "'unsafe-inline'"],
      // accounts.google.com serves the Google Sign-In script; maps.googleapis.com
      // serves the Google Maps JS SDK (delivery tracking map). Without
      // these, the browser's OWN security policy blocks both scripts from
      // loading at all — this looks exactly like a network failure or an
      // ad-blocker, but is actually this server telling the browser to
      // refuse them.
      scriptSrc: ["'self'", "'unsafe-inline'", "https://accounts.google.com", "https://maps.googleapis.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      imgSrc: ["'self'", "data:", "https:"],
      // Google Sign-In's script makes its own API calls back to Google
      // after loading, and Maps does the same for tile/place data —
      // connectSrc has to allow those too, not just the initial script tag.
      connectSrc: ["'self'", "https://accounts.google.com", "https://maps.googleapis.com"],
      // Google Sign-In's button click opens Google's own account picker in
      // an iframe — blocked by default (frameSrc isn't set here, so it
      // inherits defaultSrc: 'self') without this.
      frameSrc: ["https://accounts.google.com"],
      fontSrc: ["'self'", "https:", "data:"],
      objectSrc: ["'none'"],
      frameAncestors: ["'self'"]
    }
  },
  // Without this, helmet's default (same-origin) blocks the Google Sign-In
  // popup from ever communicating its result back to this page — the
  // popup opens, loads Google's page, but the window.postMessage-style
  // handoff back to the opener is silently blocked by the browser's own
  // cross-origin isolation, leaving the popup permanently blank/frozen.
  // This is Google's own documented requirement for their popup-based
  // flow specifically (developers.google.com/identity/gsi/web/guides/setup),
  // not a general relaxation — it still isolates from other origins,
  // it just permits this one specific opener/popup relationship.
  crossOriginOpenerPolicy: { policy: 'same-origin-allow-popups' }
}));
// Google's Sign-In library now requires the browser's FedCM API as of a
// mandatory migration in August 2025 (previously optional) — this is a
// SEPARATE browser permission system from CSP above, controlling access
// to navigator.credentials.get(). Browsers default this to 'self' already,
// but setting it explicitly removes any ambiguity — a click that appeared
// to hang indefinitely (no error, no progress) after picking a Google
// account, rather than a clean failure, is the exact symptom of this
// permission being unavailable.
app.use((req, res, next) => {
  res.setHeader('Permissions-Policy', 'identity-credentials-get=(self "https://accounts.google.com")');
  next();
});
// SEC-04 fix: '*' + credentials:true is a combination browsers reject
// outright, and signals no real origin policy. Restrict to an explicit
// allowlist. CORS_ORIGINS isn't a secret (it's just a list of allowed
// domains), so a real default is hardcoded here rather than requiring a
// dashboard env var — set CORS_ORIGINS to override/extend this if you add
// a custom domain or another deployment.
const DEFAULT_ORIGINS = [
  `http://localhost:${PORT}`,
  'https://infraconnect24-7.com',
  'https://www.infraconnect24-7.com'
];
// Vercel auto-generates several working aliases per project (team-scoped,
// git-branch, per-deployment hash, etc.) — e.g. infraconnect-ruby.vercel.app
// and infraconnect-omara4642-4972s-projects.vercel.app both point at the
// same code. Hardcoding each one as it's discovered doesn't scale, so any
// *.vercel.app subdomain starting with "infraconnect" is allowed by pattern
// instead. The real custom domain and localhost are still exact-matched.
const VERCEL_PREVIEW_PATTERN = /^https:\/\/infraconnect[a-z0-9-]*\.vercel\.app$/;

function isAllowedOrigin(origin) {
  if (allowedOrigins.includes(origin)) return true;
  if (VERCEL_PREVIEW_PATTERN.test(origin)) return true;
  return false;
}

// CORS_ORIGINS (if set) ADDS to the hardcoded defaults rather than
// replacing them, so a stale/incomplete value in the Vercel dashboard can't
// silently block domains that are already hardcoded here.
const allowedOrigins = process.env.CORS_ORIGINS
  ? [...new Set([...DEFAULT_ORIGINS, ...process.env.CORS_ORIGINS.split(',').map(s => s.trim())])]
  : DEFAULT_ORIGINS;
app.use(cors({
  origin: (origin, cb) => {
    if (!origin || isAllowedOrigin(origin)) cb(null, true);
    else {
      console.error(`[CORS] Rejected origin "${origin}" — allowed: ${allowedOrigins.join(', ')} (+ infraconnect*.vercel.app)`);
      cb(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
// The AI routes (bulk translate, bulk find-images, bulk generate) are
// admin-only and authenticated, but they legitimately fire many sequential
// requests during a long-running batch job across a large catalog — the
// general limit below is sized for normal browsing traffic and
// was getting hit mid-batch, which then blocked the admin's OTHER actions
// too (same IP, same shared budget) until the window reset. Skipped here
// and given its own separate, higher limit instead — still bounded (abuse
// protection isn't removed), just sized for what this admin tool actually
// needs to do.
//
// The general limit itself was also raised from its original 200/15min —
// that number was sized for light public browsing, but this admin panel
// polls several pages every 15 seconds (ADMIN_AUTO_REFRESH_PAGES) and is
// often used with multiple tabs open at once, both of which are entirely
// normal use that can add up past 200 requests well before any real abuse
// pattern — confirmed by "Too many requests" appearing on nothing more
// than loading the admin panel itself. Upgrading the Vercel plan doesn't
// touch this at all — this ceiling is set entirely in this app's own code,
// unrelated to Vercel's own infrastructure-level limits.
app.use(rateLimit({
  windowMs: 15 * 60 * 1000, max: 1000000, // effectively unlimited — kept as a very high finite cap rather than no limiter at all, purely as a backstop against a genuine runaway bug, not for shaping normal traffic
  skip: (req) => req.path.startsWith('/api/ai/') || req.path.startsWith('/api/bulk/'),
}));
const aiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20000,
  message: { error: 'This site\'s own internal AI-route rate limit was hit (not any AI provider\'s quota) — please wait a few minutes before continuing the batch.' },
  standardHeaders: true, legacyHeaders: false,
});
app.use('/api/ai', aiLimiter);
// Same reasoning as aiLimiter above — the batched photo upload endpoint
// (see routes/bulk.js) fires roughly one request per 15 photos during a
// real bulk import with real photo files, which can easily add up to
// dozens of requests in a short window. That's legitimate bulk-admin
// traffic, not abuse, and it was hitting the general 200/15min limit
// above, causing genuine bulk uploads to fail with a 429.
const bulkLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 20000,
  message: { error: 'This site\'s own internal rate limit was hit — please wait a few minutes before continuing the upload.' },
  standardHeaders: true, legacyHeaders: false,
});
app.use('/api/bulk', bulkLimiter);
// Login/auth endpoints need a much tighter limit than general API traffic —
// 200 requests/15min (the global limit above) still allows a meaningful
// number of password guesses against a single account. This applies before
// the route handlers below even see the request, across all three separate
// login systems (admin, customer, courier) plus account registration
// (to blunt automated spam signups too).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  message: { error: 'Too many attempts — please wait a few minutes and try again.' },
  standardHeaders: true, legacyHeaders: false,
});
app.use('/api/auth/login', authLimiter);
app.use('/api/auth/2fa/verify-login', authLimiter);
app.use('/api/customers/login', authLimiter);
app.use('/api/customers/register', authLimiter);
app.use('/api/couriers/login', authLimiter);
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));
// no-cache (not no-store) means "always ask the server before using a
// cached copy" — the server still replies 304 Not Modified when nothing
// changed, so this doesn't hurt performance, it just closes off the class
// of bug where Vercel's edge cache or the browser silently keeps serving
// an old HTML/CSS/JS file after a new deploy. Unhashed filenames (main.css,
// checkout.html, etc. never change name between deploys) are exactly the
// case aggressive default caching handles worst.
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

// ── Database readiness gate ─────────────────────────────────────────────
// initDb() is now async (Postgres, not synchronous SQLite), so it can't
// just run once at module load the way it used to — CommonJS doesn't
// support top-level await, and Vercel's serverless runtime needs
// `module.exports = app` to happen synchronously regardless. Instead, this
// middleware lazily kicks off setup on the first request that arrives
// (cached in dbReadyPromise so it only really runs once per process) and
// makes every request wait for it before reaching any route. Also runs
// routes/site.js's settings seeding here, since that used to rely on
// running at require-time right after initDb() — now it's chained into
// the same readiness promise instead.
let dbReadyPromise = null;
function ensureDbReady(req, res, next) {
  if (!dbReadyPromise) {
    dbReadyPromise = initDb()
      .then(() => require('./routes/site').seedDefaultSettings())
      .catch(err => { dbReadyPromise = null; throw err; });
  }
  dbReadyPromise.then(() => next()).catch(next);
}
app.use(ensureDbReady);

// ── Page visit tracking (for the admin Analytics tab) ───────────────────
// Fire-and-forget: never awaited, never blocks or slows down the actual
// response, and a tracking failure is only logged, never surfaced to the
// visitor. Deliberately excludes /api/* (not a page view), /admin* (staff
// using the dashboard isn't a "site visit"), and static asset extensions
// (one page load triggers many CSS/JS/image requests — only the page
// itself should count).
const crypto = require('crypto');
const ANALYTICS_SKIP_PATTERN = /^\/(api|admin)(\/|$)|\.[a-z0-9]{2,4}$/i;
async function recordVisit(req) {
  const { getDb } = require('./db/database');
  const db = getDb();
  const referrer = (req.headers.referer || req.headers.referrer || '').slice(0, 500);
  const userAgent = (req.headers['user-agent'] || '').slice(0, 500);
  // Privacy-conscious "unique visitor" approximation: a one-way hash of
  // IP + user-agent, truncated short. The raw IP is never stored anywhere.
  const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket?.remoteAddress || '';
  const visitorHash = crypto.createHash('sha256').update(ip + userAgent).digest('hex').slice(0, 16);
  await db.prepare('INSERT INTO page_visits(path, referrer, user_agent, visitor_hash) VALUES(?,?,?,?)').run(req.path, referrer, userAgent, visitorHash);
}
app.use((req, res, next) => {
  if (req.method === 'GET' && !ANALYTICS_SKIP_PATTERN.test(req.path)) {
    recordVisit(req).catch(e => console.error('[Analytics] tracking error:', e.message));
  }
  next();
});

app.use('/api/auth',      require('./routes/auth'));
app.use('/api/products',  require('./routes/products'));
app.use('/api/contact',   require('./routes/contact'));
app.use('/api/orders',    require('./routes/orders'));
app.use('/api/dashboard', require('./routes/dashboard'));
app.use('/api/site',      require('./routes/site'));
app.use('/api/bulk',      require('./routes/bulk'));
app.use('/api/ai',        require('./routes/ai'));
app.use('/api/analytics', require('./routes/analytics'));
app.use('/api/reviews',   require('./routes/reviews'));
app.use('/api/vouchers',  require('./routes/vouchers'));
app.use('/api/credentials', require('./routes/credentials'));
app.use('/api/chat',        require('./routes/chat'));
app.use('/api/activity-log', require('./routes/activityLog'));
app.use('/api/customers', require('./routes/customers'));
app.use('/api/refunds', require('./routes/refunds'));
app.use('/api/couriers', require('./routes/couriers'));
app.use('/api/config', require('./routes/publicConfig'));

app.get('/api/health', (req, res) => res.json({ status:'ok', time: new Date().toISOString() }));

// SPA fallback for clean URLs
app.get('/', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/store', (req, res) => res.sendFile(path.join(__dirname,'public','store.html')));
app.get('/cart', (req, res) => res.sendFile(path.join(__dirname,'public','cart.html')));
app.get('/checkout', (req, res) => res.sendFile(path.join(__dirname,'public','checkout.html')));
app.get('/confirmation', (req, res) => res.sendFile(path.join(__dirname,'public','confirmation.html')));
app.get('/product', (req, res) => res.sendFile(path.join(__dirname,'public','product.html')));
app.get('/admin', (req, res) => res.sendFile(path.join(__dirname,'public','admin','index.html')));
app.get('/admin/*', (req, res) => res.sendFile(path.join(__dirname,'public','admin','index.html')));
app.get('/request-service', (req, res) => res.sendFile(path.join(__dirname,'public','request-service.html')));
// BE-07 fix: these pages existed as HTML files but had no clean-URL route,
// so they were only reachable via /about.html etc. instead of /about.
app.get('/about', (req, res) => res.sendFile(path.join(__dirname,'public','about.html')));
app.get('/services', (req, res) => res.sendFile(path.join(__dirname,'public','services.html')));
app.get('/projects', (req, res) => res.sendFile(path.join(__dirname,'public','projects.html')));
app.get('/contact', (req, res) => res.sendFile(path.join(__dirname,'public','contact.html')));
app.get('/account', (req, res) => res.sendFile(path.join(__dirname,'public','account.html')));
app.get('/courier', (req, res) => res.sendFile(path.join(__dirname,'public','courier.html')));

app.use((err, req, res, next) => { console.error(err); res.status(500).json({ error: err.message || 'Server error' }); });

// Vercel's @vercel/node runtime imports this file and calls the exported
// app directly as a request handler — it does not use app.listen(). Only
// bind a real port when running as a normal process (local dev, Render,
// Railway, `npm start`), guarded by the VERCEL env var Vercel sets
// automatically on every build and function invocation. Database readiness
// is handled per-request by the ensureDbReady middleware above, so nothing
// extra needs to happen here regardless of which environment this runs in.
if (!process.env.VERCEL) {
  app.listen(PORT, () => {
    console.log(`\n🚀 InfraConnect running → http://localhost:${PORT}`);
    console.log(`📊 Admin Dashboard   → http://localhost:${PORT}/admin`);
    console.log(`🛒 Store             → http://localhost:${PORT}/store`);
    console.log(`\n📧 Admin login: ${process.env.ADMIN_EMAIL}`);
    console.log(`🔑 Password:    (set from your .env — not printed to logs)\n`);
  });
}

module.exports = app;
