const { Router } = require('express');
const { getDb, genId, nowUTC } = require('../database');
const {
    getActiveModelConfig,
    buildMessagesContext,
    chooseWebSearchToolCall,
    streamChatCompletion,
} = require('../services/ai');
const { webSearch, buildSearchContext } = require('../services/webSearch');
const { mcpWebSearch, hasMcpSearchConfig } = require('../services/mcpSearch');

const router = Router();
const SEARCH_CONTEXT_ITEM_CHARS = 240;
const SEARCH_QUERY_CHARS = 1200;

function getRuntimeDateInfo() {
    const now = new Date();
    return {
        iso: now.toISOString(),
        timezone: 'Asia/Shanghai',
        formatted: new Intl.DateTimeFormat('zh-CN', {
            timeZone: 'Asia/Shanghai',
            dateStyle: 'full',
            timeStyle: 'medium',
            hourCycle: 'h23',
        }).format(now),
    };
}

function isCurrentDateTimeQuery(message) {
    const text = String(message || '').trim().toLowerCase();
    if (!text || text.length > 50) {
        return false;
    }

    const patterns = [
        /今天.*(几号|日期|星期|礼拜|时间)/i,
        /现在.*(几点|时间|日期|几号)/i,
        /当前.*(日期|时间)/i,
        /^(几号|星期几|几点了|today|date|time)$/i,
    ];

    return patterns.some((pattern) => pattern.test(text));
}

function buildRuntimeDateContext(info) {
    return [
        'Authoritative realtime runtime information:',
        `Current date/time in ${info.timezone}: ${info.formatted}.`,
        `UTC ISO timestamp: ${info.iso}.`,
        'For user questions about today, current date, weekday, or current time, use this runtime information instead of search-engine snippets, model memory, or older conversation history.',
    ].join('\n');
}

