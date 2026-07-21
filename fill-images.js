/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Fill Missing Image URLs into a Bulk Upload CSV
 * ═══════════════════════════════════════════════════════════════════════════
 *  Runs on YOUR computer (not on Claude's side — Claude has no internet
 *  access to call AI providers directly), using YOUR API key, to fill in
 *  the `image_url` column for every row that doesn't already have one.
 *  Reuses the exact same "ask an AI provider to find a product photo URL"
 *  logic already proven in InfraConnect's admin panel — just applied to a
 *  CSV file directly instead of products already in the database.
 *
 *  REQUIREMENTS
 *  - Node.js 18 or newer (for built-in fetch — check with: node --version)
 *  - Must be run from inside your InfraConnect project folder, so it can
 *    use the same `xlsx` package already installed there (node_modules)
 *
 *  SETUP
 *  1. Copy this file into your InfraConnect project's root folder
 *     (the same folder as package.json)
 *  2. Copy your CSV into that same folder too
 *  3. Set your API key as an environment variable — pick ONE provider:
 *       Mac/Linux:   export GROQ_API_KEY=your-key-here
 *       Windows:     set GROQ_API_KEY=your-key-here
 *     (Or GEMINI_API_KEY / GLM_API_KEY / DEEPSEEK_API_KEY — see PROVIDER below)
 *
 *  USAGE
 *     node fill-images.js infraconnect_bulk_import.csv
 *
 *  This OVERWRITES the input file's image_url column in place, saving
 *  progress every 20 rows — safe to stop (Ctrl+C) and resume later; it
 *  automatically skips rows that already have an image_url filled in.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const fs = require('fs');
const path = require('path');
const XLSX = require('xlsx'); // reuses the same package already in your project's node_modules

// ── CONFIGURATION — edit these two lines if needed ─────────────────────────
const PROVIDER = process.env.AI_PROVIDER || 'groq'; // 'groq' | 'gemini' | 'glm' | 'deepseek'
const SAVE_EVERY = 20; // rows between progress saves — lower = safer against interruption, higher = fewer disk writes

const API_KEYS = {
  groq: process.env.GROQ_API_KEY,
  gemini: process.env.GEMINI_API_KEY,
  glm: process.env.GLM_API_KEY,
  deepseek: process.env.DEEPSEEK_API_KEY,
};

function extractJson(text) {
  const m = (text || '').match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

// Same prompt and provider-dispatch logic as findProductImageUrl() in
// routes/ai.js — asks for just an image URL, not full product data.
async function findImageUrl(productName, apiKey) {
  const prompt = `Find a direct URL to an official product photo (jpg/png, from the manufacturer or a major retailer) for this product: "${productName}". Return ONLY a JSON object, no explanation: {"image_url": "https://..."} or {"image_url": null} if you can't find one.`;

  if (PROVIDER === 'gemini') {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || `Gemini failed (${r.status})`);
    let text = '';
    (d?.candidates?.[0]?.content?.parts || []).forEach(p => { if (p.text) text += p.text; });
    return extractJson(text)?.image_url || null;
  }
  if (PROVIDER === 'glm') {
    const r = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'glm-4.7', messages: [{ role: 'user', content: prompt }], tools: [{ type: 'web_search', web_search: { search_query: productName, search_result: true } }], stream: false })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || `GLM failed (${r.status})`);
    return extractJson(d?.choices?.[0]?.message?.content || '')?.image_url || null;
  }
  if (PROVIDER === 'deepseek') {
    // DeepSeek needs a search tool + a follow-up turn to use it — this is
    // a simplified single-shot version (no tool loop) since this script's
    // only goal is one image URL, not full product research.
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], stream: false })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || `DeepSeek failed (${r.status})`);
    return extractJson(d?.choices?.[0]?.message?.content || '')?.image_url || null;
  }
  // groq (default)
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `Groq failed (${r.status})`);
  return extractJson(d?.choices?.[0]?.message?.content || '')?.image_url || null;
}

function parseRetryDelay(message) {
  const m = (message || '').match(/(?:try again in|retry in) ([\d.]+)s/i);
  return m ? parseFloat(m[1]) : null;
}

async function findImageUrlWithRetry(productName, apiKey) {
  try {
    return await findImageUrl(productName, apiKey);
  } catch (e) {
    const isRateLimit = /rate limit|429|quota/i.test(e.message || '');
    if (!isRateLimit) throw e;
    const delay = parseRetryDelay(e.message);
    if (delay && delay <= 15) {
      console.log(`   ...rate limited, waiting ${Math.ceil(delay)}s`);
      await new Promise(res => setTimeout(res, Math.ceil(delay * 1000) + 500));
      return await findImageUrl(productName, apiKey);
    }
    throw e;
  }
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node fill-images.js <path-to-csv>');
    process.exit(1);
  }
  const apiKey = API_KEYS[PROVIDER];
  if (!apiKey) {
    console.error(`No API key found for provider "${PROVIDER}". Set it with:`);
    console.error(`  export ${PROVIDER.toUpperCase()}_API_KEY=your-key-here`);
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }

  // One-time backup before touching anything — cheap insurance against an
  // interrupted write corrupting the only copy of a 2,700+ row file.
  const backupPath = inputPath.replace(/\.(csv|xlsx)$/i, '') + '.backup$&';
  if (!fs.existsSync(backupPath)) {
    fs.copyFileSync(inputPath, backupPath);
    console.log(`Backup saved to ${backupPath} (original, untouched)`);
  }

  console.log(`Reading ${inputPath}...`);
  const wb = XLSX.readFile(inputPath, { raw: false });
  const sheetName = wb.SheetNames[0];
  const ws = wb.Sheets[sheetName];
  const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

  const total = rows.length;
  const needsImage = rows.filter(r => !String(r.image_url || '').trim()).length;
  console.log(`${total} total rows, ${needsImage} missing an image_url. Using provider: ${PROVIDER}\n`);

  let done = 0, failed = 0, sinceLastSave = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const existing = String(row.image_url || '').trim();
    if (existing) continue; // already has one — never overwrites a value that's already there

    const name = row.name || row.NAME || '';
    if (!name) continue;

    process.stdout.write(`[${i + 1}/${total}] ${name.slice(0, 60)}... `);
    try {
      const url = await findImageUrlWithRetry(name, apiKey);
      if (url) {
        row.image_url = url;
        done++;
        console.log('✓ found');
      } else {
        console.log('— no image found');
      }
    } catch (e) {
      failed++;
      console.log('✗ ' + e.message.slice(0, 80));
    }

    sinceLastSave++;
    if (sinceLastSave >= SAVE_EVERY) {
      saveProgress(inputPath, rows, sheetName);
      sinceLastSave = 0;
      console.log(`   [progress saved: ${done} found so far]`);
    }
  }

  saveProgress(inputPath, rows, sheetName);
  console.log(`\nDone. ${done} image(s) found and saved, ${failed} failed, ${needsImage - done - failed} had no result. File updated: ${inputPath}`);
}

function saveProgress(inputPath, rows, sheetName) {
  const newWs = XLSX.utils.json_to_sheet(rows);
  const newWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(newWb, newWs, sheetName);
  XLSX.writeFile(newWb, inputPath);
}

main().catch(e => { console.error('Fatal error:', e.message); process.exit(1); });
