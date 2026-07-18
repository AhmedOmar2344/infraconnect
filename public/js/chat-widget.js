/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Chat Support Widget
 *  File: public/js/chat-widget.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  Self-injecting floating chat bubble, included as a single <script> tag
 *  on every public page (same pattern as cart.js / i18n.js). Polling-based
 *  — checks for new messages every 5 seconds while the window is open,
 *  not real-time. That's a deliberate tradeoff: this runs entirely on our
 *  own server rather than a third-party chat service, and Vercel's
 *  serverless functions don't hold persistent WebSocket connections well.
 *
 *  Visitor identity is a random session_id stored in localStorage — there's
 *  no visitor login system, so this is what ties a visitor's messages into
 *  one conversation thread across page loads and repeat visits.
 * ═══════════════════════════════════════════════════════════════════════════
 */
(function () {
  const SESSION_KEY = 'ic_chat_session';
  const NAME_KEY = 'ic_chat_name';
  let pollTimer = null;
  let isOpen = false;
  let conversationStarted = false;

  function getSessionId() {
    let id = localStorage.getItem(SESSION_KEY);
    if (!id) {
      id = 'chat_' + Date.now() + '_' + Math.random().toString(36).slice(2, 12);
      localStorage.setItem(SESSION_KEY, id);
    }
    return id;
  }

  function injectWidget() {
    const style = document.createElement('style');
    style.textContent = `
      .ic-chat-btn{position:fixed;bottom:110px;right:32px;width:60px;height:60px;border-radius:50%;background:#1a56db;color:#fff;border:none;cursor:pointer;box-shadow:0 4px 18px rgba(26,86,219,.45);z-index:998;display:flex;align-items:center;justify-content:center;transition:transform .2s;}
      .ic-chat-btn:hover{transform:scale(1.08);}
      .ic-chat-btn svg{width:26px;height:26px;}
      @media(max-width:480px){.ic-chat-btn{bottom:92px;right:20px;width:52px;height:52px;}}
      .ic-chat-win{position:fixed;bottom:180px;right:32px;width:340px;max-width:calc(100vw - 40px);height:440px;max-height:calc(100vh - 220px);background:#fff;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.18);z-index:999;display:none;flex-direction:column;overflow:hidden;font-family:'Inter',sans-serif;}
      .ic-chat-win.open{display:flex;}
      .ic-chat-hdr{background:#1a56db;color:#fff;padding:14px 16px;display:flex;justify-content:space-between;align-items:center;font-weight:700;font-size:14px;}
      .ic-chat-hdr button{background:none;border:none;color:#fff;cursor:pointer;font-size:18px;opacity:.85;}
      .ic-chat-body{flex:1;overflow-y:auto;padding:14px;background:#f8fafc;display:flex;flex-direction:column;gap:8px;}
      .ic-chat-msg{max-width:78%;padding:8px 12px;border-radius:12px;font-size:13px;line-height:1.5;word-wrap:break-word;}
      .ic-chat-msg.visitor{align-self:flex-end;background:#1a56db;color:#fff;border-bottom-right-radius:3px;}
      .ic-chat-msg.admin{align-self:flex-start;background:#e5e7eb;color:#111827;border-bottom-left-radius:3px;}
      .ic-chat-intro{padding:16px;font-size:13px;color:#475569;}
      .ic-chat-intro input{width:100%;padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:8px;font-size:13px;margin-top:8px;box-sizing:border-box;}
      .ic-chat-intro button{width:100%;margin-top:10px;padding:9px;background:#1a56db;color:#fff;border:none;border-radius:8px;font-weight:700;font-size:13px;cursor:pointer;}
      .ic-chat-input-row{display:flex;gap:8px;padding:10px;border-top:1px solid #e5e7eb;background:#fff;}
      .ic-chat-input-row input{flex:1;padding:9px 12px;border:1.5px solid #e2e8f0;border-radius:20px;font-size:13px;outline:none;}
      .ic-chat-input-row button{width:38px;height:38px;border-radius:50%;background:#1a56db;color:#fff;border:none;cursor:pointer;flex-shrink:0;display:flex;align-items:center;justify-content:center;}
      [dir="rtl"] .ic-chat-btn,[dir="rtl"] .ic-chat-win{right:auto;left:32px;}
      [dir="rtl"] .ic-chat-msg.visitor{align-self:flex-start;border-bottom-right-radius:12px;border-bottom-left-radius:3px;}
      [dir="rtl"] .ic-chat-msg.admin{align-self:flex-end;border-bottom-left-radius:12px;border-bottom-right-radius:3px;}
    `;
    document.head.appendChild(style);

    const btn = document.createElement('button');
    btn.className = 'ic-chat-btn';
    btn.setAttribute('aria-label', 'Chat with us');
    btn.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/></svg>`;
    btn.onclick = toggleWindow;

    const win = document.createElement('div');
    win.className = 'ic-chat-win';
    win.id = 'icChatWin';
    win.innerHTML = `
      <div class="ic-chat-hdr"><span>💬 Chat with InfraConnect</span><div style="display:flex;gap:10px;align-items:center;"><button onclick="window.__icChatEnd()" id="icChatEndBtn" style="display:none;font-size:11px;font-weight:400;text-decoration:underline;opacity:.85;">End Chat</button><button onclick="window.__icChatClose()">✕</button></div></div>
      <div class="ic-chat-body" id="icChatBody"></div>
      <div class="ic-chat-ended" id="icChatEnded" style="display:none;padding:14px;text-align:center;border-top:1px solid #e5e7eb;background:#fff;">
        <div style="font-size:13px;color:#64748b;margin-bottom:10px;">This conversation has ended.</div>
        <button onclick="window.__icChatNew()" style="padding:9px 18px;background:#1a56db;color:#fff;border:none;border-radius:20px;font-weight:700;font-size:13px;cursor:pointer;">Start New Chat</button>
      </div>
      <div class="ic-chat-input-row" id="icChatInputRow" style="display:none;">
        <input id="icChatInput" placeholder="Type a message..." onkeydown="if(event.key==='Enter'){window.__icChatSend();}"/>
        <button onclick="window.__icChatSend()"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="16" height="16"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
      </div>
    `;
    document.body.appendChild(btn);
    document.body.appendChild(win);

    window.__icChatClose = closeWindow;
    window.__icChatSend = sendMessage;
    window.__icChatStart = startConversation;
    window.__icChatEnd = endConversation;
    window.__icChatNew = startNewConversation;
  }

  function toggleWindow() {
    isOpen ? closeWindow() : openWindow();
  }

  function openWindow() {
    isOpen = true;
    document.getElementById('icChatWin').classList.add('open');
    const savedName = localStorage.getItem(NAME_KEY);
    if (!conversationStarted && savedName) {
      startConversation(savedName);
    } else if (!conversationStarted) {
      renderIntro();
    }
    if (conversationStarted) startPolling();
  }

  function closeWindow() {
    isOpen = false;
    document.getElementById('icChatWin').classList.remove('open');
    stopPolling();
  }

  function renderIntro() {
    document.getElementById('icChatBody').innerHTML = `
      <div class="ic-chat-intro">
        👋 Hi! What's your name so our team knows who they're chatting with?
        <input id="icChatNameInput" placeholder="Your name" onkeydown="if(event.key==='Enter'){window.__icChatStart(document.getElementById('icChatNameInput').value)}"/>
        <button onclick="window.__icChatStart(document.getElementById('icChatNameInput').value)">Start Chat</button>
      </div>`;
  }

  async function startConversation(name) {
    const trimmedName = (name || '').trim();
    if (!trimmedName) { return; }
    localStorage.setItem(NAME_KEY, trimmedName);
    try {
      const res = await fetch('/api/chat/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: getSessionId(), visitor_name: trimmedName })
      });
      if (!res.ok) throw new Error('failed');
      conversationStarted = true;
      document.getElementById('icChatInputRow').style.display = 'flex';
      document.getElementById('icChatBody').innerHTML = '';
      await fetchMessages();
      startPolling();
    } catch (e) {
      document.getElementById('icChatBody').innerHTML = '<div class="ic-chat-intro">Could not connect right now — please try again in a moment, or use the Contact form.</div>';
    }
  }

  async function fetchMessages() {
    try {
      const res = await fetch('/api/chat/' + getSessionId() + '/messages');
      if (!res.ok) return;
      const data = await res.json();
      renderMessages(data.messages || [], data.status);
    } catch (e) { /* silent — next poll will retry */ }
  }

  function renderMessages(messages, status) {
    const body = document.getElementById('icChatBody');
    const wasScrolledToBottom = body.scrollHeight - body.scrollTop <= body.clientHeight + 40;
    body.innerHTML = messages.map(m =>
      `<div class="ic-chat-msg ${m.sender}">${escapeHtml(m.message)}</div>`
    ).join('') || '<div class="ic-chat-intro">Send a message to get started — our team typically replies within a few hours.</div>';
    if (wasScrolledToBottom) body.scrollTop = body.scrollHeight;

    const isClosed = status === 'closed';
    document.getElementById('icChatInputRow').style.display = isClosed ? 'none' : 'flex';
    document.getElementById('icChatEnded').style.display = isClosed ? 'block' : 'none';
    document.getElementById('icChatEndBtn').style.display = isClosed ? 'none' : 'inline';
    if (isClosed) stopPolling(); // no point polling a conversation that can't change anymore
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  async function sendMessage() {
    const input = document.getElementById('icChatInput');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    try {
      const res = await fetch('/api/chat/' + getSessionId() + '/messages', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text })
      });
      if (res.status === 409) {
        // Conversation was closed (e.g. by an admin) between page load and
        // this send — refresh to show the "ended" state instead of the
        // message silently vanishing with no explanation.
        await fetchMessages();
        return;
      }
      await fetchMessages();
    } catch (e) { /* the next poll will pick it up if this was just a network blip */ }
  }

  async function endConversation() {
    if (!confirm('End this conversation? You can always start a new one.')) return;
    try {
      await fetch('/api/chat/' + getSessionId() + '/close', { method: 'PUT' });
      await fetchMessages();
    } catch (e) {}
  }

  function startNewConversation() {
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(NAME_KEY);
    conversationStarted = false;
    stopPolling();
    document.getElementById('icChatEnded').style.display = 'none';
    document.getElementById('icChatEndBtn').style.display = 'none';
    renderIntro();
  }

  function startPolling() {
    stopPolling();
    pollTimer = setInterval(fetchMessages, 5000);
  }
  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null; }
  }

  // Resume an existing conversation automatically if the visitor already
  // has one (returning visitor / navigated to another page).
  function checkExistingConversation() {
    const savedName = localStorage.getItem(NAME_KEY);
    if (savedName) conversationStarted = false; // still show intro flow lazily on open, but auto-fill name via openWindow()
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { injectWidget(); checkExistingConversation(); });
  } else {
    injectWidget();
    checkExistingConversation();
  }
})();
