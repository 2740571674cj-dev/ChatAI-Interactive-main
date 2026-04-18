const { Router } = require('express');
const { getDb, genId, nowUTC } = require('../database');
const {
    encryptApiKey,
    decryptApiKey,
    maskApiKey,
    needsReencryption,
} = require('../services/crypto');
const { normalizeOpenaiBaseUrl, buildChatCompletionsUrl } = require('../services/baseUrl');

const router = Router();

function toOut(model) {
    return {
        id: model.id,
        name: model.name,
        base_url: normalizeOpenaiBaseUrl(model.base_url),
        api_key_masked: maskApiKey(decryptApiKey(model.api_key_encrypted)),
        model_id: model.model_id,
        is_active: Boolean(model.is_active),
        created_at: model.created_at,
    };
}

function migrateApiKeyIfNeeded(db, model) {
    if (!model || !model.api_key_encrypted || !needsReencryption(model.api_key_encrypted)) {
        return model;
    }

    const plainKey = decryptApiKey(model.api_key_encrypted);
    if (!plainKey) {
        return model;
    }

    const nextEncrypted = encryptApiKey(plainKey);
    db.prepare('UPDATE model_configs SET api_key_encrypted = ? WHERE id = ?').run(nextEncrypted, model.id);
    return { ...model, api_key_encrypted: nextEncrypted };
}