function cleanSearchQueryPart(text) {
    return String(text || '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/~~~[\s\S]*?~~~/g, ' ')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function truncateSearchText(text, maxChars = SEARCH_CONTEXT_ITEM_CHARS) {
    const value = String(text || '').trim();
    return value.length > maxChars ? `${value.slice(0, maxChars).trim()}...` : value;
}

function getSearchContextMessages(db, sessionId) {
    return db.prepare(
        `SELECT content FROM messages
         WHERE session_id = ?
           AND role = 'user'
         ORDER BY created_at DESC
         LIMIT 6`
    ).all(sessionId)
        .reverse()
        .map((item) => truncateSearchText(cleanSearchQueryPart(item.content), 180))
        .filter(Boolean);
}

function buildContextualSearchQuery(db, sessionId, message) {
    const current = truncateSearchText(cleanSearchQueryPart(message), 500);
    const contextLines = getSearchContextMessages(db, sessionId);
    const dedupedContext = contextLines.filter((line) => line !== current);
    const queryParts = [...dedupedContext, current].filter(Boolean);
    const selected = [];
    let totalChars = 0;

    for (let index = queryParts.length - 1; index >= 0; index -= 1) {
        const part = queryParts[index];
        const nextTotal = totalChars + part.length + 1;
        if (selected.length > 0 && nextTotal > SEARCH_QUERY_CHARS) {
            break;
        }
        selected.unshift(part);
        totalChars = nextTotal;
    }

    return selected.join('\n');
}

function mergeSearchResults(existing, nextResults, query) {
    const merged = [...existing];
    for (const result of nextResults || []) {
        if (!result?.url || merged.some((item) => item.url === result.url)) {
            continue;
        }
        merged.push({ ...result, query });
    }
    return merged;
}

async function runStructuredSearch(query) {
    let results = [];
    let lastError = null;

    if (hasMcpSearchConfig()) {
        try {
            results = mergeSearchResults(results, await mcpWebSearch(query, { maxResults: 8 }), query);
        } catch (error) {
            lastError = error;
        }
    }

    if (results.length === 0) {
        try {
            results = mergeSearchResults(results, await webSearch(query, { maxResults: 8 }), query);
        } catch (error) {
            lastError = error;
        }
    }

    if (results.length === 0 && lastError) {
        throw lastError;
    }

    return results.slice(0, 8);
}

async function chooseSearchQuery(db, sessionId, message, modelConfig, attachments) {
    const messages = buildMessagesContext(sessionId, message, attachments, {
        appendUserMessage: false,
    });

    try {
        const toolCall = await chooseWebSearchToolCall(modelConfig, messages);
        return toolCall?.query || '';
    } catch {
        return buildContextualSearchQuery(db, sessionId, message);
    }
}

router.post('/stream', async (req, res) => {
    const db = getDb();
    const {
        session_id,
        message,
        model_config_id,
        attachments,
        regenerate = false,
        web_search = false,
    } = req.body;

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id);
    if (!session) {
        return res.status(404).json({ detail: '会话不存在' });
    }

    const modelConfig = getActiveModelConfig(model_config_id);
    if (!modelConfig) {
        return res.status(400).json({ detail: '请先配置并激活一个模型' });
    }

    if (regenerate) {
        const latestAssistant = db.prepare(
            "SELECT * FROM messages WHERE session_id = ? AND role = 'assistant' ORDER BY created_at DESC LIMIT 1"
        ).get(session_id);

        if (latestAssistant) {
            db.prepare('DELETE FROM messages WHERE id = ?').run(latestAssistant.id);
        }
    }

    const now = nowUTC();
    if (!regenerate) {
        db.prepare(
            'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(genId(), session_id, 'user', message, now);
    }
    db.prepare('UPDATE sessions SET updated_at = ? WHERE id = ?').run(now, session_id);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let fullResponse = '';

    try {
        let extraSystemContext = '';
        const runtimeDateInfo = getRuntimeDateInfo();
        const shouldUseRuntimeDate = isCurrentDateTimeQuery(message);

        if (shouldUseRuntimeDate) {
            extraSystemContext = buildRuntimeDateContext(runtimeDateInfo);
        }

        if (web_search && message && String(message).trim() && !shouldUseRuntimeDate) {
            res.write(`data: ${JSON.stringify({
                type: 'status',
                status: 'searching',
                message: '模型正在判断是否需要联网...',
            })}\n\n`);

            try {
                const searchQuery = await chooseSearchQuery(db, session_id, message, modelConfig, attachments);

                if (!searchQuery) {
                    res.write(`data: ${JSON.stringify({
                        type: 'status',
                        status: 'search_skipped',
                        message: '模型判断这个问题不需要联网，将直接回答。',
                        results: [],
                    })}\n\n`);
                } else {
                    res.write(`data: ${JSON.stringify({
                        type: 'status',
                        status: 'searching',
                        message: `正在联网搜索：${searchQuery}`,
                    })}\n\n`);

                    const topResults = await runStructuredSearch(searchQuery);
                    extraSystemContext = [
                        extraSystemContext,
                        buildSearchContext(searchQuery, topResults),
                    ].filter(Boolean).join('\n\n');

                    res.write(`data: ${JSON.stringify({
                        type: 'status',
                        status: topResults.length > 0 ? 'search_done' : 'search_empty',
                        message: topResults.length > 0
                            ? `已找到 ${topResults.length} 条搜索结果`
                            : '未找到可用搜索结果，将直接回答',
                        results: topResults,
                    })}\n\n`);
                }
            } catch (searchError) {
                res.write(`data: ${JSON.stringify({
                    type: 'status',
                    status: 'search_failed',
                    message: `联网搜索失败，将直接回答：${searchError.message}`,
                })}\n\n`);
            }
        } else if (web_search && shouldUseRuntimeDate) {
            const results = [{
                title: '应用运行时日期',
                url: '',
                source: runtimeDateInfo.timezone,
                snippet: runtimeDateInfo.formatted,
            }];
            res.write(`data: ${JSON.stringify({
                type: 'status',
                status: 'search_done',
                message: `已使用应用运行时日期：${runtimeDateInfo.formatted}`,
                results,
            })}\n\n`);
        }

        const messagesContext = buildMessagesContext(session_id, message, attachments, {
            appendUserMessage: !regenerate,
            extraSystemContext,
        });

        for await (const chunkJson of streamChatCompletion(modelConfig, messagesContext)) {
            const chunk = JSON.parse(chunkJson);
            if (chunk.content) {
                fullResponse += chunk.content;
            }

            res.write(`data: ${chunkJson}\n\n`);

            if (chunk.done && fullResponse.trim()) {
                db.prepare(
                    'INSERT INTO messages (id, session_id, role, content, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
                ).run(genId(), session_id, 'assistant', fullResponse, modelConfig.name, nowUTC());
            }
        }
    } catch (error) {
        res.write(`data: ${JSON.stringify({
            content: '',
            done: true,
            error: `流式响应中断：${error.message}`,
        })}\n\n`);
    }

    res.end();
});

module.exports = router;
