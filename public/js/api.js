/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — API Helper Functions
 *  File: public/js/api.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  WHAT THIS FILE DOES:
 *  Provides simple fetch wrapper functions for making API calls.
 *  Loaded on every page that needs to talk to the backend.
 *
 *  FUNCTIONS:
 *
 *  apiGet(url)
 *    Makes an unauthenticated GET request.
 *    Use: Fetching public data like products, categories.
 *    Example: const data = await apiGet('/api/products?limit=20');
 *
 *  apiPost(url, body)
 *    Makes an unauthenticated POST request with JSON body.
 *    Use: Submitting contact forms, checkout orders.
 *    Example: await apiPost('/api/contact/contact', { email, message });
 *
 *  apiAuth(method, url, body)
 *    Makes an authenticated request (includes JWT token from localStorage).
 *    Automatically redirects to /admin login if token is expired (401).
 *    Use: All admin panel API calls.
 *    Example: const d = await apiAuth('GET', '/api/dashboard/stats');
 *
 *  apiAuthUpload(method, url, formData)
 *    Same as apiAuth but sends FormData instead of JSON.
 *    Use: Product image uploads, bulk file upload.
 *    Example: await apiAuthUpload('POST', '/api/products', formData);
 *
 *  TOKEN STORAGE:
 *  - JWT token stored in localStorage as 'ic_admin_token'
 *  - Set after successful login in admin panel
 *  - Cleared on logout or 401 response
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
const API = '';

// FE-02 fix: previously these called r.json() unconditionally. A 500
// response (or a proxy/hosting error page) returns HTML, not JSON, and
// r.json() on that throws — the fetch would fail silently with no
// indication of what happened. Now failures return a normal
// { error: '...' } shape so existing `if (d.error)` checks in the admin
// panel and forms keep working, and everything is also logged to console.
async function safeJson(r, context) {
  let data = null;
  try { data = await r.json(); } catch { /* non-JSON body, e.g. an HTML error page */ }
  if (!r.ok) {
    const msg = (data && data.error) || `Request failed (${r.status})`;
    console.error(`[API] ${context} failed:`, r.status, msg);
    return { error: msg };
  }
  return data ?? {};
}

async function apiGet(url){
  try { const r = await fetch(API+url); return await safeJson(r, `GET ${url}`); }
  catch (e) { console.error(`[API] GET ${url} network error:`, e); return { error: 'Network error — please check your connection.' }; }
}
async function apiPost(url,body){
  try {
    const r = await fetch(API+url,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    return await safeJson(r, `POST ${url}`);
  } catch (e) { console.error(`[API] POST ${url} network error:`, e); return { error: 'Network error — please check your connection.' }; }
}
async function apiAuth(method,url,body){
  const token=localStorage.getItem('ic_admin_token');
  const opts={method,headers:{'Content-Type':'application/json','Authorization':'Bearer '+token}};
  if(body) opts.body=JSON.stringify(body);
  try {
    const r=await fetch(API+url,opts);
    if(r.status===401){ localStorage.removeItem('ic_admin_token'); window.location.href='/admin'; return null; }
    return await safeJson(r, `${method} ${url}`);
  } catch (e) { console.error(`[API] ${method} ${url} network error:`, e); return { error: 'Network error — please check your connection.' }; }
}
async function apiAuthUpload(method,url,form){
  const token=localStorage.getItem('ic_admin_token');
  try {
    const r=await fetch(API+url,{method,headers:{'Authorization':'Bearer '+token},body:form});
    if(r.status===401){ localStorage.removeItem('ic_admin_token'); window.location.href='/admin'; return null; }
    return await safeJson(r, `${method} ${url}`);
  } catch (e) { console.error(`[API] ${method} ${url} network error:`, e); return { error: 'Network error — please check your connection.' }; }
}
