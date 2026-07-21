/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Cart Engine
 *  File: public/js/cart.js
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  WHAT THIS FILE DOES:
 *  Manages the shopping cart using localStorage. Loaded on every page.
 *
 *  CART STORAGE:
 *  - Key: 'ic_cart_v4' in localStorage
 *  - Format: JSON array of cart item objects
 *
 *  CART ITEM STRUCTURE:
 *  {
 *    id:                  string  - product slug (unique identifier)
 *    name:                string  - product display name
 *    category:            string  - category name
 *    price:               string  - display price label (e.g. "$1,299")
 *    priceAmount:         number  - numeric price for calculations (0 = on request)
 *    currency:            string  - "USD", "EGP", or "AED"
 *    qty:                 number  - quantity in cart
 *    installments_enabled: number - 1 if product supports installments
 *    installment_months:  string  - "all" or "6,12,18,24"
 *    chosen_months:       number  - 0 = full payment, 6/12/18/24 = installment plan
 *  }
 *
 *  VAT RATES (used for installment & total calculations):
 *    USD → 15%  |  EGP → 14%  |  AED → 5%
 *
 *  KEY FUNCTIONS:
 *
 *  addToCart(id, name, category, price, priceAmount, currency,
 *            qty, instEnabled, instMonths, chosenMonths)
 *    Adds item to cart or increments qty if already exists.
 *    Shows a toast notification with "View Cart" link.
 *
 *  addToCartById(slug)
 *    Safe wrapper — reads product data from data-* attributes on the button element.
 *    Used by store cards to avoid escaping issues with product names containing quotes.
 *
 *  removeFromCart(id)       - Remove item by product slug
 *  updateQty(id, qty)       - Change quantity of an item
 *  clearCart()              - Empty the entire cart
 *  getCartCount()           - Total number of items (sum of all quantities)
 *  refreshCartUI()          - Updates all cart badge counters on the page
 *  fmtPrice(amount, currency) - Format price with correct currency symbol
 *  getVAT(currency)         - Returns VAT rate (0.15, 0.14, or 0.05)
 *  vatLabel(currency)       - Returns human-readable VAT label
 *  showToast(msg, type, extra) - Shows a popup notification (success/error/info)
 *
 *  HOW TO ADD TO CART FROM A PRODUCT CARD (store page):
 *  Use data attributes on the button — avoids JS string escaping bugs:
 *    <button
 *      data-slug="macbook-pro-m4"
 *      data-name="Apple MacBook Pro 14&quot; M4"
 *      data-category="Laptops"
 *      data-price="$1,999"
 *      data-amount="1999"
 *      data-currency="USD"
 *      data-inst-enabled="1"
 *      data-inst-months="6,12,18,24"
 *      onclick="addToCartById('macbook-pro-m4')">
 *      Add to Cart
 *    </button>
 *
 * ═══════════════════════════════════════════════════════════════════════════
 */
// ── CART ENGINE ───────────────────────────────────────────────────────────────
const CART_KEY = 'ic_cart_v4';

function getCart() {
  try { return JSON.parse(localStorage.getItem(CART_KEY)) || []; } catch { return []; }
}
function saveCart(c) {
  localStorage.setItem(CART_KEY, JSON.stringify(c));
  refreshCartUI();
}

function addToCart(id, name, category, price, priceAmount, currency, qty, instEnabled, instMonths, chosenMonths) {
  qty = parseInt(qty) || 1;
  const c = getCart();
  const ex = c.find(i => i.id === id);
  if (ex) {
    ex.qty += qty;
  } else {
    c.push({
      id,
      name,
      category,
      price,
      priceAmount: parseFloat(priceAmount) || 0,
      currency: currency || 'USD',
      qty,
      installments_enabled: instEnabled || 0,
      installment_months: instMonths || '',
      chosen_months: parseInt(chosenMonths) || 0   // 0 = full payment, >0 = installment
    });
  }
  saveCart(c);
  showToast(`<strong>${escHtml(name)}</strong> added to cart!`, 'success',
    `<a href="/cart" style="color:#1a56db;font-weight:700;margin-left:10px;text-decoration:none;">View Cart →</a>`);
}

// Safe add — used by store cards via data attributes (avoids quote escaping)
function addToCartById(slug) {
  const el = document.querySelector(`[data-slug="${slug}"]`);
  if (!el) return;
  addToCart(
    el.dataset.slug,
    el.dataset.name,
    el.dataset.category,
    el.dataset.price,
    parseFloat(el.dataset.amount) || 0,
    el.dataset.currency || 'USD',
    1,
    parseInt(el.dataset.instEnabled) || 0,
    el.dataset.instMonths || '',
    0   // no installment plan chosen yet from store card
  );
}

function removeFromCart(id) { saveCart(getCart().filter(i => i.id !== id)); }
function updateQty(id, qty) {
  const c = getCart(), item = c.find(x => x.id === id);
  if (item) { item.qty = Math.max(1, parseInt(qty) || 1); saveCart(c); }
}
function clearCart() { localStorage.removeItem(CART_KEY); refreshCartUI(); }
function getCartCount() { return getCart().reduce((s, i) => s + i.qty, 0); }

function refreshCartUI() {
  const n = getCartCount();
  document.querySelectorAll('.cart-badge').forEach(el => {
    el.textContent = n;
    el.classList.toggle('show', n > 0);
  });
}

// ── CURRENCY & VAT ────────────────────────────────────────────────────────────
function getVAT(currency) {
  if (currency === 'EGP') return 0.14;
  if (currency === 'AED') return 0.05;
  return 0.15;
}
function vatLabel(currency) {
  if (currency === 'EGP') return '14% VAT (Egypt)';
  if (currency === 'AED') return '5% VAT (UAE)';
  return '15% VAT est.';
}
function fmtPrice(amount, currency) {
  if (!amount || amount === 0) return null;
  const n = parseFloat(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  if (currency === 'EGP') return 'EGP ' + n;
  if (currency === 'AED') return 'AED ' + n;
  return '$' + n;
}

// ── TOAST ─────────────────────────────────────────────────────────────────────
function showToast(msg, type = 'info', extra = '') {
  let c = document.getElementById('toast-container');
  if (!c) { c = document.createElement('div'); c.id = 'toast-container'; document.body.appendChild(c); }
  const t = document.createElement('div');
  t.className = `toast ${type}`;
  t.innerHTML = msg + extra;
  c.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}
// Legacy alias
function toast(msg, type, extra) { showToast(msg, type, extra); }

function escHtml(s) {
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
}

document.addEventListener('DOMContentLoaded', refreshCartUI);
