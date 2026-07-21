/* ── CONFIG ───────────────────────────────────────────────────── */
const API_BASE = '/api';
/*
 * NOTE (audit fix, BUG-04 / BUG-05): this file used to define its own
 * CART_KEY ('ic_cart_v2') and Cart object, out of sync with the real cart
 * engine in cart.js ('ic_cart_v4'). It also defined a duplicate `API`
 * global that could collide with public/js/api.js if both were ever
 * loaded on the same page. Both were removed — this page now loads
 * cart.js first and uses its getCart()/refreshCartUI()/CART_KEY as the
 * single source of truth for the cart badge.
 */

/* ── TOAST ────────────────────────────────────────────────────── */
const Toast = {
  container: null,
  init() {
    if (!this.container) {
      this.container = document.createElement('div');
      this.container.id = 'toast-container';
      document.body.appendChild(this.container);
    }
  },
  show(msg, type = 'info', duration = 4000) {
    this.init();
    const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.innerHTML = `<span class="toast-icon">${icons[type]||'ℹ️'}</span><span class="toast-msg">${msg}</span><button class="toast-close" onclick="this.parentElement.remove()">×</button>`;
    this.container.appendChild(el);
    setTimeout(() => el.remove(), duration);
  }
};

/* ── NAVBAR ───────────────────────────────────────────────────── */
function initNavbar() {
  if (typeof refreshCartUI === 'function') refreshCartUI(); // from cart.js
  // Scroll effect
  window.addEventListener('scroll', () => {
    document.querySelector('.navbar')?.classList.toggle('scrolled', window.scrollY > 10);
  });
  // Mobile menu
  const ham = document.querySelector('.hamburger');
  const mob = document.querySelector('.mobile-nav');
  if (ham && mob) ham.addEventListener('click', () => mob.classList.toggle('open'));
  // Active link
  const path = window.location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.navbar-links a, .mobile-nav a').forEach(a => {
    const href = a.getAttribute('href')?.split('/').pop() || '';
    if (href === path || (path === 'index.html' && href === '') || (path === '' && href === 'index.html')) a.classList.add('active');
  });
}

/* ── FORMAT DATE ──────────────────────────────────────────────── */
function formatDate(str) {
  if (!str) return '—';
  return new Date(str).toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' });
}

/* ── INIT ─────────────────────────────────────────────────────── */
document.addEventListener('DOMContentLoaded', initNavbar);
