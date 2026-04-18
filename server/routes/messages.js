/**
 * 消息管理路由
 * 提供单条消息的删除功能。
 * 
 * 替代 Python 版 routers/messages.py
 */
const { Router } = require('express');
const { getDb } = require('../database');

const router = Router();

/**
 * DELETE /api/messages/:id - 删除单条消息
 */
router.delete('/:id', (req, res) => {
    const db = getDb();
    const message = db.prepare('SELECT * FROM messages WHERE id = ?').get(req.params.id);

    if (!message) {
        return res.status(404).json({ detail: '消息不存在' });
    }

    db.prepare('DELETE FROM messages WHERE id = ?').run(req.params.id);
    res.status(204).end();
});

module.exports = router;
