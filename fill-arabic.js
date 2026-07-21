/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  Fill Arabic Translations into a Bulk Upload CSV
 * ═══════════════════════════════════════════════════════════════════════════
 *  Same idea as fill-images.js — runs on YOUR computer using YOUR API key,
 *  filling in name_ar / description_ar / specs_ar / badge_ar for every row
 *  that doesn't already have them. Reuses the same translation prompt
 *  already proven in InfraConnect's admin panel "Translate Missing Arabic"
 *  feature — just applied to a CSV file directly instead of products
 *  already in the database.
 *
 *  REQUIREMENTS: Node.js 18+, run from inside your InfraConnect project
 *  folder (uses the same `xlsx` package already in node_modules there).
 *
 *  SETUP
 *  1. Copy this file (and your CSV) into your InfraConnect project's root
 *     folder — same folder as package.json
 *  2. Set your API key:
 *       export GROQ_API_KEY=your-key-here
 *
 *  USAGE
 *     node fill-arabic.js infraconnect_bulk_import.csv
 *
 *  Backs up the original file before touching anything, saves progress
 *  every 20 rows, safe to stop (Ctrl+C) and resume later — skips rows
 *  that already have a name_ar filled in.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const fs = require('fs');
const XLSX = require('xlsx');

const PROVIDER = process.env.AI_PROVIDER || 'groq'; // 'groq' | 'gemini' | 'glm' | 'deepseek'
const SAVE_EVERY = 20;

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

// Same prompt as translateToArabic() in routes/ai.js.
function buildPrompt(row) {
  return `Translate this IT/electronics product's fields into professional Modern Standard Arabic (business register, as used on Arabic tech retail sites). Keep brand names and model numbers in Latin script within the Arabic text — e.g. "خادم Dell PowerEdge R750".

Name: ${row.name}
Description: ${row.description || ''}
Specs: ${(row.specs || '').split('|').join(' | ')}
Badge: ${row.badge || ''}

Return ONLY a JSON object, no explanation, no markdown:
{"name_ar": "...", "description_ar": "...", "specs_ar": ["...", "..."], "badge_ar": "..."}
If badge is empty, return "" for badge_ar. specs_ar must have the same number of items as Specs, same order.`;
}

async function translate(row, apiKey) {
  const prompt = buildPrompt(row);

  if (PROVIDER === 'gemini') {
    const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || `Gemini failed (${r.status})`);
    let text = '';
    (d?.candidates?.[0]?.content?.parts || []).forEach(p => { if (p.text) text += p.text; });
    return extractJson(text);
  }
  if (PROVIDER === 'glm') {
    const r = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'glm-4.7', messages: [{ role: 'user', content: prompt }], stream: false })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || `GLM failed (${r.status})`);
    return extractJson(d?.choices?.[0]?.message?.content || '');
  }
  if (PROVIDER === 'deepseek') {
    const r = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({ model: 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], stream: false })
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.error?.message || `DeepSeek failed (${r.status})`);
    return extractJson(d?.choices?.[0]?.message?.content || '');
  }
  // groq (default) — translation doesn't need web search, so the plain
  // model is used here rather than groq/compound (faster, no search
  // quota spent on something that doesn't need looking up).
  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ model: 'llama-3.3-70b-versatile', messages: [{ role: 'user', content: prompt }] })
  });
  const d = await r.json();
  if (!r.ok) throw new Error(d?.error?.message || `Groq failed (${r.status})`);
  return extractJson(d?.choices?.[0]?.message?.content || '');
}

function parseRetryDelay(message) {
  const m = (message || '').match(/(?:try again in|retry in) ([\d.]+)s/i);
  return m ? parseFloat(m[1]) : null;
}

async function translateWithRetry(row, apiKey) {
  try {
    return await translate(row, apiKey);
  } catch (e) {
    const isRateLimit = /rate limit|429|quota/i.test(e.message || '');
    if (!isRateLimit) throw e;
    const delay = parseRetryDelay(e.message);
    if (delay && delay <= 15) {
      console.log(`   ...rate limited, waiting ${Math.ceil(delay)}s`);
      await new Promise(res => setTimeout(res, Math.ceil(delay * 1000) + 500));
      return await translate(row, apiKey);
    }
    throw e;
  }
}

async function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node fill-arabic.js <path-to-csv>');
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

  // Ensures the four Arabic columns exist even if this CSV predates them
  // (e.g. was exported before the template added these columns) — every
  // row gets the key even if empty, so json_to_sheet writes proper
  // headers instead of only adding columns for whichever rows happen to
  // get a translation first.
  rows.forEach(r => {
    if (!('name_ar' in r)) r.name_ar = '';
    if (!('description_ar' in r)) r.description_ar = '';
    if (!('specs_ar' in r)) r.specs_ar = '';
    if (!('badge_ar' in r)) r.badge_ar = '';
  });

  const total = rows.length;
  const needsTranslation = rows.filter(r => !String(r.name_ar || '').trim()).length;
  console.log(`${total} total rows, ${needsTranslation} missing a translation. Using provider: ${PROVIDER}\n`);

  let done = 0, failed = 0, sinceLastSave = 0;

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (String(row.name_ar || '').trim()) continue; // already has one — never overwrites

    const name = row.name || row.NAME || '';
    if (!name) continue;

    process.stdout.write(`[${i + 1}/${total}] ${name.slice(0, 60)}... `);
    try {
      const result = await translateWithRetry(row, apiKey);
      if (result) {
        row.name_ar = result.name_ar || '';
        row.description_ar = result.description_ar || '';
        row.specs_ar = Array.isArray(result.specs_ar) ? result.specs_ar.join('|') : (result.specs_ar || '');
        row.badge_ar = result.badge_ar || '';
        done++;
        console.log('✓ translated');
      } else {
        console.log('— no response');
      }
    } catch (e) {
      failed++;
      console.log('✗ ' + e.message.slice(0, 80));
    }

    sinceLastSave++;
    if (sinceLastSave >= SAVE_EVERY) {
      saveProgress(inputPath, rows, sheetName);
      sinceLastSave = 0;
      console.log(`   [progress saved: ${done} done so far]`);
    }
  }

  saveProgress(inputPath, rows, sheetName);
  console.log(`\nDone. ${done} product(s) translated, ${failed} failed. File updated: ${inputPath}`);
}

function saveProgress(inputPath, rows, sheetName) {
  const newWs = XLSX.utils.json_to_sheet(rows);
  const newWb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(newWb, newWs, sheetName);
  XLSX.writeFile(newWb, inputPath);
}

main().catch(e => { console.error('Fatal error:', e.message); process.exit(1); });
