const { Router } = require('express');
const { getDb, genId, nowUTC } = require('../database');

const router = Router();

router.post('/', (req, res) => {
    const db = getDb();
    const { type, text = '', enabled = true, session_id = null } = req.body;

    if (!['global', 'specific'].includes(type)) {
        return res.status(400).json({ detail: 'type 必须是 global 或 specific' });
    }

    const id = genId();
    db.prepare(
        'INSERT INTO prompts (id, type, text, enabled, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(id, type, text, enabled ? 1 : 0, session_id, nowUTC());

    const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(id);
    res.status(201).json({ ...prompt, enabled: Boolean(prompt.enabled) });
});

router.get('/', (req, res) => {
    const db = getDb();
    const { type, session_id } = req.query;
    let sql = 'SELECT * FROM prompts';
    const conditions = [];
    const params = [];

    if (type) {
        conditions.push('type = ?');
        params.push(type);
    }
    if (session_id) {
        conditions.push('session_id = ?');
        params.push(session_id);
    }

    if (conditions.length > 0) {
        sql += ` WHERE ${conditions.join(' AND ')}`;
    }
    sql += ' ORDER BY created_at';

    const prompts = db.prepare(sql).all(...params);
    res.json(prompts.map((prompt) => ({ ...prompt, enabled: Boolean(prompt.enabled) })));
});

router.put('/:id', (req, res) => {
    const db = getDb();
    const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);

    if (!prompt) {
        return res.status(404).json({ detail: '提示词不存在' });
    }

    db.prepare('UPDATE prompts SET text = ? WHERE id = ?').run(req.body?.text ?? '', req.params.id);

    const updated = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
    res.json({ ...updated, enabled: Boolean(updated.enabled) });
});

router.patch('/:id/toggle', (req, res) => {
    const db = getDb();
    const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);

    if (!prompt) {
        return res.status(404).json({ detail: '提示词不存在' });
    }

    db.prepare('UPDATE prompts SET enabled = ? WHERE id = ?').run(req.body?.enabled ? 1 : 0, req.params.id);

    const updated = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);
    res.json({ ...updated, enabled: Boolean(updated.enabled) });
});

router.delete('/:id', (req, res) => {
    const db = getDb();
    const prompt = db.prepare('SELECT * FROM prompts WHERE id = ?').get(req.params.id);

    if (!prompt) {
        return res.status(404).json({ detail: '提示词不存在' });
    }

    db.prepare('DELETE FROM prompts WHERE id = ?').run(req.params.id);
    res.status(204).end();
});

module.exports = router;
