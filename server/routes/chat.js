const { Router } = require('express');
const { getDb, genId, nowUTC } = require('../database');
const {
    getActiveModelConfig,
    buildMessagesContext,
    chooseWebSearchToolCall,
    streamChatCompletion,
} = require('../services/ai');
const { runAgentMode } = require('../services/agentRunner');
const { webSearch, buildSearchContext, buildSearchFallbackLinks } = require('../services/webSearch');
const { mcpWebSearch, hasMcpSearchConfig } = require('../services/mcpSearch');

const router = Router();
const SEARCH_CONTEXT_ITEM_CHARS = 240;
const SEARCH_QUERY_CHARS = 1200;
const SEARCH_RESULTS_MAX = 24;
const SEARCH_CONTEXT_RESULTS_MAX = 10;
const SEARCH_HISTORY_MESSAGES = 8;
const SEARCH_QUERY_CANDIDATES_MAX = 3;
const EXPLICIT_WEB_SEARCH_PATTERNS = [
    /(请|帮我)?(联网搜索|上网查|网上查|在线搜索|搜索一下|搜一下|查一下|帮我查一下|帮我搜索|帮我搜一下)/i,
    /(search the web|web search|browse the web|look it up online|find sources|search online)/i,
    /(官网|官方文档|官方说明|新闻来源|参考链接|文章来源|来源链接)/i,
];
const REALTIME_SEARCH_PATTERNS = [
    /(最新|刚刚|今日|今天|目前|当前|近期|实时|新闻|报道|公告|财报|价格|汇率|股价|比分|天气)/i,
    /(latest|current|today|now|news|price|weather|score|recent|breaking)/i,
];
const AUTHORITATIVE_SOURCE_PATTERNS = [
    /(官网|官方|官方文档|官方说明|版本|发布说明|更新日志|定价|状态页|可用性)/i,
    /(official|documentation|docs|release notes|changelog|version|pricing|availability|status page)/i,
];

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

    return EXPLICIT_WEB_SEARCH_PATTERNS.some((pattern) => pattern.test(text));
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

    if (/(assistant|system|prompt|tool|function|json|markdown|code)/i.test(searchQuery)) {
        return false;
    }

    if (/[,锛屻€傦紱;锛侊紵!?]{3,}|```|~~~|\{|\}|\[|\]/.test(searchQuery)) {
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
        .replace(/^(请|帮我|麻烦|可以|能不能|请你|请问)?/i, '')
        .replace(/(联网搜索|上网查|网上查|在线搜索|搜索一下|搜索|搜一下|查一下|帮我查一下|帮我搜索|帮我搜一下|search the web|web search|browse the web|look it up online)/ig, ' ')
        .replace(/^\s*(一下|一下子|下)/i, ' ')
        .replace(/(官网|官方文档|官方说明|新闻来源|参考链接|文章来源|来源链接)/ig, ' ')
        .replace(/[，。！？?]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();

    return truncateSearchText(cleaned, 240);
}

function stripAttachmentSummary(text) {
    return String(text || '').split('\n\n[Attachments]')[0].trim();
}

function getRecentSearchHistory(sessionId, maxItems = SEARCH_HISTORY_MESSAGES) {
    const db = getDb();
    return db.prepare(
        `SELECT role, content
         FROM messages
         WHERE session_id = ?
         ORDER BY created_at DESC
         LIMIT ?`
    )
        .all(sessionId, maxItems)
        .reverse()
        .map((item) => ({
            role: item.role,
            content: truncateSearchText(cleanSearchQueryPart(stripAttachmentSummary(item.content)), 240),
        }))
        .filter((item) => item.content);
}

function buildContextualFallbackSearchQuery(sessionId, message) {
    const currentText = truncateSearchText(cleanSearchQueryPart(message), 240);
    const recentUserTurns = getRecentSearchHistory(sessionId)
        .filter((item) => item.role === 'user')
        .map((item) => item.content);

    const normalizedCurrent = currentText.toLowerCase().replace(/\s+/g, '');
    const previousUserTurns = recentUserTurns.filter((item, index) => {
        if (index !== recentUserTurns.length - 1) {
            return true;
        }
        return item.toLowerCase().replace(/\s+/g, '') !== normalizedCurrent;
    });

    const previousContext = previousUserTurns.slice(-2);
    const combined = truncateSearchText([...previousContext, currentText].filter(Boolean).join(' '), 240);
    const hasContextReference = /(它|他|她|这个|那个|这款|那款|这家|那家|这个问题|那个问题|该|其|上述|上面|前面|刚才|之前|上一条|上一个|继续|接着|再查|再搜)/i
        .test(currentText);

    if (combined && (hasContextReference || currentText.length <= 18 || previousContext.length > 0)) {
        return combined;
    }

    return currentText;
}

function buildSearchSourceText(sessionId, message) {
    const historyLines = getRecentSearchHistory(sessionId)
        .slice(-6)
        .map((item) => `${item.role}: ${item.content}`);
    const currentText = truncateSearchText(cleanSearchQueryPart(message), 240);
    const currentLine = currentText ? `current: ${currentText}` : '';

    return [...historyLines, currentLine].filter(Boolean).join('\n');
}

function isSearchableQuery(query) {
    const value = String(query || '').trim();
    if (!value || value.length < 2 || value.length > SEARCH_CONTEXT_ITEM_CHARS) {
        return false;
    }

    if (/^(你好|您好|hello|hi|thanks|谢谢)$/i.test(value)) {
        return false;
    }

    if (/```|~~~|\{|\}|\[|\]/.test(value)) {
        return false;
    }

    return true;
}

