# InfraConnect

Full-stack IT infrastructure & tech store — Express + Neon Postgres backend, vanilla JS frontend with English/Arabic (RTL) support, admin dashboard SPA, and a React Native/Expo mobile app (separate repo).

Live at: [infraconnect24-7.com](https://infraconnect24-7.com) (deployed on Vercel)

## Requirements

- Node.js (any recent version — no native dependencies, so there's no version pin)
- npm
- A [Neon](https://neon.tech) Postgres database (free tier is enough) — or use the one already connected via Vercel's Storage tab

## Setup

```bash
git clone https://github.com/AhmedOmar2344/infraconnect.git
cd infraconnect
npm install
cp .env.example .env
# then edit .env with real values — see "Environment Variables" below
npm run dev
```

Open:
| Page | URL |
|------|-----|
| Home | http://localhost:3000 |
| Store | http://localhost:3000/store |
| Admin | http://localhost:3000/admin |

Admin login uses the `ADMIN_EMAIL` / `ADMIN_PASSWORD` you set in `.env` — the account is created automatically the first time the server starts (only if it doesn't already exist for that email).

## Environment Variables

See `.env.example` for the full list with inline comments. Required:

| Variable | Purpose |
|---|---|
| `DATABASE_URL` | Neon Postgres connection string. Get it from Vercel → Storage → your database → Connection String (or Neon's own dashboard). |
| `JWT_SECRET` | Signs admin login tokens. Generate a random one — never reuse an example value. |
| `ADMIN_EMAIL` / `ADMIN_PASSWORD` | First admin account, created on first run. |
| `SMTP_HOST/PORT/USER/PASS/FROM` | Sends contact-form and quote-request notification emails. For Gmail, use an [App Password](https://myaccount.google.com/apppasswords), not your normal password. |
| `NOTIFY_EMAIL` | Where new contact/quote notifications are sent. |
| `CORS_ORIGINS` | Optional — only needed if you add a domain not already hardcoded in `server.js` (`infraconnect24-7.com` and any `*.vercel.app` preview URL already work without this). |

**Never commit your real `.env` file.** It's in `.gitignore` — if it was ever committed in the past, rotate every secret in it (JWT secret, admin password, SMTP password) and scrub it from git history (`git filter-repo` or the BFG Repo-Cleaner), since old commits still contain it even after a later `git rm`.

**On Vercel**, environment variables live in the dashboard (Settings → Environment Variables), completely separate from your local `.env` file — updating one does not update the other. Change both when rotating a credential.

## Daily Git Workflow

```bash
git add .
git commit -m "Describe what you changed"
git push
```

Vercel auto-deploys on every push to `main`.

## Database

Uses [Neon](https://neon.tech) (serverless Postgres) via the `@neondatabase/serverless` driver. `db/database.js` creates all tables, runs migrations, and seeds default data (admin user, 14 categories, 62 sample products, Arabic translations) automatically on first request after a deploy — no manual migration step needed.

Originally built on SQLite (`better-sqlite3`), migrated to Postgres because Vercel's serverless filesystem can't hold a persistent database file. `db/database.js` includes a compatibility shim so most of the original `?`-placeholder SQL still works unchanged; see the comment at the top of that file for the technical details of what that shim does and its one known limitation (bulk operations run sequentially rather than in a true atomic transaction).

## Arabic / RTL Support

Toggle via the language button in the navbar (public site) or topbar (admin). Product catalog, categories, and site settings are stored bilingually in the database (`name_ar`, `description_ar`, etc. columns) and editable from the admin panel. Static UI text lives in `public/js/i18n.js`. Not yet translated: cart/checkout/confirmation pages, and the admin panel's internal tables and forms (only product/category/settings content is bilingual there — the surrounding UI chrome is still English).

## Project Structure

```
infraconnect/
├── server.js              # Express app entry point, routes, middleware
├── db/
│   ├── database.js         # Postgres schema, migrations, seed data, query shim
│   └── translations-ar.js  # Arabic translations for seeded categories/products/settings
├── middleware/auth.js      # JWT auth middleware
├── routes/                 # API route handlers (auth, products, orders, contact, dashboard, site, bulk)
└── public/                 # Frontend — static HTML/CSS/JS
    ├── js/                 # cart.js (cart engine), api.js (fetch helpers), app.js, i18n.js (language switcher)
    └── admin/index.html    # Admin dashboard SPA
```

## Known Limitations / Roadmap

A full code audit was run against this project early on — most items were fixed; a few larger architectural changes were intentionally left for later rather than done as an automated pass:

- JWT is stored in `localStorage` rather than an `httpOnly` cookie (XSS-exposed if a new stored-XSS bug is ever introduced).
- Orders/messages/quotes/users use hard deletes with no audit trail.
- Store page search/pagination happens client-side after fetching all products — won't scale much past a few hundred SKUs.
- No automated test suite.
- Admin dashboard is a single large HTML file rather than a component-based build.
- Bulk operations (settings save, Excel product import) run sequentially rather than in a true atomic database transaction — see the note in `db/database.js`.
- Arabic translation doesn't yet cover cart/checkout/confirmation pages or the admin panel's internal UI (tables, form labels, buttons).

## Deployment

Deployed on Vercel, connected to GitHub for auto-deploy on push to `main`. Database is Neon Postgres (connected via Vercel's native Storage integration). If you fork this and want to deploy your own copy:

1. Push to your own GitHub repo
2. Import it into Vercel
3. Vercel → Storage → create a Neon database (or connect an existing one) — this auto-injects `DATABASE_URL`
4. Add the remaining environment variables in Settings → Environment Variables (see table above)
5. Redeploy
