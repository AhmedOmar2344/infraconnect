/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — AI Product Creator Route
 *  File: routes/ai.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  POST /api/ai/generate-product
 *    Headers: Authorization: Bearer <token>
 *    Body: { query: "product name or description", provider: "gemini" | "deepseek" | "glm" | "groq" | "bazaar" | "chatgpt" }
 *    provider defaults to "gemini" if omitted.
 *    Returns: { product: { name, brand, category_guess, description, specs,
 *                           price_usd, price_note, badge, image_url,
 *                           image_local_path } }
 *
 *  SIX PROVIDERS:
 *  - Gemini (gemini-3.5-flash, falling back to gemini-flash-latest if that
 *    ever becomes unavailable): uses Google Search grounding natively —
 *    built into the model, no extra setup beyond the Gemini key itself.
 *  - Groq (groq/compound): a genuinely free, ongoing tier (no card, no
 *    balance to run out) — ALSO has native web search, decided
 *    automatically server-side, same simplicity as Gemini. The
 *    recommended default for day-to-day use without worrying about
 *    rate limits or account balances.
 *  - GLM (glm-4.7, via Z.ai): ALSO has native web search built in — a
 *    search_query passed directly in the request, verified against Z.ai's
 *    official SDK (github.com/zai-org/z-ai-sdk-python). No separate search
 *    API needed, same as Gemini in that respect.
 *  - DeepSeek (deepseek-v4-flash): has no native web search, but DOES
 *    support function calling — this gives it a real web_search tool
 *    backed by Tavily (a search API purpose-built for AI agents), which
 *    it can call itself, multiple times if needed, before answering.
 *    Requires a SEPARATE Tavily key in addition to the DeepSeek key — see
 *    setup below. Without a Tavily key, DeepSeek still works but silently
 *    falls back to training-data-only (no tools offered to the model at
 *    all in that case, so it never attempts a search it can't fulfill).
 *  - Bazaar (auto:free, via bazaarlink.ai): an OpenAI-compatible gateway
 *    routing to multiple underlying models — treated the same as DeepSeek
 *    (Tavily-backed function-calling search, no confirmed native search
 *    of its own). Free tier available, no card required.
 *  - ChatGPT (OpenAI, gpt-5.6-terra with automatic fallback to gpt-4o-mini
 *    if that model name ever stops being recognized — same resilience
 *    pattern already used for Gemini). Tavily-backed function-calling
 *    search, same reasoning as Bazaar/DeepSeek: OpenAI's native web
 *    search in Chat Completions needs specific "search-preview" model
 *    variants with documented reliability issues, not a simple flag on
 *    standard models. Paid — no free tier.
 *
 *  SECURITY NOTE: every provider is called from the SERVER using keys from
 *  either the API Console vault or environment variables — never exposed
 *  to the browser. Never call an AI API directly from client-side JS with
 *  a real key; anyone with DevTools open could read it out of the page.
 *
 *  SETUP:
 *  - Gemini: free key at aistudio.google.com — GEMINI_API_KEY or API Console.
 *  - Groq: free key at console.groq.com (no card required, ongoing free
 *    tier, not a trial) — GROQ_API_KEY or API Console (Service: "Groq",
 *    Key Label: "API Key").
 *  - GLM: key at z.ai or open.bigmodel.cn — set via API Console
 *    (Service: "GLM", Key Label: "API Key") or the environment variable
 *    this project reads as process.env['GLM-4.7'] (bracket notation
 *    required — the name has a hyphen and period, matching what's
 *    already configured in Vercel; GLM_API_KEY works too as a fallback).
 *  - DeepSeek: key at platform.deepseek.com — set via API Console
 *    (Service: "DeepSeek", Key Label: "API Key") or an environment
 *    variable (the exact variable name is whatever you configured in
 *    Vercel — this project reads it as process.env.Infraconnect, matching
 *    what's already set up, though DEEPSEEK_API_KEY would normally be the
 *    conventional name for a key like this going forward).
 *  - Tavily (for DeepSeek's search capability only — Gemini, Groq, and
 *    GLM don't need this): free key at tavily.com, 1,000 searches/month,
 *    no card required. Set via API Console (Service: "Tavily", Key
 *    Label: "API Key") or TAVILY_API_KEY.
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const { auth, requireAdmin } = require('../middleware/auth');
const { getDb } = require('../db/database');
const { logActivity } = require('../lib/activityLog');
const { downloadImageFromUrl } = require('../lib/imageDownload');
const { getCredentialValue } = require('./credentials');

/**
 * Downloads the image Gemini suggested and uploads it to Vercel Blob,
 * instead of just handing back an external URL.
 *
 * Why this is needed: AI-suggested image URLs are frequently unreliable —
 * many manufacturer/retailer sites block hotlinking (won't serve the image
 * to a page loaded from a different domain), some URLs point to a product
 * *page* rather than the actual image file, and links can go stale. A URL
 * that resolves fine when Gemini "sees" it during search grounding doesn't
 * mean it'll actually render as an <img> on this site later. Downloading
 * it once, server-side, and re-serving it from Vercel Blob sidesteps all
 * of that.
 *
 * Now just a thin wrapper — the actual download/validate/trim/upload
 * pipeline lives in lib/imageDownload.js, shared with the bulk Excel
 * upload's IMAGE URL column, which needed the exact same logic.
 */
async function downloadProductImage(url) {
  return downloadImageFromUrl(url, 'ai');
}

const JSON_SCHEMA = `You MUST return a valid JSON object with these exact fields:
{
  "name": "full official product name",
  "name_ar": "Arabic translation of the product name",
  "brand": "manufacturer brand",
  "category_guess": "one of: servers-storage, networking, security, wireless, cloud-software, ups-power, laptops, desktops, monitors, tvs, gaming, accessories, printers, phones-tablets",
  "description": "2-3 sentence product description highlighting key benefits",
  "description_ar": "Arabic translation of the description",
  "specs": ["spec1", "spec2", "spec3", "spec4", "spec5", "spec6"],
  "specs_ar": ["Arabic translation of spec1", "spec2", "spec3", "spec4", "spec5", "spec6" — same order, same count as specs],
  "price_usd": 0,
  "price_note": "price as string e.g. $1,299 or Price on Request",
  "badge": "one of: New, Best Seller, Popular, Recommended, Award Winner, or empty string",
  "badge_ar": "Arabic translation of the badge, or empty string",
  "condition": "one of: new, used — default to new unless the query clearly indicates otherwise",
  "image_url": "direct URL to official product image jpg/png from manufacturer or major retailer"
}
Return ONLY valid JSON. No explanation, no markdown, no extra text.`;

const GEMINI_SYSTEM_PROMPT = `You are a product data specialist for an IT and electronics store in Egypt/Middle East.
Given a product name, use Google Search to research it and return complete product data,
including a professional Arabic (Modern Standard Arabic, business register) translation of
every text field. Keep brand names and model numbers in Latin script within the Arabic text
(this is standard practice on Arabic tech retail sites) — e.g. "خادم Dell PowerEdge R750".
${JSON_SCHEMA}`;

// Deliberately DOES claim search capability now — DeepSeek has no native
// web access, but function calling (see generateWithDeepSeek below) gives
// it a real web_search tool backed by Tavily, which it can call itself
// mid-conversation whenever it needs current information.
const DEEPSEEK_SYSTEM_PROMPT = `You are a product data specialist for an IT and electronics store in Egypt/Middle East.
Given a product name, use the web_search tool to research it (call it as many times as needed —
e.g. once for specs, again for current pricing) and return complete product data,
including a professional Arabic (Modern Standard Arabic, business register) translation of
every text field. Keep brand names and model numbers in Latin script within the Arabic text
(this is standard practice on Arabic tech retail sites) — e.g. "خادم Dell PowerEdge R750".
${JSON_SCHEMA}`;

// Same reasoning as DeepSeek's prompt — GLM's chat completions API has no
// native web search either, so this is honest about that, with the same
// Tavily-backed web_search tool available via function calling.
const GLM_SYSTEM_PROMPT = `You are a product data specialist for an IT and electronics store in Egypt/Middle East.
Given a product name, use the web_search tool to research it (call it as many times as needed —
e.g. once for specs, again for current pricing) and return complete product data,
including a professional Arabic (Modern Standard Arabic, business register) translation of
every text field. Keep brand names and model numbers in Latin script within the Arabic text
(this is standard practice on Arabic tech retail sites) — e.g. "خادم Dell PowerEdge R750".
${JSON_SCHEMA}`;

// Groq's groq/compound system also has native web search — like GLM, no
// separate search API needed. Unlike GLM, it decides for itself whether
// and when to search server-side (no search_query field to fill in), so
// this prompt just needs to encourage research, not name a tool.
const GROQ_SYSTEM_PROMPT = `You are a product data specialist for an IT and electronics store in Egypt/Middle East.
Given a product name, research it using real, current web information and return complete
product data, including a professional Arabic (Modern Standard Arabic, business register)
translation of every text field. Keep brand names and model numbers in Latin script within
the Arabic text (this is standard practice on Arabic tech retail sites) — e.g. "خادم Dell PowerEdge R750".
${JSON_SCHEMA}`;

// BazaarLink (bazaarlink.ai) is an OpenAI-compatible multi-model gateway
// (routes to OpenAI/Anthropic/Google/etc. models via one API) — like
// DeepSeek, treated as having no native web search of its own, so it
// gets the same Tavily-backed function-calling search.
const BAZAAR_SYSTEM_PROMPT = `You are a product data specialist for an IT and electronics store in Egypt/Middle East.
Given a product name, use the web_search tool to research it (call it as many times as needed —
e.g. once for specs, again for current pricing) and return complete product data,
including a professional Arabic (Modern Standard Arabic, business register) translation of
every text field. Keep brand names and model numbers in Latin script within the Arabic text
(this is standard practice on Arabic tech retail sites) — e.g. "خادم Dell PowerEdge R750".
${JSON_SCHEMA}`;

// ChatGPT (OpenAI): standard Chat Completions models support reliable,
// well-established function calling — used here rather than OpenAI's
// native web search, which requires specific "search-preview" model
// variants with documented reliability issues (community reports of
// errors following OpenAI's own sample code) and doesn't work with
// standard models via a simple flag the way Gemini/GLM/Groq's grounding
// does. Tavily-backed function calling, same as DeepSeek and Bazaar, is
// the more dependable choice here.
const CHATGPT_SYSTEM_PROMPT = `You are a product data specialist for an IT and electronics store in Egypt/Middle East.
Given a product name, use the web_search tool to research it (call it as many times as needed —
e.g. once for specs, again for current pricing) and return complete product data,
including a professional Arabic (Modern Standard Arabic, business register) translation of
every text field. Keep brand names and model numbers in Latin script within the Arabic text
(this is standard practice on Arabic tech retail sites) — e.g. "خادم Dell PowerEdge R750".
${JSON_SCHEMA}`;

async function searchWeb(query, apiKey) {
  const response = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({ query, search_depth: 'basic', max_results: 5, include_answer: true })
  });
  if (!response.ok) {
    const bodyText = await response.text();
    let detail = bodyText;
    try { detail = JSON.parse(bodyText)?.detail?.error || bodyText; } catch { /* not JSON, use raw text as-is */ }
    // Explicitly names Tavily — this shared search function is used by
    // DeepSeek, Bazaar, and ChatGPT, and a generic "Search failed (429)"
    // here was genuinely indistinguishable from the AI provider itself
    // being out of quota, which is exactly what caused every newly-added
    // provider to look instantly broken (a brand-new key hits this same
    // shared Tavily quota the moment it tries to search, regardless of
    // that key's own, completely separate balance).
    throw new Error(`Tavily search failed (${response.status})${detail ? ': ' + detail : ''} — this is Tavily's own quota, separate from the AI provider's account.`);
  }
  const data = await response.json();
  // Formatted as plain text for the model to read, not raw JSON — an LLM
  // reading "Title: X / Snippet: Y" for each result works better than
  // parsing a nested JSON structure back out of its own context.
  let formatted = data.answer ? `Quick answer: ${data.answer}\n\n` : '';
  formatted += (data.results || []).map((r, i) => `[${i + 1}] ${r.title}\n${r.content}\nSource: ${r.url}`).join('\n\n');
  return formatted || 'No results found.';
}

