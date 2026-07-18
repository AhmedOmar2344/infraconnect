/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Account Dropdown (signed-in customers)
 *  File: public/js/account-dropdown.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Self-injecting, included as a single <script> tag on every public page
 *  (same pattern as chat-widget.js). Enhances the existing "My Account"
 *  navbar icon (#navAccountBtn) for signed-in customers only:
 *   - Not signed in: icon behaves exactly as before, a plain link to /account.
 *   - Signed in: clicking it opens a dropdown (Profile, Orders, Order
 *     Tracking, Refund Requests, Sign Out) instead of navigating away,
 *     available from every page site-wide, not just the account page.
 * ═══════════════════════════════════════════════════════════════════════════
 */
(function () {
  const CUST_TOKEN_KEY = 'ic_customer_token';
  const CUST_DATA_KEY = 'ic_customer_data';

  function getAccountUrl() {
    // Matches whichever URL convention this page already uses for its own
    // account link (.html suffix or clean URL) rather than assuming one.
    const btn = document.getElementById('navAccountBtn');
    return btn ? btn.getAttribute('href') : '/account';
  }

  function buildMenu() {
    const accountUrl = getAccountUrl();
    const custData = JSON.parse(localStorage.getItem(CUST_DATA_KEY) || '{}');
    const menu = document.createElement('div');
    menu.id = 'icAccountMenu';
    menu.innerHTML = `
      <div class="ic-am-header">
        <div class="ic-am-name">${escapeHtml(custData.name || 'My Account')}</div>
        <div class="ic-am-email">${escapeHtml(custData.email || '')}</div>
      </div>
      <a href="${accountUrl}#profile">👤 Profile</a>
      <a href="${accountUrl}#orders">📦 Orders</a>
      <a href="${accountUrl}#tracking">🚚 Order Tracking</a>
      <a href="${accountUrl}#refunds">↩️ Refund Requests</a>
      <div class="ic-am-divider"></div>
      <a href="#" id="icAmSignOut">🚪 Sign Out</a>
    `;
    return menu;
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function injectStyles() {
    const style = document.createElement('style');
    style.textContent = `
      #icAccountMenu{position:fixed;background:#fff;border:1px solid #e2e8f0;border-radius:12px;box-shadow:0 8px 28px rgba(0,0,0,.12);min-width:200px;z-index:9999;display:none;overflow:hidden;font-family:'Inter',sans-serif;}
      #icAccountMenu.open{display:block;}
      .ic-am-header{padding:14px 16px;border-bottom:1px solid #f1f5f9;background:#f8fafc;}
      .ic-am-name{font-weight:700;font-size:13px;color:#0f172a;}
      .ic-am-email{font-size:11px;color:#94a3b8;margin-top:2px;}
      #icAccountMenu a{display:block;padding:11px 16px;font-size:13px;color:#334155;text-decoration:none;transition:background .12s;}
      #icAccountMenu a:hover{background:#f1f5f9;}
      .ic-am-divider{height:1px;background:#f1f5f9;margin:4px 0;}
      #icAmSignOut{color:#dc2626 !important;}
    `;
    document.head.appendChild(style);
  }

  // position:fixed + the icon's actual on-screen coordinates (rather than
  // position:absolute relying on a positioned ancestor) — the previous
  // version positioned the menu relative to the *entire* .navbar-actions
  // bar (cart icon, buttons, language switcher and all), not the account
  // icon specifically, so it could land far from the icon depending on
  // how much else was in that container. This is anchored to the icon
  // itself, wherever it actually renders, and stays anchored on
  // scroll/resize too.
  function positionMenu(menu, anchor) {
    const rect = anchor.getBoundingClientRect();
    const isRtl = document.documentElement.getAttribute('dir') === 'rtl';
    menu.style.top = (rect.bottom + 8) + 'px';
    if (isRtl) {
      menu.style.left = rect.left + 'px';
      menu.style.right = 'auto';
    } else {
      menu.style.right = (window.innerWidth - rect.right) + 'px';
      menu.style.left = 'auto';
    }
  }

  function enableDropdown() {
    const btn = document.getElementById('navAccountBtn');
    if (!btn) return;
    injectStyles();
    const menu = buildMenu();
    // Appended to <body>, not the icon's own parent — position:fixed
    // doesn't need a specific parent, and this avoids the menu getting
    // silently clipped by any ancestor with overflow:hidden (the navbar
    // itself uses that for other reasons on some pages).
    document.body.appendChild(menu);

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      const isOpening = !menu.classList.contains('open');
      if (isOpening) positionMenu(menu, btn); // recalculate every open, not just once at setup — a stale position would show after any window resize otherwise
      menu.classList.toggle('open');
    });
    document.addEventListener('click', (e) => {
      if (!menu.contains(e.target) && e.target !== btn && !btn.contains(e.target)) {
        menu.classList.remove('open');
      }
    });
    window.addEventListener('resize', () => {
      if (menu.classList.contains('open')) positionMenu(menu, btn);
    });
    document.getElementById('icAmSignOut').addEventListener('click', (e) => {
      e.preventDefault();
      localStorage.removeItem(CUST_TOKEN_KEY);
      localStorage.removeItem(CUST_DATA_KEY);
      window.location.href = getAccountUrl();
    });
  }

  function init() {
    if (localStorage.getItem(CUST_TOKEN_KEY)) enableDropdown();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