function chooseEffectiveSearchQueries(sessionId, message, toolQuery = '') {
    const sourceText = buildSearchSourceText(sessionId, message) || String(message || '').trim();
    const contextualFallback = buildContextualFallbackSearchQuery(sessionId, message);
    const candidates = [
        truncateSearchText(cleanSearchQueryPart(toolQuery), 240),
        contextualFallback,
        buildFallbackSearchQuery(message),
        truncateSearchText(cleanSearchQueryPart(message), 240),
    ].filter(Boolean);

    const uniqueCandidates = candidates.filter((candidate, index) => candidates.indexOf(candidate) === index);
    const reliableCandidates = uniqueCandidates.filter((candidate) => isReliableSearchQuery(sourceText, candidate));
    const searchableCandidates = uniqueCandidates.filter((candidate) => isSearchableQuery(candidate));
    const ordered = [...reliableCandidates, ...searchableCandidates]
        .filter((candidate, index, array) => array.indexOf(candidate) === index);

    return ordered.slice(0, SEARCH_QUERY_CANDIDATES_MAX);
}

function shouldAllowWebSearch(message, options = {}) {
    const text = String(message || '').trim();
    const userEnabled = options.userEnabled !== false;
    if (!text) {
        return false;
    }

    if (text.length > SEARCH_QUERY_CHARS) {
        return false;
    }

    if (hasExplicitWebSearchIntent(text)) {
        return true;
    }

    if (
        REALTIME_SEARCH_PATTERNS.some((pattern) => pattern.test(text))
        || AUTHORITATIVE_SOURCE_PATTERNS.some((pattern) => pattern.test(text))
    ) {
        return true;
    }

    return userEnabled && isSearchableQuery(buildFallbackSearchQuery(text));
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

function buildStoredUserMessage(message, attachments = []) {
    const text = String(message || '').trim();
    if (!Array.isArray(attachments) || attachments.length === 0) {
        return text;
    }

    const attachmentLines = attachments
        .map((attachment) => attachment?.filename)
        .filter(Boolean)
        .slice(0, 6)
        .map((filename) => `- ${filename}`);

    const summary = attachmentLines.length > 0
        ? `\n\n[Attachments]\n${attachmentLines.join('\n')}`
        : '\n\n[Attachments]';

    return `${text || 'Sent attachments'}${summary}`;
}

async function runStructuredSearch(query) {
    let results = [];
    let lastError = null;

    if (hasMcpSearchConfig()) {
        try {
            results = mergeSearchResults(results, await mcpWebSearch(query, { maxResults: SEARCH_RESULTS_MAX }), query);
        } catch (error) {
            lastError = error;
        }
    }

    if (results.length === 0) {
        try {
            results = mergeSearchResults(results, await webSearch(query, { maxResults: SEARCH_RESULTS_MAX }), query);
        } catch (error) {
            lastError = error;
        }
    }

    if (results.length === 0 && lastError) {
        throw lastError;
    }

    return results.slice(0, SEARCH_RESULTS_MAX);
}

async function runStructuredSearchQueries(queries = []) {
    let mergedResults = [];
    let lastError = null;

    for (const query of queries) {
        try {
            const nextResults = await runStructuredSearch(query);
            mergedResults = mergeSearchResults(mergedResults, nextResults, query);
            if (mergedResults.length >= SEARCH_RESULTS_MAX) {
                break;
            }
        } catch (error) {
            lastError = error;
        }
    }

    if (mergedResults.length === 0 && lastError) {
        throw lastError;
    }

    return mergedResults.slice(0, SEARCH_RESULTS_MAX);
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
        project_context = null,
        regenerate = false,
        web_search = false,
        chat_mode = 'ask',
    } = req.body;
    const normalizedChatMode = String(chat_mode || '').toLowerCase() === 'agent' ? 'agent' : 'ask';

    const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(session_id);
    if (!session) {
        return res.status(404).json({ detail: 'Session not found.' });
    }
    const sessionChatMode = String(session.chat_mode || 'ask').toLowerCase() === 'agent' ? 'agent' : 'ask';
    if (sessionChatMode !== normalizedChatMode) {
        return res.status(409).json({
            detail: `This conversation belongs to ${sessionChatMode} mode and is isolated from ${normalizedChatMode} mode.`,
        });
    }

    const modelConfig = getActiveModelConfig(model_config_id);
    if (!modelConfig) {
        return res.status(400).json({ detail: 'Please configure and activate a model first.' });
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
        const storedUserMessage = buildStoredUserMessage(message, attachments);
        db.prepare(
            'INSERT INTO messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)'
        ).run(genId(), session_id, 'user', storedUserMessage, now);
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
        if (project_context && normalizedChatMode === 'agent') {
            const rootPath = String(project_context.root_path || '').trim();
            const focusedPath = String(project_context.focused_path || '').trim();
            const summary = String(project_context.tree_summary || '').trim();
            const contextLines = ['Selected project context:'];
            if (rootPath) {
                contextLines.push(`- Root folder: ${rootPath}`);
            }
            if (focusedPath) {
                contextLines.push(`- Current focus: ${focusedPath}`);
            }
            if (summary) {
                contextLines.push('- File tree snapshot:');
                contextLines.push(summary);
            }
            extraSystemContext = contextLines.join('\n');
        }
        const runtimeDateInfo = getRuntimeDateInfo();
        const shouldUseRuntimeDate = isCurrentDateTimeQuery(message);
        const explicitWebSearchIntent = hasExplicitWebSearchIntent(message)
            || /(联网|上网|搜索|搜一下|查一下|帮我查|查资料|官方资料)/i.test(String(message || ''));

        if (shouldUseRuntimeDate && !explicitWebSearchIntent) {
            extraSystemContext = buildRuntimeDateContext(runtimeDateInfo);
        }

        if (normalizedChatMode === 'agent') {
            const assistantMessageId = genId();
            db.prepare(
                'INSERT INTO messages (id, session_id, role, content, model_name, created_at) VALUES (?, ?, ?, ?, ?, ?)'
            ).run(assistantMessageId, session_id, 'assistant', '', modelConfig.name, nowUTC());

            const result = await runAgentMode({
                res,
                sessionId: session_id,
                message,
                modelConfig,
                projectContext: project_context,
                externalContext: extraSystemContext,
                assistantMessageId,
            });

            db.prepare(
                'UPDATE messages SET content = ?, model_name = ? WHERE id = ?'
            ).run(result?.finalReport || '', modelConfig.name, assistantMessageId);

            res.end();
            return;
        }

        if (
            web_search
            && message
            && String(message).trim()
            && shouldAllowWebSearch(message, { userEnabled: web_search })
            && (!shouldUseRuntimeDate || explicitWebSearchIntent)
        ) {
            res.write(`data: ${JSON.stringify({
                type: 'status',
                status: 'searching',
                message: explicitWebSearchIntent ? '检测到明确的联网搜索请求，正在准备搜索…' : '正在准备联网搜索…',
            })}\n\n`);

            try {
                const searchQuery = await chooseSearchQuery(session_id, message, modelConfig, attachments);
                const effectiveSearchQueries = chooseEffectiveSearchQueries(session_id, message, searchQuery);
                const primarySearchQuery = effectiveSearchQueries[0] || '';

                if (!primarySearchQuery) {
                    res.write(`data: ${JSON.stringify({
                        type: 'status',
                        status: 'search_skipped',
                        message: '没有生成足够有效的搜索词，本次将直接回答。',
                        results: [],
                    })}\n\n`);
                } else {
                    res.write(`data: ${JSON.stringify({
                        type: 'status',
                        status: 'searching',
                        message: `正在联网搜索：${primarySearchQuery}`,
                    })}\n\n`);

                    const topResults = await runStructuredSearchQueries(effectiveSearchQueries);
                    const clientResults = topResults.length > 0
                        ? topResults
                        : buildSearchFallbackLinks(primarySearchQuery);

                    if (topResults.length > 0) {
                        extraSystemContext = [
                            extraSystemContext,
                            'You have live web search results for this request. Use the most relevant searched facts before falling back to model memory, and cite the source number and URL when you rely on them.',
                            buildSearchContext(primarySearchQuery, topResults.slice(0, SEARCH_CONTEXT_RESULTS_MAX)),
                        ].filter(Boolean).join('\n\n');
                    }

                    res.write(`data: ${JSON.stringify({
                        type: 'status',
                        status: clientResults.length > 0 ? 'search_done' : 'search_empty',
                        message: topResults.length > 0
                            ? `已找到 ${topResults.length} 条联网结果`
                            : '公开搜索源暂时没有返回可解析条目，已提供搜索入口链接。',
                        results: clientResults,
                    })}\n\n`);
                }
            } catch (searchError) {
                res.write(`data: ${JSON.stringify({
                    type: 'status',
                    status: 'search_failed',
                    message: `联网搜索失败，本次将直接回答：${searchError.message}`,
                })}\n\n`);
            }
        } else if (web_search && shouldUseRuntimeDate) {
            const results = [{
                title: 'Runtime clock',
                url: '',
                source: runtimeDateInfo.timezone,
                snippet: runtimeDateInfo.formatted,
            }];
            res.write(`data: ${JSON.stringify({
                type: 'status',
                status: 'search_done',
                message: `这是时间类问题，直接使用运行时系统时间：${runtimeDateInfo.formatted}`,
                results,
            })}\n\n`);
        }

        const messagesContext = buildMessagesContext(session_id, message, attachments, {
            appendUserMessage: !regenerate,
            extraSystemContext,
            chatMode: normalizedChatMode,
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
            error: `Streaming response interrupted: ${error.message}`,
        })}\n\n`);
    }

    res.end();
});

module.exports = router;