const WEB_SEARCH_TOOL = {
  type: 'function',
  function: {
    name: 'web_search',
    description: 'Search the web for current, real information — product specs, pricing, availability, release dates, etc.',
    parameters: {
      type: 'object',
      properties: { query: { type: 'string', description: 'The search query' } },
      required: ['query']
    }
  }
};

function extractJsonProduct(text) {
  const jsonMatch = text.match(/\{[\s\S]*\}/);
  if (!jsonMatch) return null;
  try { return JSON.parse(jsonMatch[0]); } catch { return null; }
}

function parseGeminiRetryDelay(errorData) {
  const retryInfo = errorData?.error?.details?.find(d => d['@type']?.includes('RetryInfo'));
  const match = retryInfo?.retryDelay?.match(/^([\d.]+)s$/);
  return match ? parseFloat(match[1]) : null;
}

async function generateWithGemini(query, apiKey, _retryState = {}) {
  // gemini-2.5-flash was cut off early for newer API keys/projects ahead
  // of its official October 2026 shutdown date — a known, documented
  // issue, not specific to this project. gemini-3.5-flash is the current
  // stable model with no announced shutdown date as of this writing.
  // Google has deprecated Flash models unusually fast throughout 2026
  // (2.0 Flash was cut off with roughly a month's real notice), so rather
  // than assume this fix is permanent, a fallback below catches the same
  // failure mode again in the future without needing another manual
  // model-name edit here.
  const model = _retryState.useFallbackModel ? 'gemini-flash-latest' : 'gemini-3.5-flash';
  const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify({
      contents: [{ role: 'user', parts: [{ text: `Research this product and return complete JSON data: "${query}"` }] }],
      systemInstruction: { parts: [{ text: GEMINI_SYSTEM_PROMPT }] },
      tools: [{ google_search: {} }]
    })
  });
  const data = await response.json();
  if (!response.ok) {
    console.error('[AI Product Creator] Gemini API error:', data);
    if (response.status === 429) {
      const retryDelay = parseGeminiRetryDelay(data);
      // Auto-retry once, but only for short delays — Vercel serverless
      // functions have their own execution time limit, and waiting
      // server-side for a long delay risks the whole request timing out
      // before the retry even happens. For anything longer, surfacing
      // the exact wait time is more useful than a generic failure — the
      // admin can see precisely how long to wait rather than guessing.
      if (!_retryState.isRateLimitRetry && retryDelay && retryDelay <= 6) {
        await new Promise(r => setTimeout(r, Math.ceil(retryDelay * 1000) + 300));
        return generateWithGemini(query, apiKey, { ..._retryState, isRateLimitRetry: true });
      }
      const waitMsg = retryDelay ? `Please wait about ${Math.ceil(retryDelay)} seconds and try again.` : 'Please wait a moment and try again.';
      throw new Error(`Gemini's free tier rate limit was hit (this resets quickly — it's not an account problem). ${waitMsg}`);
    }
    // "model X is no longer available" is Google's exact wording when a
    // model gets cut off ahead of its own announced shutdown date (has
    // happened to gemini-2.5-flash already) — retrying once against the
    // auto-updating alias means a future occurrence of this same failure
    // mode self-heals instead of needing another deploy to fix.
    const isModelUnavailable = /no longer available|not found|not supported/i.test(data?.error?.message || '');
    if (isModelUnavailable && !_retryState.useFallbackModel) {
      console.error('[AI Product Creator] Model unavailable, retrying with gemini-flash-latest fallback');
      return generateWithGemini(query, apiKey, { ..._retryState, useFallbackModel: true });
    }
    throw new Error(data?.error?.message || `Gemini request failed (${response.status}).`);
  }
  // Extract text from all parts of the first candidate (grounded responses
  // can include multiple parts — only text parts matter for our JSON).
  let fullText = '';
  const parts = data?.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) parts.forEach(part => { if (part.text) fullText += part.text; });
  return extractJsonProduct(fullText);
}

