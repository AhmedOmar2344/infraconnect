/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  InfraConnect — Database Diagnostic Script
 *  File: check-db.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  Run this from your project root to see EXACTLY what's in your database,
 *  bypassing the server and API entirely. This tells us if the data is
 *  really there or not.
 *
 *  USAGE:
 *    cd ~/Downloads/infraconnect
 *    node check-db.js
 *
 *  Reads DATABASE_URL from your .env file, same as the running server does.
 * ═══════════════════════════════════════════════════════════════════════════
 */

require('dotenv').config();
const { Pool } = require('@neondatabase/serverless');

console.log('═══════════════════════════════════════════════════');
console.log('  INFRACONNECT DATABASE DIAGNOSTIC');
console.log('═══════════════════════════════════════════════════\n');

if (!process.env.DATABASE_URL) {
  console.log('❌ DATABASE_URL is not set in your .env file.');
  console.log('   Copy it from Vercel → Storage → your Neon database → Connection String.');
  process.exit(1);
}

// Only print the host, never the full connection string (contains credentials).
try {
  const host = new URL(process.env.DATABASE_URL).host;
  console.log('Connecting to:', host);
} catch { console.log('Connecting to: (could not parse DATABASE_URL host)'); }
console.log('');

const pool = new Pool({ connectionString: process.env.DATABASE_URL });

async function main() {
  const tables = ['products', 'messages', 'quotes', 'orders', 'users', 'categories'];
  console.log('Row counts per table:');
  for (const t of tables) {
    try {
      const r = await pool.query(`SELECT COUNT(*) as c FROM ${t}`);
      console.log(`   ${t.padEnd(12)} → ${r.rows[0].c} rows`);
    } catch (e) {
      console.log(`   ${t.padEnd(12)} → ERROR: ${e.message}`);
    }
  }

  console.log('\nActive products specifically:');
  try {
    const active = await pool.query('SELECT COUNT(*) as c FROM products WHERE active=1');
    console.log(`   active=1 → ${active.rows[0].c} rows`);
    const breakdown = await pool.query('SELECT active, COUNT(*) as c FROM products GROUP BY active');
    console.log('   Breakdown by active value:', breakdown.rows);
  } catch (e) { console.log('   ERROR:', e.message); }

  console.log('\nUnread messages specifically:');
  try {
    const unread = await pool.query("SELECT COUNT(*) as c FROM messages WHERE status='unread'");
    console.log(`   status='unread' → ${unread.rows[0].c} rows`);
    const statusBreakdown = await pool.query('SELECT status, COUNT(*) as c FROM messages GROUP BY status');
    console.log('   Breakdown by status value:', statusBreakdown.rows);
    const recent = await pool.query('SELECT id, first_name, email, status, created_at FROM messages ORDER BY created_at DESC LIMIT 10');
    console.log('   Last 10 messages:');
    recent.rows.forEach(m => console.log(`     #${m.id} | ${m.first_name} <${m.email}> | status="${m.status}" | ${m.created_at}`));
  } catch (e) { console.log('   ERROR:', e.message); }

  console.log('\n═══════════════════════════════════════════════════');
  console.log('  DIAGNOSTIC COMPLETE');
  console.log('═══════════════════════════════════════════════════');
  await pool.end();
}

main().catch(e => { console.error('Fatal error:', e.message); process.exit(1); });
