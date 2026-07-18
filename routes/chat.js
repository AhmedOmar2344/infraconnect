/**
 * ═══════════════════════════════════════════════════════════════════════════
 *  INFRACONNECT — Chat Support Route
 *  File: routes/chat.js
 * ═══════════════════════════════════════════════════════════════════════════
 *  A simple, fully self-hosted chat widget — polling-based rather than
 *  real-time (WebSockets), since Vercel's serverless functions are
 *  short-lived and don't hold persistent connections well. The widget
 *  checks for new messages every few seconds instead of instantly, which
 *  is the deliberate tradeoff for not depending on a third-party service.
 *
 *  PUBLIC (identified by session_id — a long random string generated in
 *  the visitor's browser and stored in localStorage, acting as a
 *  lightweight per-conversation credential since there's no visitor login):
 *    POST /api/chat/start                     Start or resume a conversation
 *    POST /api/chat/:sessionId/messages        Send a message (as visitor)
 *    GET  /api/chat/:sessionId/messages         Poll for the full thread
 *
 *  ADMIN (auth required):
 *    GET  /api/chat/conversations               List all conversations
 *    GET  /api/chat/conversations/:id/messages   View a thread, marks it read
 *    POST /api/chat/conversations/:id/reply      Reply (as admin)
 *    PUT  /api/chat/conversations/:id            Update status (open/closed)
 * ═══════════════════════════════════════════════════════════════════════════
 */
const router = require('express').Router();
const { getDb } = require('../db/database');
const { auth } = require('../middleware/auth');

// ── PUBLIC ───────────────────────────────────────────────────────────────────
router.post('/start', async (req, res, next) => {
  try {
    const { session_id, visitor_name, visitor_email } = req.body;
    if (!session_id || !session_id.trim()) return res.status(400).json({ error: 'Session ID required.' });
    const db = getDb();
    let convo = await db.prepare('SELECT * FROM chat_conversations WHERE session_id=?').get(session_id.trim());
    if (!convo) {
      const result = await db.prepare(
        'INSERT INTO chat_conversations(session_id, visitor_name, visitor_email) VALUES(?,?,?)'
      ).run(session_id.trim(), (visitor_name || 'Website Visitor').trim().slice(0, 100), (visitor_email || '').trim().slice(0, 200));
      convo = await db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(result.lastInsertRowid);
    }
    res.json({ conversation: convo });
  } catch (err) { next(err); }
});

router.post('/:sessionId/messages', async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
    const db = getDb();
    const convo = await db.prepare('SELECT * FROM chat_conversations WHERE session_id=?').get(req.params.sessionId);
    if (!convo) return res.status(404).json({ error: 'Conversation not found.' });
    // A closed conversation stays closed until someone explicitly reopens
    // it — this used to silently flip back to 'open' on any new message,
    // which meant "closed" never actually meant anything to either side.
    if (convo.status === 'closed') {
      return res.status(409).json({ error: 'This conversation has ended.', closed: true });
    }
    await db.prepare('INSERT INTO chat_messages(conversation_id, sender, message) VALUES(?,?,?)').run(convo.id, 'visitor', message.trim().slice(0, 2000));
    await db.prepare("UPDATE chat_conversations SET last_message_at=datetime('now'), unread_by_admin=1 WHERE id=?").run(convo.id);
    res.status(201).json({ message: 'Sent.' });
  } catch (err) { next(err); }
});

// PUBLIC: lets the visitor end their own conversation, mirroring the
// admin's ability to close one — "manageable from both sides" means both
// sides need an explicit, working control, not just admin.
router.put('/:sessionId/close', async (req, res, next) => {
  try {
    const db = getDb();
    const convo = await db.prepare('SELECT id FROM chat_conversations WHERE session_id=?').get(req.params.sessionId);
    if (!convo) return res.status(404).json({ error: 'Conversation not found.' });
    await db.prepare("UPDATE chat_conversations SET status='closed' WHERE id=?").run(convo.id);
    res.json({ message: 'Conversation ended.' });
  } catch (err) { next(err); }
});

router.get('/:sessionId/messages', async (req, res, next) => {
  try {
    const db = getDb();
    const convo = await db.prepare('SELECT * FROM chat_conversations WHERE session_id=?').get(req.params.sessionId);
    if (!convo) return res.status(404).json({ error: 'Conversation not found.' });
    const messages = await db.prepare('SELECT sender, message, created_at FROM chat_messages WHERE conversation_id=? ORDER BY created_at ASC').all(convo.id);
    // Polling for messages implies the visitor is looking at the window —
    // treat this as having seen any admin replies so far.
    await db.prepare('UPDATE chat_conversations SET unread_by_visitor=0 WHERE id=?').run(convo.id);
    res.json({ messages, status: convo.status });
  } catch (err) { next(err); }
});

// ── ADMIN ────────────────────────────────────────────────────────────────────
router.get('/conversations', auth, async (req, res, next) => {
  try {
    const db = getDb();
    const conversations = await db.prepare('SELECT * FROM chat_conversations ORDER BY last_message_at DESC LIMIT 100').all();
    const unreadCount = Number((await db.prepare('SELECT COUNT(*) as c FROM chat_conversations WHERE unread_by_admin=1').get()).c);
    res.json({ conversations, unread_count: unreadCount });
  } catch (err) { next(err); }
});

router.get('/conversations/:id/messages', auth, async (req, res, next) => {
  try {
    const db = getDb();
    const convo = await db.prepare('SELECT * FROM chat_conversations WHERE id=?').get(req.params.id);
    if (!convo) return res.status(404).json({ error: 'Not found.' });
    const messages = await db.prepare('SELECT sender, message, created_at FROM chat_messages WHERE conversation_id=? ORDER BY created_at ASC').all(convo.id);
    await db.prepare('UPDATE chat_conversations SET unread_by_admin=0 WHERE id=?').run(convo.id);
    res.json({ conversation: convo, messages });
  } catch (err) { next(err); }
});

router.post('/conversations/:id/reply', auth, async (req, res, next) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) return res.status(400).json({ error: 'Message cannot be empty.' });
    const db = getDb();
    const convo = await db.prepare('SELECT id FROM chat_conversations WHERE id=?').get(req.params.id);
    if (!convo) return res.status(404).json({ error: 'Not found.' });
    await db.prepare('INSERT INTO chat_messages(conversation_id, sender, message) VALUES(?,?,?)').run(convo.id, 'admin', message.trim().slice(0, 2000));
    await db.prepare("UPDATE chat_conversations SET last_message_at=datetime('now'), unread_by_visitor=1 WHERE id=?").run(convo.id);
    res.status(201).json({ message: 'Sent.' });
  } catch (err) { next(err); }
});

router.put('/conversations/:id', auth, async (req, res, next) => {
  try {
    const { status } = req.body;
    if (!['open', 'closed'].includes(status)) return res.status(400).json({ error: 'Status must be open or closed.' });
    await getDb().prepare('UPDATE chat_conversations SET status=? WHERE id=?').run(status, req.params.id);
    res.json({ message: 'Updated.' });
  } catch (err) { next(err); }
});

module.exports = router;