// Z.ai's official international endpoint for the GLM model family. Unlike
// DeepSeek's function-calling approach (model requests a search, server
// executes it, model gets results back in a second turn), GLM's web_search
// is native and synchronous — the search_query is provided directly in
// the same request, and GLM performs the search and incorporates results
// itself before responding, all in one call. Verified against Z.ai's
// official Python SDK example (github.com/zai-org/z-ai-sdk-python), not
// guessed — an earlier version of this used QA field names that don't
// match the real API and would have silently gotten no search results.
async function generateWithGLM(query, apiKey) {
  const response = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'glm-4.7',
      messages: [
        { role: 'system', content: GLM_SYSTEM_PROMPT },
        { role: 'user', content: `Research this product and return complete JSON data: "${query}"` }
      ],
      tools: [{ type: 'web_search', web_search: { search_query: query, search_result: true } }],
      stream: false
    })
  });
  const data = await response.json();
  if (!response.ok) {
    console.error('[AI Product Creator] GLM API error:', data);
    throw new Error(data?.error?.message || `GLM request failed (${response.status}).`);
  }
  const fullText = data?.choices?.[0]?.message?.content || '';
  return extractJsonProduct(fullText);
}

// Groq's OpenAI-compatible endpoint, using groq/compound — a system that
// decides for itself, automatically and server-side, whether a query
// needs a web search before answering. No tools array to configure at
// all, unlike GLM (which needs an explicit search_query) or DeepSeek
// (which needs a full tool definition and a multi-turn loop) — this is
// the simplest of the four integrations in this file.
function parseGroqRetryDelay(message) {
  // Groq's rate limit errors state the wait time in plain text within the
  // message itself (e.g. "Please try again in 6.264s"), not a structured
  // field like Gemini's — this pulls the number out of that sentence.
  const match = (message || '').match(/try again in ([\d.]+)s/i);
  return match ? parseFloat(match[1]) : null;
}

/**
 * Generic retry wrapper for rate-limit errors, used by the batch
 * translate/find-images loops. translateToArabic() and
 * findProductImageUrl() (unlike generateWithGemini/generateWithGroq)
 * had no rate-limit handling of their own — a rate-limited product would
 * just throw, get marked "failed," and then get re-selected on the very
 * next batch since it was never actually updated. If that kept happening
 * to the same few products at the front of the query order, the batch
 * loop could spend most of its time repeatedly re-attempting (and
 * re-failing) the same small set, while the "processed" counter kept
 * climbing on every attempt regardless of success — which is why the
 * displayed "done" count could end up higher than the catalog's real
 * size. Wraps a single AI call with one retry on a short, provider-
 * reported delay — same threshold reasoning as the existing retries
 * elsewhere in this file (short enough to stay within Vercel's execution
 * time limit).
 */