router.post('/', (req, res) => {
    const db = getDb();
    const { name, base_url, api_key, model_id = 'gpt-4o' } = req.body;

    if (!name || !base_url || !api_key) {
        return res.status(400).json({ detail: '缺少必要字段' });
    }

    const id = genId();
    const normalizedUrl = normalizeOpenaiBaseUrl(base_url);
    const isFirstModel = db.prepare('SELECT COUNT(*) AS count FROM model_configs').get().count === 0;

    db.prepare(
        `INSERT INTO model_configs (id, name, base_url, api_key_encrypted, model_id, is_active, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
        id,
        name,
        normalizedUrl,
        encryptApiKey(api_key),
        model_id,
        isFirstModel ? 1 : 0,
        nowUTC()
    );

    const model = db.prepare('SELECT * FROM model_configs WHERE id = ?').get(id);
    return res.status(201).json(toOut(model));
});

router.get('/', (req, res) => {
    const db = getDb();
    const models = db.prepare('SELECT * FROM model_configs ORDER BY created_at').all()
        .map((model) => migrateApiKeyIfNeeded(db, model));
    res.json(models.map(toOut));
});

router.put('/:id', (req, res) => {
    const db = getDb();
    const { name, base_url, api_key, model_id } = req.body;
    const model = db.prepare('SELECT * FROM model_configs WHERE id = ?').get(req.params.id);

    if (!model) {
        return res.status(404).json({ detail: '模型配置不存在' });
    }

    const nextName = name || model.name;
    const nextBaseUrl = normalizeOpenaiBaseUrl(base_url || model.base_url);
    const nextModelId = model_id || model.model_id;

    if (api_key) {
        db.prepare(
            'UPDATE model_configs SET name = ?, base_url = ?, api_key_encrypted = ?, model_id = ? WHERE id = ?'
        ).run(nextName, nextBaseUrl, encryptApiKey(api_key), nextModelId, req.params.id);
    } else {
        db.prepare(
            'UPDATE model_configs SET name = ?, base_url = ?, model_id = ? WHERE id = ?'
        ).run(nextName, nextBaseUrl, nextModelId, req.params.id);
    }

    const updated = migrateApiKeyIfNeeded(
        db,
        db.prepare('SELECT * FROM model_configs WHERE id = ?').get(req.params.id)
    );
    res.json(toOut(updated));
});

router.delete('/:id', (req, res) => {
    const db = getDb();
    const model = db.prepare('SELECT * FROM model_configs WHERE id = ?').get(req.params.id);

    if (!model) {
        return res.status(404).json({ detail: '模型配置不存在' });
    }

    db.prepare('DELETE FROM model_configs WHERE id = ?').run(req.params.id);

    if (model.is_active) {
        const firstRemaining = db.prepare('SELECT * FROM model_configs ORDER BY created_at LIMIT 1').get();
        if (firstRemaining) {
            db.prepare('UPDATE model_configs SET is_active = 1 WHERE id = ?').run(firstRemaining.id);
        }
    }

    res.status(204).end();
});

router.patch('/:id/activate', (req, res) => {
    const db = getDb();
    const model = db.prepare('SELECT * FROM model_configs WHERE id = ?').get(req.params.id);

    if (!model) {
        return res.status(404).json({ detail: '模型配置不存在' });
    }

    const activate = db.transaction(() => {
        db.prepare('UPDATE model_configs SET is_active = 0 WHERE is_active = 1').run();
        db.prepare('UPDATE model_configs SET is_active = 1 WHERE id = ?').run(req.params.id);
    });
    activate();

    const updated = migrateApiKeyIfNeeded(
        db,
        db.prepare('SELECT * FROM model_configs WHERE id = ?').get(req.params.id)
    );
    res.json(toOut(updated));
});

router.post('/parse-config', (req, res) => {
    const { code } = req.body;
    if (!code) {
        return res.json({ name: '', base_url: '', api_key: '', model_id: '' });
    }

    const result = { name: '', base_url: '', api_key: '', model_id: '' };

    const urlMatch = code.match(/https?:\/\/[^\s'"\\]+/);
    if (urlMatch) {
        result.base_url = normalizeOpenaiBaseUrl(urlMatch[0].replace(/\/+$/, ''));
    }

    const baseUrlPy = code.match(/base_url\s*=\s*["']([^"']+)["']/);
    if (baseUrlPy) {
        result.base_url = normalizeOpenaiBaseUrl(baseUrlPy[1]);
    }

    const bearerMatch = code.match(/Bearer\s+(sk-[a-zA-Z0-9_-]+)/);
    if (bearerMatch) {
        result.api_key = bearerMatch[1];
    }

    const keyMatch = code.match(/api_key\s*=\s*["']([^"']+)["']/);
    if (keyMatch) {
        result.api_key = keyMatch[1];
    }

    if (!result.api_key) {
        const skMatch = code.match(/(sk-[a-zA-Z0-9_-]{20,})/);
        if (skMatch) {
            result.api_key = skMatch[1];
        }
    }

    const modelMatch = code.match(/"model"\s*:\s*"([^"]+)"/);
    if (modelMatch) {
        result.model_id = modelMatch[1];
    }

    const modelPy = code.match(/model\s*=\s*["']([^"']+)["']/);
    if (modelPy) {
        result.model_id = modelPy[1];
    }

    if (result.model_id) {
        result.name = result.model_id;
    } else if (result.base_url) {
        try {
            const { URL } = require('url');
            const domain = new URL(result.base_url).hostname || '';
            const provider = domain.split('.')[0] || '';
            result.name = provider ? provider.charAt(0).toUpperCase() + provider.slice(1) : '';
        } catch {
            result.name = '';
        }
    }

    res.json(result);
});

router.post('/test', async (req, res) => {
    const { base_url, api_key, model_id = 'gpt-4o' } = req.body;
    const startTime = Date.now();

    try {
        const response = await fetch(buildChatCompletionsUrl(base_url), {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${api_key}`,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                model: model_id,
                messages: [{ role: 'user', content: 'Hi' }],
                max_tokens: 5,
                stream: false,
            }),
            signal: AbortSignal.timeout(15000),
        });

        const latency = Date.now() - startTime;
        if (response.ok) {
            return res.json({
                success: true,
                message: '连接成功，API 正常响应。',
                latency_ms: latency,
            });
        }

        const text = await response.text();
        return res.json({
            success: false,
            message: `API 返回错误 (${response.status}): ${text.slice(0, 200)}`,
            latency_ms: latency,
        });
    } catch (error) {
        const latency = Date.now() - startTime;
        const isTimeout = error.name === 'TimeoutError' || String(error.message).toLowerCase().includes('timeout');
        return res.json({
            success: false,
            message: isTimeout
                ? '连接超时，15 秒内没有收到响应，请检查 Base URL 是否正确。'
                : `连接失败：${error.message}`,
            latency_ms: latency,
        });
    }
});

module.exports = router;
