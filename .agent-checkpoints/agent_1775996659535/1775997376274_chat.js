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

function tokenizeSearchText(text) {
    return String(text || '')
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu) || [];
}

function hasExplicitWebSearchIntent(message) {
    const text = String(message || '').trim();
    if (!text) {
        return false;
    }

    const explicitPatterns = [
        /(请|帮我)?(联网搜索|上网查|网上查|搜索一下|查一下|帮我查一下|帮我搜索)/i,
        /(search the web|web search|browse the web|look it up online|find sources)/i,
        /(官网|官方文档|官方说明|新闻来源|参考链接|文章来源)/i,
    ];

    return explicitPatterns.some((pattern) => pattern.test(text));
}

function isReliableSearchQuery(message, query) {
    const sourceText = String(message || '').trim();
    const searchQuery = String(query || '').trim();
    if (!sourceText || !searchQuery) {
        return false;
    }

    if (searchQuery.length < 2 || searchQuery.length > SEARCH_CONTEXT_ITEM_CHARS) {
        return false;
    }

    if (/^(请|帮我|给我|能不能|是否|为什么|怎么|如何)$/i.test(searchQuery)) {
        return false;
    }

    if (/(回答|回复|解释|总结|分析|assistant|system|prompt|tool|function|json|markdown|代码块)/i.test(searchQuery)) {
        return false;
    }

    if (/[,，。；;！？!?]{3,}|```|~~~|\{|\}|\[|\]/.test(searchQuery)) {
        return false;
    }

    const normalizedSource = sourceText.toLowerCase().replace(/\s+/g, '');
    const normalizedQuery = searchQuery.toLowerCase().replace(/\s+/g, '');
    if (normalizedSource.includes(normalizedQuery) || normalizedQuery.includes(normalizedSource)) {
        return true;
    }

    const messageTokens = new Set(tokenizeSearchText(sourceText));
    const queryTokens = tokenizeSearchText(searchQuery).filter((token) => token.length >= 2);
    if (queryTokens.length === 0) {
        return false;
    }

    const overlapCount = queryTokens.filter((token) => messageTokens.has(token)).length;
    const overlapRatio = overlapCount / queryTokens.length;
    return overlapRatio >= 0.5;
}

function buildFallbackSearchQuery(message) {
    const cleaned = cleanSearchQueryPart(message)
        .replace(/^(请|帮我|麻烦|可以|能不能|请你)?/i, '')
        .replace(/(联网搜索|上网查|网上查|搜索一下|查一下|帮我查一下|帮我搜索|search the web|web search|browse the web|look it up online)/ig, ' ')
        .replace(/(官网|官方文档|官方说明|新闻来源|参考链接|文章来源)/ig, ' ')
        .replace(/[：:]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return truncateSearchText(cleaned, 240);
}

function shouldAllowWebSearch(message) {
    const text = String(message || '').trim().toLowerCase();
    if (!text) {
        return false;
    }

    const strongSignals = [
        /(最新|刚刚|今日|今天|目前|当前|近期|实时|热搜|新闻|报道|公告|财报|价格|汇率|股价|比分|天气)/i,
        /(官网|官方|文档|release|changelog|breaking change|version|pricing|availability|status)/i,
        /(latest|current|today|now|news|official|documentation|docs|price|weather|score|release)/i,
    ];

    const weakSignals = [
        /(搜索|查一下|帮我查|联网|网上|网页|资料|来源|链接|参考)/i,
        /(search|look up|browse|web|source|citation|reference|link)/i,
    ];

    if (strongSignals.some((pattern) => pattern.test(text))) {
        return true;
    }

    return weakSignals.some((pattern) => pattern.test(text)) && text.length <= 120;
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

async function chooseSearchQuery(sessionId, message, modelConfig, attachments) {
    const messages = buildMessagesContext(sessionId, message, attachments, {
        appendUserMessage: false,
    });

    try {
        const toolCall = await chooseWebSearchToolCall(modelConfig, messages);
        return truncateSearchText(cleanSearchQueryPart(toolCall?.query || ''), 240);
    } catch {
        return '';
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
        const explicitWebSearchIntent = hasExplicitWebSearchIntent(message)
            || /(联网|上网|搜索|查一下|帮我查|查资料|官方资料)/i.test(String(message || ''));

        if (shouldUseRuntimeDate && !explicitWebSearchIntent) {
            extraSystemContext = buildRuntimeDateContext(runtimeDateInfo);
        }

        if (
            web_search
            && message
            && String(message).trim()
            && shouldAllowWebSearch(message)
            && (!shouldUseRuntimeDate || explicitWebSearchIntent)
        ) {
            res.write(`data: ${JSON.stringify({
                type: 'status',
                status: 'searching',
                message: explicitWebSearchIntent ? '已识别到联网搜索请求，正在准备检索...' : '模型正在判断是否需要联网...',
            })}\n\n`);

            try {
                const searchQuery = await chooseSearchQuery(session_id, message, modelConfig, attachments);
                const fallbackSearchQuery = explicitWebSearchIntent ? buildFallbackSearchQuery(message) : '';
                const effectiveSearchQuery = isReliableSearchQuery(message, searchQuery)
                    ? searchQuery
                    : (isReliableSearchQuery(message, fallbackSearchQuery) ? fallbackSearchQuery : '');

                if (!effectiveSearchQuery) {
                    res.write(`data: ${JSON.stringify({
                        type: 'status',
                        status: 'search_skipped',
                        message: '检索词不明确或与问题相关性不足，已跳过联网搜索以避免资料污染。',
                        results: [],
                    })}\n\n`);
                } else {
                    res.write(`data: ${JSON.stringify({
                        type: 'status',
                        status: 'searching',
                        message: `正在联网搜索：${effectiveSearchQuery}`,
                    })}\n\n`);

                    const topResults = await runStructuredSearch(effectiveSearchQuery);
                    extraSystemContext = [
                        extraSystemContext,
                        buildSearchContext(effectiveSearchQuery, topResults),
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