async function withRateLimitRetry(fn) {
  try {
    return await fn();
  } catch (e) {
    const msg = e.message || '';
    const isRateLimit = /rate limit|429|quota/i.test(msg);
    if (!isRateLimit) throw e;
    const delay = parseGroqRetryDelay(msg) || parseFloat((msg.match(/retry in ([\d.]+)/i) || [])[1]) || null;
    if (delay && delay <= 6) {
      await new Promise(r => setTimeout(r, Math.ceil(delay * 1000) + 300));
      return await fn();
    }
    throw e; // longer waits aren't worth blocking a whole batch for — this product is correctly left unprocessed for the next run
  }
}

async function generateWithGroq(query, apiKey, _isRetry = false) {
  const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'groq/compound',
      messages: [
        { role: 'system', content: GROQ_SYSTEM_PROMPT },
        { role: 'user', content: `Research this product and return complete JSON data: "${query}"` }
      ]
    })
  });
  const data = await response.json();
  if (!response.ok) {
    console.error('[AI Product Creator] Groq API error:', data);
    const errMsg = data?.error?.message || '';
    if (response.status === 429) {
      const retryDelay = parseGroqRetryDelay(errMsg);
      // Same reasoning as Gemini's retry — only worth auto-retrying
      // server-side if the wait is short enough to stay safely within
      // Vercel's function execution timeout. Groq's TPM limit resets
      // quickly by nature (it's a per-minute rolling window), so short
      // waits here are the common case, not the exception.
      if (!_isRetry && retryDelay && retryDelay <= 6) {
        await new Promise(r => setTimeout(r, Math.ceil(retryDelay * 1000) + 300));
        return generateWithGroq(query, apiKey, true);
      }
      const waitMsg = retryDelay ? `Please wait about ${Math.ceil(retryDelay)} seconds and try again.` : 'Please wait a moment and try again.';
      throw new Error(`Groq's free tier rate limit was hit (this resets quickly — it's not an account problem). ${waitMsg}`);
    }
    throw new Error(errMsg || `Groq request failed (${response.status}).`);
  }
  const fullText = data?.choices?.[0]?.message?.content || '';
  return extractJsonProduct(fullText);
}

async function generateWithDeepSeek(query, apiKey, tavilyKey) {
  const messages = [
    { role: 'system', content: DEEPSEEK_SYSTEM_PROMPT },
    { role: 'user', content: `Return complete JSON data for this product: "${query}"` }
  ];

  // DeepSeek can call web_search multiple times (specs, then pricing, then
  // verify a detail) before giving its final answer — this loop lets that
  // happen, capped at 4 rounds so a confused model can't loop forever and
  // rack up search API credits or leave the admin waiting indefinitely.
  for (let round = 0; round < 4; round++) {
    const response = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'deepseek-v4-flash',
        messages,
        tools: tavilyKey ? [WEB_SEARCH_TOOL] : undefined, // no search tool offered at all if no Tavily key configured
        stream: false
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('[AI Product Creator] DeepSeek API error:', data);
      throw new Error(data?.error?.message || `DeepSeek request failed (${response.status}).`);
    }

    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error('DeepSeek returned an empty response.');

    if (message.tool_calls?.length) {
      messages.push(message); // the assistant's own tool-call request goes into history too
      for (const toolCall of message.tool_calls) {
        let result;
        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          result = await searchWeb(args.query || query, tavilyKey);
        } catch (e) {
          result = `Search failed: ${e.message}`;
        }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
      continue; // give DeepSeek the search results, let it decide what to do next
    }

    // No tool call this round — the model is giving its final answer.
    return extractJsonProduct(message.content || '');
  }
  return null; // exhausted rounds without a final answer — treated as a parse failure by the caller
}

// BazaarLink's OpenAI-compatible gateway — auto:free routes to whichever
// underlying free-tier model is available, matching the "genuinely free"
// reasoning already used for Groq elsewhere in this file.
async function generateWithBazaar(query, apiKey, tavilyKey) {
  const messages = [
    { role: 'system', content: BAZAAR_SYSTEM_PROMPT },
    { role: 'user', content: `Return complete JSON data for this product: "${query}"` }
  ];

  for (let round = 0; round < 4; round++) {
    const response = await fetch('https://bazaarlink.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model: 'auto:free',
        messages,
        tools: tavilyKey ? [WEB_SEARCH_TOOL] : undefined,
        stream: false
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('[AI Product Creator] Bazaar API error:', data);
      throw new Error(data?.error?.message || `Bazaar request failed (${response.status}).`);
    }

    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error('Bazaar returned an empty response.');

    if (message.tool_calls?.length) {
      messages.push(message);
      for (const toolCall of message.tool_calls) {
        let result;
        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          result = await searchWeb(args.query || query, tavilyKey);
        } catch (e) {
          result = `Search failed: ${e.message}`;
        }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
      continue;
    }

    return extractJsonProduct(message.content || '');
  }
  return null;
}

// ChatGPT (OpenAI). Model naming here has shifted multiple times over
// this project's lifetime (same issue that hit Gemini earlier) — primary
// model per OpenAI's own current docs, with an automatic fallback to a
// long-standing, widely-available model if the primary one ever comes
// back "not found," so this doesn't need another manual fix if OpenAI
// renames their lineup again.
async function generateWithChatGPT(query, apiKey, tavilyKey, _useFallbackModel = false) {
  const model = _useFallbackModel ? 'gpt-4o-mini' : 'gpt-5.6-terra';
  const messages = [
    { role: 'system', content: CHATGPT_SYSTEM_PROMPT },
    { role: 'user', content: `Return complete JSON data for this product: "${query}"` }
  ];

  for (let round = 0; round < 4; round++) {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        messages,
        tools: tavilyKey ? [WEB_SEARCH_TOOL] : undefined,
      })
    });
    const data = await response.json();
    if (!response.ok) {
      console.error('[AI Product Creator] ChatGPT API error:', data);
      const isModelUnavailable = /model|does not exist|not found/i.test(data?.error?.message || '') && (data?.error?.code === 'model_not_found' || response.status === 404);
      if (isModelUnavailable && !_useFallbackModel) {
        console.error('[AI Product Creator] Model unavailable, retrying with gpt-4o-mini fallback');
        return generateWithChatGPT(query, apiKey, tavilyKey, true);
      }
      throw new Error(data?.error?.message || `ChatGPT request failed (${response.status}).`);
    }

    const message = data?.choices?.[0]?.message;
    if (!message) throw new Error('ChatGPT returned an empty response.');

    if (message.tool_calls?.length) {
      messages.push(message);
      for (const toolCall of message.tool_calls) {
        let result;
        try {
          const args = JSON.parse(toolCall.function.arguments || '{}');
          result = await searchWeb(args.query || query, tavilyKey);
        } catch (e) {
          result = `Search failed: ${e.message}`;
        }
        messages.push({ role: 'tool', tool_call_id: toolCall.id, content: result });
      }
      continue;
    }

    return extractJsonProduct(message.content || '');
  }
  return null;
}

