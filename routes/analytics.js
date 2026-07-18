/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Analytics Route
 *  File: routes/analytics.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Reads from the page_visits table, populated by the tracking middleware
 *  in server.js. Every query here is read-only aggregation — nothing here
 *  writes data. Open to any authenticated role (including poweruser) since
 *  it's informational, not a structural/website change.
 *
 *  GET /api/analytics/overview
 *    Returns everything the Analytics tab needs in one call: this month's
 *    totals, a daily trend for the last 30 days, monthly totals for the
 *    last 6 months, top pages, top referrers, and a rough device breakdown.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const { getDb } = require('../db/database');
const { auth } = require('../middleware/auth');
const { sendMail } = require('../lib/mailer');

// Very lightweight device/browser categorization from the user-agent
// string — good enough for a rough breakdown without adding a UA-parsing
// dependency. Not meant to be perfectly precise.
function categorizeDevice(ua) {
  ua = (ua || '').toLowerCase();
  if (/ipad|tablet/.test(ua)) return 'Tablet';
  if (/mobile|iphone|android/.test(ua)) return 'Mobile';
  return 'Desktop';
}
function categorizeBrowser(ua) {
  ua = (ua || '').toLowerCase();
  if (/edg\//.test(ua)) return 'Edge';
  if (/chrome\//.test(ua) && !/edg\//.test(ua)) return 'Chrome';
  if (/safari\//.test(ua) && !/chrome\//.test(ua)) return 'Safari';
  if (/firefox\//.test(ua)) return 'Firefox';
  return 'Other';
}

router.get('/overview', auth, async (req, res, next) => {
  try {
    const db = getDb();

    const [
      thisMonth, today, uniqueThisMonth, lastMonth,
      dailyRows, monthlyRows, topPages, topReferrers, uaRows
    ] = await Promise.all([
      db.prepare(`SELECT COUNT(*) as c FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE)`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM page_visits WHERE created_at::date = CURRENT_DATE`).get(),
      db.prepare(`SELECT COUNT(DISTINCT visitor_hash) as c FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE)`).get(),
      db.prepare(`SELECT COUNT(*) as c FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month') AND created_at::timestamp < date_trunc('month', CURRENT_DATE)`).get(),
      db.prepare(`SELECT created_at::date as day, COUNT(*) as c FROM page_visits WHERE created_at::timestamp >= CURRENT_DATE - INTERVAL '29 days' GROUP BY created_at::date ORDER BY day`).all(),
      db.prepare(`SELECT to_char(created_at::timestamp, 'YYYY-MM') as month, COUNT(*) as c FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE - INTERVAL '5 months') GROUP BY month ORDER BY month`).all(),
      db.prepare(`SELECT path, COUNT(*) as c FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE) GROUP BY path ORDER BY c DESC LIMIT 10`).all(),
      db.prepare(`SELECT referrer, COUNT(*) as c FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE) AND referrer IS NOT NULL AND referrer != '' GROUP BY referrer ORDER BY c DESC LIMIT 10`).all(),
      db.prepare(`SELECT user_agent FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE) LIMIT 2000`).all(),
    ]);

    // Device/browser breakdown computed in JS from the sampled user-agents
    // (capped at 2000 rows above so this stays fast even with heavy traffic).
    const deviceCounts = {}, browserCounts = {};
    uaRows.forEach(r => {
      const d = categorizeDevice(r.user_agent);
      const b = categorizeBrowser(r.user_agent);
      deviceCounts[d] = (deviceCounts[d] || 0) + 1;
      browserCounts[b] = (browserCounts[b] || 0) + 1;
    });

    const thisMonthCount = Number(thisMonth.c);
    const lastMonthCount = Number(lastMonth.c);
    const momChange = lastMonthCount > 0
      ? Math.round(((thisMonthCount - lastMonthCount) / lastMonthCount) * 100)
      : null;

    res.json({
      visits_this_month: thisMonthCount,
      visits_today: Number(today.c),
      unique_visitors_this_month: Number(uniqueThisMonth.c),
      visits_last_month: lastMonthCount,
      month_over_month_change_pct: momChange,
      daily_last_30_days: dailyRows.map(r => ({ date: r.day, count: Number(r.c) })),
      monthly_last_6_months: monthlyRows.map(r => ({ month: r.month, count: Number(r.c) })),
      top_pages: topPages.map(r => ({ path: r.path, count: Number(r.c) })),
      top_referrers: topReferrers.map(r => ({ referrer: r.referrer, count: Number(r.c) })),
      device_breakdown: Object.entries(deviceCounts).map(([device, count]) => ({ device, count })),
      browser_breakdown: Object.entries(browserCounts).map(([browser, count]) => ({ browser, count })),
    });
  } catch (err) { next(err); }
});

/**
 * ── Monthly Report (Vercel Cron) ─────────────────────────────────────────
 * GET /api/analytics/monthly-report-cron
 *
 * Triggered automatically by Vercel Cron on the 1st of each month (see
 * vercel.json), summarizing the month that just ended. Also callable
 * manually (e.g. for testing) by an admin — see the auth check below.
 *
 * SECURITY: Vercel sends an `Authorization: Bearer <CRON_SECRET>` header
 * when it invokes this on schedule. CRON_SECRET must be set in your
 * environment variables (see .env.example) — without it, this endpoint
 * would be a public, unauthenticated way to trigger report generation and
 * emails, since Vercel Cron always calls via a plain GET request that
 * can't carry a normal admin login token.
 */
router.get('/monthly-report-cron', async (req, res, next) => {
  try {
    const cronSecret = process.env.CRON_SECRET;
    const authHeader = req.headers.authorization;
    const isCron = cronSecret && authHeader === `Bearer ${cronSecret}`;
    // Fallback: also allow a logged-in admin to trigger this manually (for
    // testing without waiting for the 1st of the month) — reuses the normal
    // JWT auth middleware's logic inline since this route needs to accept
    // EITHER the cron secret OR a normal admin token, not just one.
    if (!isCron) {
      const jwt = require('jsonwebtoken');
      const token = (req.headers['authorization'] || '').split(' ')[1];
      try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        if (!decoded) throw new Error('invalid');
      } catch {
        return res.status(401).json({ error: 'Unauthorized.' });
      }
    }

    const db = getDb();
    // "Last month" relative to when this runs — scheduled for just after
    // the month rolls over, so CURRENT_DATE is already in the new month.
    const [totalRow, uniqueRow, topPages, topReferrers, uaRows, monthLabelRow] = await Promise.all([
      db.prepare(`SELECT COUNT(*) as c FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month') AND created_at::timestamp < date_trunc('month', CURRENT_DATE)`).get(),
      db.prepare(`SELECT COUNT(DISTINCT visitor_hash) as c FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month') AND created_at::timestamp < date_trunc('month', CURRENT_DATE)`).get(),
      db.prepare(`SELECT path, COUNT(*) as c FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month') AND created_at::timestamp < date_trunc('month', CURRENT_DATE) GROUP BY path ORDER BY c DESC LIMIT 10`).all(),
      db.prepare(`SELECT referrer, COUNT(*) as c FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month') AND created_at::timestamp < date_trunc('month', CURRENT_DATE) AND referrer IS NOT NULL AND referrer != '' GROUP BY referrer ORDER BY c DESC LIMIT 5`).all(),
      db.prepare(`SELECT user_agent FROM page_visits WHERE created_at::timestamp >= date_trunc('month', CURRENT_DATE - INTERVAL '1 month') AND created_at::timestamp < date_trunc('month', CURRENT_DATE) LIMIT 2000`).all(),
      db.prepare(`SELECT to_char(date_trunc('month', CURRENT_DATE - INTERVAL '1 month'), 'YYYY-MM') as month`).get(),
    ]);

    const month = monthLabelRow.month;
    const totalVisits = Number(totalRow.c);
    const uniqueVisitors = Number(uniqueRow.c);

    const deviceCounts = {};
    uaRows.forEach(r => {
      const ua = (r.user_agent || '').toLowerCase();
      const d = /ipad|tablet/.test(ua) ? 'Tablet' : /mobile|iphone|android/.test(ua) ? 'Mobile' : 'Desktop';
      deviceCounts[d] = (deviceCounts[d] || 0) + 1;
    });
    const deviceBreakdown = Object.entries(deviceCounts).map(([device, count]) => ({ device, count }));
    const topPagesData = topPages.map(r => ({ path: r.path, count: Number(r.c) }));
    const topReferrersData = topReferrers.map(r => ({ referrer: r.referrer, count: Number(r.c) }));

    // Idempotent: if this already ran for this month (e.g. Hobby's imprecise
    // cron timing fires it twice), update rather than duplicate.
    await db.prepare(`
      INSERT INTO monthly_reports(month, total_visits, unique_visitors, top_pages, top_referrers, device_breakdown)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT (month) DO UPDATE SET
        total_visits=excluded.total_visits, unique_visitors=excluded.unique_visitors,
        top_pages=excluded.top_pages, top_referrers=excluded.top_referrers,
        device_breakdown=excluded.device_breakdown, generated_at=CURRENT_TIMESTAMP
    `).run(month, totalVisits, uniqueVisitors, JSON.stringify(topPagesData), JSON.stringify(topReferrersData), JSON.stringify(deviceBreakdown));

    // Email the summary if NOTIFY_EMAIL is configured.
    let emailSent = false;
    if (process.env.NOTIFY_EMAIL) {
      const pageNames = { '/': 'Home', '/store': 'Store', '/about': 'About', '/services': 'Services', '/projects': 'Projects', '/contact': 'Contact', '/product': 'Product Detail', '/cart': 'Cart', '/checkout': 'Checkout', '/confirmation': 'Order Confirmation', '/request-service': 'Request Service' };
      const escHtml = s => String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      const pagesHtml = topPagesData.slice(0, 5).map(p => `<li>${escHtml(pageNames[p.path] || p.path)} — <b>${p.count}</b> visits</li>`).join('') || '<li>No data</li>';
      const devicesHtml = deviceBreakdown.map(d => `<li>${escHtml(d.device)} — <b>${d.count}</b></li>`).join('') || '<li>No data</li>';
      emailSent = await sendMail(
        process.env.NOTIFY_EMAIL,
        `InfraConnect — Monthly Traffic Report (${month})`,
        `<h2>Monthly Traffic Report — ${month}</h2>
         <p><b>Total Visits:</b> ${totalVisits.toLocaleString()}</p>
         <p><b>Unique Visitors:</b> ${uniqueVisitors.toLocaleString()}</p>
         <h3>Top Pages</h3><ul>${pagesHtml}</ul>
         <h3>Devices</h3><ul>${devicesHtml}</ul>
         <p style="color:#888;font-size:12px;">View the full report with charts in your admin panel under Analytics → Monthly Reports.</p>`
      );
      if (emailSent) {
        await db.prepare('UPDATE monthly_reports SET email_sent=1 WHERE month=?').run(month);
      }
    }

    res.json({ ok: true, month, total_visits: totalVisits, unique_visitors: uniqueVisitors, email_sent: emailSent });
  } catch (err) { next(err); }
});

// GET /api/analytics/reports — list past monthly reports for the admin UI
router.get('/reports', auth, async (req, res, next) => {
  try {
    const reports = await getDb().prepare('SELECT * FROM monthly_reports ORDER BY month DESC LIMIT 24').all();
    res.json({
      reports: reports.map(r => ({
        ...r,
        top_pages: JSON.parse(r.top_pages || '[]'),
        top_referrers: JSON.parse(r.top_referrers || '[]'),
        device_breakdown: JSON.parse(r.device_breakdown || '[]'),
      }))
    });
  } catch (err) { next(err); }
});

module.exports = router;
