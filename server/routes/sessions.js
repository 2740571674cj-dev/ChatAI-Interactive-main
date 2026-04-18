const { Router } = require('express');
const { getDb, genId, nowUTC } = require('../database');
const { getAgentRunsForSession } = require('../services/agentRunner');

const router = Router();

function normalizeChatMode(chatMode = 'ask') {
    return String(chatMode || '').toLowerCase() === 'agent' ? 'agent' : 'ask';
}

router.post('/', (req, res) => {
    const db = getDb();
    const title = (req.body?.title || 'New Chat').slice(0, 200);
    const chatMode = normalizeChatMode(req.body?.chat_mode);
    const id = genId();
    const now = nowUTC();

    db.prepare(
        'INSERT INTO sessions (id, title, chat_mode, created_at, updated_at) VALUES (?, ?, ?, ?, ?)'
    ).run(id, title, chatMode, now, now);

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
    res.status(201).json(session);
});

router.get('/', (req, res) => {
    const db = getDb();
    const { q, limit = 50, chat_mode } = req.query;
    const normalizedLimit = Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200);
    const normalizedChatMode = normalizeChatMode(chat_mode);
    const hasModeFilter = typeof chat_mode !== 'undefined';

    const sessions = hasModeFilter
        ? (
            q
                ? db.prepare(
                    'SELECT * FROM sessions WHERE chat_mode = ? AND title LIKE ? ORDER BY updated_at DESC LIMIT ?'
                ).all(normalizedChatMode, `%${q}%`, normalizedLimit)
                : db.prepare(
                    'SELECT * FROM sessions WHERE chat_mode = ? ORDER BY updated_at DESC LIMIT ?'
                ).all(normalizedChatMode, normalizedLimit)
        )
        : (
            q
                ? db.prepare(
                    'SELECT * FROM sessions WHERE title LIKE ? ORDER BY updated_at DESC LIMIT ?'
                ).all(`%${q}%`, normalizedLimit)
                : db.prepare(
                    'SELECT * FROM sessions ORDER BY updated_at DESC LIMIT ?'
                ).all(normalizedLimit)
        );

    res.json(sessions);
});

router.get('/:id', (req, res) => {
    const db = getDb();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);

    if (!session) {
        return res.status(404).json({ detail: 'Conversation not found.' });
    }

    const messages = db.prepare(
        'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at'
    ).all(req.params.id);

    return res.json({
        ...session,
        messages,
        agent_runs: getAgentRunsForSession(req.params.id),
    });
});

router.patch('/:id', (req, res) => {
    const db = getDb();
    const { title } = req.body;

    if (!title) {
        return res.status(400).json({ detail: 'Title cannot be empty.' });
    }

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    if (!session) {
        return res.status(404).json({ detail: 'Conversation not found.' });
    }

    db.prepare(
        'UPDATE sessions SET title = ?, updated_at = ? WHERE id = ?'
    ).run(title.slice(0, 200), nowUTC(), req.params.id);

    const updated = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
    return res.json(updated);
});

router.delete('/:id', (req, res) => {
    const db = getDb();
    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);

    if (!session) {
        return res.status(404).json({ detail: 'Conversation not found.' });
    }

    try {
        const deleteSession = db.transaction((sessionId) => {
            db.prepare('DELETE FROM prompts WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM agent_runs WHERE session_id = ?').run(sessionId);
            db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
        });

        deleteSession(req.params.id);
        return res.status(204).end();
    } catch (error) {
        console.error('Failed to delete session:', error);
        return res.status(500).json({
            detail: error?.message || 'Failed to delete this conversation.',
        });
    }
});

module.exports = router;