/**
 * Resolves the right API key(s) and calls the right generation function
 * for whichever provider was selected — the one place this logic lives,
 * used by both /generate-product and /generate-product-bulk. Throws with
 * a clear, actionable message (missing key, generation failure, etc.)
 * rather than returning null, so callers can just try/catch.
 */
/**
 * Resolves just the API key(s) for a provider — no network call to the AI
 * provider itself, only (at most) a DB lookup against the API Console
 * vault. Kept separate from generateProductWithProvider specifically so
 * the bulk endpoint can validate "is this provider even configured?"
 * upfront, without spending a real API request just to find out.
 */
async function resolveProviderKeys(provider) {
  if (provider === 'chatgpt') {
    const openaiKey = (await getCredentialValue('ChatGPT', 'API Key')) || process.env.OPENAI_API_KEY;
    if (!openaiKey) {
      throw new Error('No ChatGPT (OpenAI) API key configured. Add one in Admin \u2192 API Console (Service: "ChatGPT", Key Label: "API Key"), or set OPENAI_API_KEY as an environment variable.');
    }
    const tavilyKey = (await getCredentialValue('Tavily', 'API Key')) || process.env.TAVILY_API_KEY;
    return { primary: openaiKey, tavily: tavilyKey };
  }
  if (provider === 'bazaar') {
    const bazaarKey = (await getCredentialValue('Bazaar', 'API Key')) || process.env.BAZAAR_API_KEY;
    if (!bazaarKey) {
      throw new Error('No Bazaar API key configured. Add one in Admin \u2192 API Console (Service: "Bazaar", Key Label: "API Key"), or set BAZAAR_API_KEY as an environment variable.');
    }
    // Tavily gives Bazaar live web search via function calling, same
    // reasoning as DeepSeek — BazaarLink is a multi-model gateway, not
    // confirmed to have its own native search.
    const tavilyKey = (await getCredentialValue('Tavily', 'API Key')) || process.env.TAVILY_API_KEY;
    return { primary: bazaarKey, tavily: tavilyKey };
  }
  if (provider === 'groq') {
    const groqKey = (await getCredentialValue('Groq', 'API Key')) || process.env.GROQ_API_KEY;
    if (!groqKey) {
      throw new Error('No Groq API key configured. Add one in Admin \u2192 API Console (Service: "Groq", Key Label: "API Key"), or set GROQ_API_KEY as an environment variable.');
    }
    // No Tavily needed here either — groq/compound's web search is native.
    return { primary: groqKey };
  }
  if (provider === 'glm') {
    // GLM-4.7 was configured with the Vercel environment variable literally
    // named "GLM-4.7" — not valid as process.env.GLM-4.7 (JS would parse
    // the hyphen as subtraction), so bracket notation is required to read
    // it at all. GLM_API_KEY is offered too as the more conventional name,
    // in case this ever gets renamed to something less unusual.
    const glmKey = (await getCredentialValue('GLM', 'API Key')) || process.env['GLM-4.7'] || process.env.GLM_API_KEY;
    if (!glmKey) {
      throw new Error('No GLM API key configured. Add one in Admin \u2192 API Console (Service: "GLM", Key Label: "API Key"), or set it as an environment variable.');
    }
    // No Tavily needed here — GLM's web_search is native, unlike DeepSeek's.
    return { primary: glmKey };
  }
  if (provider === 'deepseek') {
    // Checks the API Console vault first (service_name='DeepSeek',
    // key_label='API Key'), then falls back to an environment variable.
    // Reading process.env.Infraconnect specifically because that's the
    // exact variable name already configured for this project — most
    // setups would instead use something like DEEPSEEK_API_KEY, but
    // this matches what's actually deployed rather than requiring a
    // Vercel reconfiguration.
    const deepseekKey = (await getCredentialValue('DeepSeek', 'API Key')) || process.env.Infraconnect || process.env.DEEPSEEK_API_KEY;
    if (!deepseekKey) {
      throw new Error('No DeepSeek API key configured. Add one in Admin \u2192 API Console (Service: "DeepSeek", Key Label: "API Key"), or set it as an environment variable.');
    }
    // Tavily is what actually gives DeepSeek live web search — without
    // it, DeepSeek still works, just falls back to training-data-only
    // (the tools array is omitted entirely in that case, so DeepSeek
    // never attempts a search it has no way to fulfill).
    const tavilyKey = (await getCredentialValue('Tavily', 'API Key')) || process.env.TAVILY_API_KEY;
    return { primary: deepseekKey, tavily: tavilyKey };
  }
  // Default: gemini
  const geminiKey = (await getCredentialValue('Gemini', 'API Key')) || process.env.GEMINI_API_KEY;
  if (!geminiKey) {
    throw new Error('No Gemini API key configured. Add one in Admin \u2192 API Console (Service: "Gemini", Key Label: "API Key"), or set GEMINI_API_KEY as an environment variable and redeploy.');
  }
  return { primary: geminiKey };
}

/**
 * Resolves keys and calls the right generation function for whichever
 * provider was selected — the one place this dispatch logic lives, used
 * by both /generate-product and /generate-product-bulk. Throws with a
 * clear, actionable message rather than returning null, so callers can
 * just try/catch.
 */
async function generateProductWithProvider(provider, query) {
  const keys = await resolveProviderKeys(provider);
  if (provider === 'chatgpt') return generateWithChatGPT(query, keys.primary, keys.tavily);
  if (provider === 'bazaar') return generateWithBazaar(query, keys.primary, keys.tavily);
  if (provider === 'groq') return generateWithGroq(query, keys.primary);
  if (provider === 'glm') return generateWithGLM(query, keys.primary);
  if (provider === 'deepseek') return generateWithDeepSeek(query, keys.primary, keys.tavily);
  return generateWithGemini(query, keys.primary);
}

router.post('/generate-product', auth, requireAdmin, async (req, res, next) => {
  try {
    const { query, provider } = req.body;
    if (!query || !query.trim()) return res.status(400).json({ error: 'Product query is required.' });
    const selectedProvider = ['deepseek', 'glm', 'groq', 'bazaar', 'chatgpt'].includes(provider) ? provider : 'gemini'; // default to gemini

    let product;
    try {
      product = await generateProductWithProvider(selectedProvider, query.trim());
    } catch (e) {
      return res.status(502).json({ error: e.message });
    }

    if (!product) {
      console.error('[AI Product Creator] Could not parse AI response for provider:', selectedProvider);
      return res.status(502).json({ error: 'AI response could not be parsed. Try again or use manual entry.' });
    }

    // Attempt to download the suggested image so it actually works instead
    // of being a fragile external hotlink. Failure here is never fatal to
    // the request — the rest of the product data is still useful even
    // without a photo, so the admin just gets prompted to upload one.
    // DeepSeek's image_url is especially likely to be stale/wrong (no live
    // search to verify it), so this matters even more for that provider.
    product.image_local_path = await downloadProductImage(product.image_url);
    product.provider_used = selectedProvider;

    res.json({ product });
  } catch (err) { next(err); }
});

/**
 * Runs async tasks with a maximum number running at once — a minimal
 * concurrency limiter rather than pulling in p-limit as a dependency for
 * something this small. Tasks are started in order, but don't block each
 * other beyond the concurrency cap; a slow task doesn't stall the ones
 * behind it once a slot frees up.
 */
async function runWithConcurrencyLimit(items, limit, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function runNext() {
    while (nextIndex < items.length) {
      const i = nextIndex++;
      results[i] = await worker(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, runNext));
  return results;
}

// Maps a generated product (whichever provider produced it, same shape
// either way) onto the exact column names routes/bulk.js's Excel template
// expects, PLUS the Arabic translation fields and condition that single-
// product generation already captures — these were previously dropped
// here entirely, which is why bulk results looked less complete.
function toBulkRow(product) {
  return {
    name: product.name || '',
    name_ar: product.name_ar || '',
    category_slug: product.category_guess || '',
    brand: product.brand || '',
    description: product.description || '',
    description_ar: product.description_ar || '',
    specs: Array.isArray(product.specs) ? product.specs.join('|') : (product.specs || ''),
    specs_ar: Array.isArray(product.specs_ar) ? product.specs_ar.join('|') : (product.specs_ar || ''),
    price_label: product.price_note || '',
    price_amount: Number(product.price_usd) || 0,
    currency: 'USD',
    badge: product.badge || '',
    badge_ar: product.badge_ar || '',
    condition: product.condition === 'used' ? 'used' : 'new',
    image_url: product.image_local_path || product.image_url || '', // prefer the downloaded Blob URL if we got one
    gallery_urls: '',
    featured: 0,
    stock_status: 'available',
    installments_enabled: 0,
    installment_months: '',
  };
}

router.post('/generate-product-bulk', auth, requireAdmin, async (req, res, next) => {
  try {
    const { products, provider } = req.body;
    if (!Array.isArray(products) || !products.length) {
      return res.status(400).json({ error: 'Provide a non-empty array of product names.' });
    }
    // Caps the batch size rather than the request timing out silently —
    // Vercel serverless functions have their own execution time limit,
    // and a batch large enough to exceed it would otherwise just fail
    // with no useful error at all.
    if (products.length > 50) {
      return res.status(400).json({ error: 'Maximum 50 products per batch — split into smaller batches.' });
    }
    const selectedProvider = ['deepseek', 'glm', 'groq', 'bazaar', 'chatgpt'].includes(provider) ? provider : 'gemini';

    // Fail fast on a missing key rather than burning through the whole
    // batch with 50 identical "no key configured" failures.
    try {
      await resolveProviderKeys(selectedProvider);
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }

    const cleanNames = products.map(p => String(p || '').trim()).filter(Boolean);
    const failedItems = [];

    // Gemini's free tier allows far fewer requests per minute than
    // DeepSeek's or GLM's — 5 simultaneous calls burns through it almost
    // immediately for anything beyond a handful of products (this is
    // exactly what caused the "quota exceeded" error seen in testing).
    const concurrency = selectedProvider === 'gemini' ? 2 : 5;
    const rawResults = await runWithConcurrencyLimit(cleanNames, concurrency, async (name) => {
      try {
        const product = await generateProductWithProvider(selectedProvider, name);
        if (!product) { failedItems.push(name); return null; }
        // Same download/validate/trim/re-host pipeline single-product
        // generation uses — matters even more here, since a raw AI-
        // suggested URL is exactly the kind of fragile external hotlink
        // (blocked, stale, wrong page) that this pipeline exists to fix.
        product.image_local_path = await downloadProductImage(product.image_url);
        return toBulkRow(product);
      } catch (e) {
        console.error(`[AI Bulk Generate] Failed for "${name}":`, e.message);
        failedItems.push(name);
        return null;
      }
    });

    const successfulProducts = rawResults.filter(Boolean);

    res.json({
      summary: {
        total_attempted: cleanNames.length,
        successful: successfulProducts.length,
        failed: failedItems.length,
        failed_items: failedItems,
      },
      products: successfulProducts,
    });
  } catch (err) { next(err); }
});

function slugify(s) { return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, ''); }

/**
 * POST /api/ai/bulk-add-to-store
 * Takes the array this endpoint's own /generate-product-bulk returned
 * (after the admin has reviewed it) and actually creates each one as a
 * real product — the "do this directly, like single-product does"
 * counterpart to exporting a CSV and running it through the separate
 * Bulk Upload flow. Reuses the exact same INSERT column set as
 * routes/products.js's single-product POST /, just looped.
 */
router.post('/bulk-add-to-store', auth, requireAdmin, async (req, res, next) => {
  try {
    const { products } = req.body;
    if (!Array.isArray(products) || !products.length) {
      return res.status(400).json({ error: 'No products to add.' });
    }
    const db = getDb();
    const results = { created: 0, skipped: 0, errors: [] };

    for (const p of products) {
      try {
        if (!p.name) { results.skipped++; results.errors.push('A row with no name was skipped.'); continue; }
        const catRow = p.category_slug
          ? await db.prepare('SELECT id FROM categories WHERE slug=? AND active=1').get(p.category_slug)
          : null;
        if (!catRow) {
          results.skipped++;
          results.errors.push(`${p.name}: unknown category "${p.category_slug}"`);
          continue;
        }
        let slug = slugify(p.name);
        if (await db.prepare('SELECT id FROM products WHERE slug=?').get(slug)) slug = slug + '-' + Date.now();

        const images = p.image_url ? [p.image_url] : [];
        await db.prepare(
          `INSERT INTO products(name,slug,category_id,brand,description,specs,name_ar,description_ar,specs_ar,badge_ar,
            price,price_amount,currency,badge,image,images,featured,installments_enabled,installment_months,condition,stock_status)
           VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`
        ).run(
          p.name, slug, catRow.id, p.brand || '', p.description || '', p.specs || '',
          p.name_ar || '', p.description_ar || '', p.specs_ar || '', p.badge_ar || '',
          p.price_label || 'Price on Request', Number(p.price_amount) || 0, p.currency || 'USD', p.badge || '',
          images[0] || null, JSON.stringify(images),
          p.featured ? 1 : 0, p.installments_enabled ? 1 : 0, p.installment_months || '',
          p.condition === 'used' ? 'used' : 'new', p.stock_status || 'available'
        );
        results.created++;
      } catch (e) {
        results.skipped++;
        results.errors.push(`${p.name || 'unnamed'}: ${e.message}`);
      }
    }

    logActivity(req, 'product.bulk_create', 'product', `${results.created} products via AI Bulk Generate`);
    res.json({ message: `${results.created} product(s) added, ${results.skipped} skipped.`, ...results });
  } catch (err) { next(err); }
});

/**
 * Translation doesn't need web search at all — translating text that's
 * already known doesn't require looking anything up — so this calls each
 * provider's plain chat completion directly, skipping the search-enabled
 * path entirely. Meaningfully faster and, just as importantly, doesn't
 * compete with product-generation requests for the same rate-limited
 * search quota (Gemini's free tier especially).
 */
async function translateToArabic(product, provider, keys) {
  const prompt = `Translate this IT/electronics product's fields into professional Modern Standard Arabic (business register, as used on Arabic tech retail sites). Keep brand names and model numbers in Latin script within the Arabic text — e.g. "خادم Dell PowerEdge R750".

Name: ${product.name}
Description: ${product.description || ''}
Specs: ${(product.specs || []).join(' | ')}
Badge: ${product.badge || ''}

Return ONLY a JSON object, no explanation, no markdown:
{"name_ar": "...", "description_ar": "...", "specs_ar": ["...", "..."], "badge_ar": "..."}
If badge is empty, return "" for badge_ar. specs_ar must have the same number of items as Specs, same order.`;

  let url, body, extractText;
  if (provider === 'groq') {
    url = 'https://api.groq.com/openai/v1/chat/completions';
    body = { model: 'groq/compound', messages: [{ role: 'user', content: prompt }] };
    extractText = d => d?.choices?.[0]?.message?.content || '';
  } else if (provider === 'glm') {
    url = 'https://api.z.ai/api/paas/v4/chat/completions';
    body = { model: 'glm-4.7', messages: [{ role: 'user', content: prompt }], stream: false };
    extractText = d => d?.choices?.[0]?.message?.content || '';
  } else if (provider === 'deepseek') {
    url = 'https://api.deepseek.com/chat/completions';
    body = { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: prompt }], stream: false };
    extractText = d => d?.choices?.[0]?.message?.content || '';
  } else {
    // Gemini — plain generateContent, no google_search tool this time
    const model = 'gemini-3.5-flash';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys.primary },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }] })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `Gemini request failed (${response.status}).`);
    let fullText = '';
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) parts.forEach(part => { if (part.text) fullText += part.text; });
    return extractJsonProduct(fullText);
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keys.primary}` },
    body: JSON.stringify(body)
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data?.error?.message || `${provider} request failed (${response.status}).`);
  return extractJsonProduct(extractText(data));
}

/**
 * POST /api/ai/auto-translate
 * Body: { provider, batch_size?, offset? }
 * Fills in Arabic fields for products that don't have them yet — never
 * touches any other field (price, stock, images, etc.), only name_ar/
 * description_ar/specs_ar/badge_ar. Same resumable batch+offset pattern
 * as /api/products/reprocess-images: small batches (serverless execution
 * time limit), safe to interrupt and resume from where it left off, the
 * frontend calls this repeatedly until `remaining` is 0.
 */
router.post('/auto-translate', auth, requireAdmin, async (req, res, next) => {
  try {
    const provider = ['deepseek', 'glm', 'groq', 'bazaar', 'chatgpt'].includes(req.body.provider) ? req.body.provider : 'gemini';
    const batchSize = Math.min(parseInt(req.body.batch_size) || 5, 10);
    const db = getDb();
    // When ids is provided (the admin selected specific products), only
    // those are touched — otherwise falls back to "every product missing
    // a translation," same as before. Filtering by ids AND the missing-
    // translation condition together means a completed item naturally
    // drops out of the next batch on its own, so the exact same resumable
    // loop on the frontend works unchanged for both modes.
    const rawIdsReceived = req.body.ids; // kept for the debug field below, exactly as received, before any parsing
    const ids = Array.isArray(req.body.ids) && req.body.ids.length ? req.body.ids.map(Number).filter(Number.isFinite) : null;
    const idFilter = ids ? ` AND id IN (${ids.map(() => '?').join(',')})` : '';
    console.log('[auto-translate] raw ids received:', JSON.stringify(rawIdsReceived), '| parsed ids:', JSON.stringify(ids));

    let keys;
    try { keys = await resolveProviderKeys(provider); }
    catch (e) { return res.status(500).json({ error: e.message }); }

    const products = await db.prepare(
      `SELECT id, name, description, specs, badge FROM products
       WHERE active=1 AND (name_ar IS NULL OR name_ar='')${idFilter} ORDER BY id LIMIT ?`
    ).all(...(ids || []), batchSize);

    const results = [];
    for (const p of products) {
      try {
        const specsArr = p.specs ? p.specs.split('|') : [];
        const translated = await withRateLimitRetry(() => translateToArabic({ ...p, specs: specsArr }, provider, keys));
        if (!translated) { results.push({ id: p.id, name: p.name, status: 'failed (no response)' }); continue; }
        const specsArStr = Array.isArray(translated.specs_ar) ? translated.specs_ar.join('|') : (translated.specs_ar || '');
        await db.prepare(
          `UPDATE products SET name_ar=?, description_ar=?, specs_ar=?, badge_ar=?, updated_at=datetime('now') WHERE id=?`
        ).run(translated.name_ar || '', translated.description_ar || '', specsArStr, translated.badge_ar || '', p.id);
        results.push({ id: p.id, name: p.name, status: 'translated' });
      } catch (e) {
        results.push({ id: p.id, name: p.name, status: 'failed: ' + e.message });
      }
    }

    const remainingRow = await db.prepare(`SELECT COUNT(*) as c FROM products WHERE active=1 AND (name_ar IS NULL OR name_ar='')${idFilter}`).get(...(ids || []));
    res.json({
      processed: products.length, results, remaining: Number(remainingRow.c),
      // Visible directly in the admin UI (not just server logs) so the
      // actual scope used is undeniable on the very next test — either
      // this confirms the fix works, or it shows exactly where a
      // mismatch is happening (e.g. ids received as an empty array,
      // or as strings that failed the Number.isFinite filter).
      debug: { received_ids: rawIdsReceived ?? null, used_ids_count: ids ? ids.length : null, scope: ids ? 'selected' : 'all' }
    });
  } catch (err) { next(err); }
});

/**
 * Lean, image-only version of the full product generation — asks for
 * just an image URL instead of complete product data, which is faster,
 * uses fewer tokens, and doesn't risk a provider returning a made-up
 * price or spec for a product whose real data we already trust from the
 * distributor sheet.
 */
async function findProductImageUrl(productName, provider, keys) {
  const prompt = `Find a direct URL to an official product photo (jpg/png, from the manufacturer or a major retailer) for this product: "${productName}". Return ONLY a JSON object, no explanation: {"image_url": "https://..."} or {"image_url": null} if you can't find one.`;

  if (provider === 'gemini') {
    const model = 'gemini-3.5-flash';
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': keys.primary },
      body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], tools: [{ google_search: {} }] })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `Gemini request failed (${response.status}).`);
    let fullText = '';
    const parts = data?.candidates?.[0]?.content?.parts;
    if (Array.isArray(parts)) parts.forEach(part => { if (part.text) fullText += part.text; });
    const parsed = extractJsonProduct(fullText);
    return parsed?.image_url || null;
  }
  if (provider === 'groq') {
    const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keys.primary}` },
      body: JSON.stringify({ model: 'groq/compound', messages: [{ role: 'user', content: prompt }] })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `Groq request failed (${response.status}).`);
    const parsed = extractJsonProduct(data?.choices?.[0]?.message?.content || '');
    return parsed?.image_url || null;
  }
  if (provider === 'glm') {
    const response = await fetch('https://api.z.ai/api/paas/v4/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${keys.primary}` },
      body: JSON.stringify({ model: 'glm-4.7', messages: [{ role: 'user', content: prompt }], tools: [{ type: 'web_search', web_search: { search_query: productName, search_result: true } }], stream: false })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data?.error?.message || `GLM request failed (${response.status}).`);
    const parsed = extractJsonProduct(data?.choices?.[0]?.message?.content || '');
    return parsed?.image_url || null;
  }
  // DeepSeek: needs the full search-tool loop, reuses the existing product generator and just extracts the image_url from it
  const full = await generateWithDeepSeek(productName, keys.primary, keys.tavily);
  return full?.image_url || null;
}

/**
 * POST /api/ai/auto-find-images
 * Body: { provider, batch_size?, offset? }
 * Finds and downloads a photo for products that don't have one yet —
 * only touches image/images, never price/stock/description/etc. Same
 * resumable batch pattern as auto-translate and reprocess-images above.
 */
router.post('/auto-find-images', auth, requireAdmin, async (req, res, next) => {
  try {
    const provider = ['deepseek', 'glm', 'groq', 'bazaar', 'chatgpt'].includes(req.body.provider) ? req.body.provider : 'gemini';
    const batchSize = Math.min(parseInt(req.body.batch_size) || 3, 5); // smaller than translate — each one also does an image download, not just a text call
    const db = getDb();
    const rawIdsReceived = req.body.ids;
    const ids = Array.isArray(req.body.ids) && req.body.ids.length ? req.body.ids.map(Number).filter(Number.isFinite) : null;
    const idFilter = ids ? ` AND id IN (${ids.map(() => '?').join(',')})` : '';
    console.log('[auto-find-images] raw ids received:', JSON.stringify(rawIdsReceived), '| parsed ids:', JSON.stringify(ids));

    let keys;
    try { keys = await resolveProviderKeys(provider); }
    catch (e) { return res.status(500).json({ error: e.message }); }

    const products = await db.prepare(
      `SELECT id, name FROM products WHERE active=1 AND image IS NULL${idFilter} ORDER BY id LIMIT ?`
    ).all(...(ids || []), batchSize);

    const results = [];
    for (const p of products) {
      try {
        const imageUrl = await withRateLimitRetry(() => findProductImageUrl(p.name, provider, keys));
        if (!imageUrl) { results.push({ id: p.id, name: p.name, status: 'no image found' }); continue; }
        const uploaded = await downloadImageFromUrl(imageUrl, 'autofind');
        if (!uploaded) { results.push({ id: p.id, name: p.name, status: 'found a URL but download failed' }); continue; }
        await db.prepare(`UPDATE products SET image=?, images=?, updated_at=datetime('now') WHERE id=?`)
          .run(uploaded, JSON.stringify([uploaded]), p.id);
        results.push({ id: p.id, name: p.name, status: 'image added' });
      } catch (e) {
        results.push({ id: p.id, name: p.name, status: 'failed: ' + e.message });
      }
    }

    const remainingRow = await db.prepare(`SELECT COUNT(*) as c FROM products WHERE active=1 AND image IS NULL${idFilter}`).get(...(ids || []));
    res.json({
      processed: products.length, results, remaining: Number(remainingRow.c),
      debug: { received_ids: rawIdsReceived ?? null, used_ids_count: ids ? ids.length : null, scope: ids ? 'selected' : 'all' }
    });
  } catch (err) { next(err); }
});

module.exports = router;
module.exports.generateWithGemini = generateWithGemini;
module.exports.generateWithDeepSeek = generateWithDeepSeek;
module.exports.generateWithGLM = generateWithGLM;
module.exports.generateWithGroq = generateWithGroq;
module.exports.resolveProviderKeys = resolveProviderKeys;
