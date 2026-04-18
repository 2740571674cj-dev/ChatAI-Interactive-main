const fs = require('fs');
const path = require('path');
const { Client } = require('@modelcontextprotocol/sdk/client/index.js');
const { StdioClientTransport } = require('@modelcontextprotocol/sdk/client/stdio.js');
const { StreamableHTTPClientTransport } = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
const { getDataDir } = require('../database');

const MCP_SEARCH_TIMEOUT_MS = 30000;
const DEFAULT_MAX_RESULTS = 8;
const SEARCH_TOOL_RE = /(web[_-]?search|search|brave|tavily|exa|serp|google|bing|duckduckgo)/i;
const GENERIC_TOOL_RE = /(read|fetch|get|open|visit|crawl|scrape|browser|page|resource|content)/i;
const NOISE_TEXT_RE = /(cookie|cookies|javascript|enable javascript|privacy policy|terms of service|登录|注册|导航|菜单|免责声明|广告|版权所有)/i;

function getHostname(url) {
    try {
        return new URL(url).hostname.replace(/^www\./, '');
    } catch {
        return '';
    }
}

function parseJsonArray(value) {
    if (!value) {
        return [];
    }
    try {
        const parsed = JSON.parse(value);
        return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
        return String(value).split(/\s+/).filter(Boolean);
    }
}

function loadJsonConfig(filePath) {
    if (!filePath || !fs.existsSync(filePath)) {
        return null;
    }

    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (error) {
        throw new Error(`MCP search config parse failed: ${error.message}`);
    }
}

function loadMcpSearchConfig() {
    const configPath = process.env.CHATAI_MCP_SEARCH_CONFIG
        || path.join(getDataDir(), 'mcp-search.json');
    const fileConfig = loadJsonConfig(configPath);
    if (fileConfig) {
        return fileConfig;
    }

    if (process.env.CHATAI_MCP_SEARCH_URL) {
        return {
            servers: [{
                name: 'mcp-web',
                transport: 'http',
                url: process.env.CHATAI_MCP_SEARCH_URL,
                tool: process.env.CHATAI_MCP_SEARCH_TOOL || '',
            }],
        };
    }

    if (process.env.CHATAI_MCP_SEARCH_COMMAND) {
        return {
            servers: [{
                name: 'mcp-web',
                transport: 'stdio',
                command: process.env.CHATAI_MCP_SEARCH_COMMAND,
                args: parseJsonArray(process.env.CHATAI_MCP_SEARCH_ARGS),
                tool: process.env.CHATAI_MCP_SEARCH_TOOL || '',
            }],
        };
    }

    return { servers: [] };
}

function normalizeServers(config) {
    const servers = Array.isArray(config?.servers)
        ? config.servers
        : Object.entries(config?.mcpServers || {}).map(([name, server]) => ({ name, ...server }));

    return servers
        .map((server, index) => ({
            name: server.name || `mcp-${index + 1}`,
            transport: server.transport || (server.url ? 'http' : 'stdio'),
            url: server.url || '',
            command: server.command || '',
            args: Array.isArray(server.args) ? server.args.map(String) : [],
            env: server.env && typeof server.env === 'object' ? server.env : {},
            headers: server.headers && typeof server.headers === 'object' ? server.headers : {},
            cwd: server.cwd || process.cwd(),
            tool: server.tool || server.toolName || '',
            arguments: server.arguments && typeof server.arguments === 'object' ? server.arguments : {},
            timeoutMs: Number(server.timeoutMs) || MCP_SEARCH_TIMEOUT_MS,
        }))
        .filter((server) => server.transport === 'http' ? server.url : server.command);
}

function createTransport(server) {
    if (server.transport === 'http') {
        return new StreamableHTTPClientTransport(new URL(server.url), {
            requestInit: {
                headers: server.headers,
            },
        });
    }

    return new StdioClientTransport({
        command: server.command,
        args: server.args,
        env: { ...process.env, ...server.env },
        cwd: server.cwd,
        stderr: 'pipe',
    });
}

function withTimeout(promise, timeoutMs, label) {
    let timeout = null;
    const timeoutPromise = new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs);
    });

    return Promise.race([promise, timeoutPromise]).finally(() => clearTimeout(timeout));
}

function chooseSearchTool(tools, preferredTool = '') {
    if (!Array.isArray(tools) || tools.length === 0) {
        return null;
    }

    if (preferredTool) {
        const exact = tools.find((tool) => tool.name === preferredTool);
        if (exact) {
            return exact;
        }
    }

    const matched = tools.filter((tool) => SEARCH_TOOL_RE.test(`${tool.name || ''} ${tool.description || ''}`));
    const specific = matched.find((tool) => !GENERIC_TOOL_RE.test(`${tool.name || ''} ${tool.description || ''}`));
    if (specific) {
        return specific;
    }

    return matched[0] || null;
}

function buildToolArguments(tool, query, maxResults, defaults = {}) {
    const properties = tool?.inputSchema?.properties || {};
    const required = new Set(tool?.inputSchema?.required || []);
    const args = { ...defaults };

    const queryKey = ['query', 'q', 'search', 'searchQuery', 'text', 'keyword', 'keywords']
        .find((key) => Object.prototype.hasOwnProperty.call(properties, key) || required.has(key));
    args[queryKey || 'query'] = query;

    const countKey = ['count', 'limit', 'maxResults', 'numResults', 'num_results', 'topK', 'top_k']
        .find((key) => Object.prototype.hasOwnProperty.call(properties, key) || required.has(key));
    if (countKey && args[countKey] == null) {
        args[countKey] = maxResults;
    }

    return args;
}

function safeSnippet(text, maxLength = 500) {
    const value = String(text || '')
        .replace(/!\[[^\]]*]\([^)]*\)/g, '')
        .replace(/<img\b[^>]*>/gi, '')
        .replace(/\b(?:image|thumbnail|avatar|logo|photo)\s*:\s*https?:\/\/\S+/gi, '')
        .replace(/\s+/g, ' ')
        .trim();
    return value.length > maxLength ? `${value.slice(0, maxLength).trim()}...` : value;
}

function flattenObjectValues(value, depth = 0) {
    if (depth > 4 || value == null) {
        return [];
    }
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
        return [String(value)];
    }
    if (Array.isArray(value)) {
        return value.flatMap((item) => flattenObjectValues(item, depth + 1));
    }
    if (typeof value === 'object') {
        return Object.values(value).flatMap((item) => flattenObjectValues(item, depth + 1));
    }
    return [];
}

function normalizeStructuredItems(value) {
    const source = Array.isArray(value)
        ? value
        : Array.isArray(value?.results)
            ? value.results
            : Array.isArray(value?.items)
                ? value.items
                : Array.isArray(value?.data)
                    ? value.data
                    : [];

    return source
        .map((item) => {
            if (!item || typeof item !== 'object') {
                return null;
            }
            const url = item.url || item.link || item.href || item.uri;
            const title = item.title || item.name || item.heading || url;
            const snippet = item.snippet || item.description || item.content || item.text || item.summary || '';
            return url ? {
                title: safeSnippet(title, 160),
                url: String(url),
                snippet: safeSnippet(snippet),
                source: getHostname(url),
            } : null;
        })
        .filter(Boolean);
}

function normalizeTextContent(text) {
    try {
        const parsed = JSON.parse(String(text || ''));
        const structuredItems = normalizeStructuredItems(parsed);
        if (structuredItems.length > 0) {
            return structuredItems;
        }
    } catch {}

    const results = [];
    const lines = String(text || '').split(/\n+/).map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
        const urlMatch = line.match(/https?:\/\/[^\s)\]}>"']+/i);
        if (!urlMatch) {
            continue;
        }
        const url = urlMatch[0].replace(/[.,;:]+$/, '');
        const title = line
            .replace(urlMatch[0], '')
            .replace(/^[\s\-*#\d.)\]]+/, '')
            .replace(/\s+/g, ' ')
            .trim() || url;
        results.push({
            title: safeSnippet(title, 160),
            url,
            snippet: safeSnippet(line),
            source: getHostname(url),
        });
    }

    return results;
}

function normalizeToolResult(result, serverName, toolName) {
    const normalized = [];
    let sawJsonPayload = false;

    if (result?.structuredContent) {
        normalized.push(...normalizeStructuredItems(result.structuredContent));
    }

    if (result?.toolResult) {
        normalized.push(...normalizeStructuredItems(result.toolResult));
    }

    for (const part of result?.content || []) {
        if (part.type === 'text') {
            normalized.push(...normalizeTextContent(part.text));
            const text = String(part.text || '').trim();
            const isJsonPayload = text.startsWith('{') || text.startsWith('[');
            sawJsonPayload = sawJsonPayload || isJsonPayload;
            if (normalized.length === 0 && text && !isJsonPayload) {
                normalized.push({
                    title: `MCP result from ${serverName}`,
                    url: '',
                    snippet: safeSnippet(text),
                    source: serverName,
                });
            }
        } else if (part.type === 'resource_link' && part.uri) {
            normalized.push({
                title: safeSnippet(part.title || part.name || part.uri, 160),
                url: part.uri,
                snippet: safeSnippet(part.description || ''),
                source: getHostname(part.uri) || serverName,
            });
        } else if (part.type === 'resource' && part.resource?.uri) {
            normalized.push({
                title: safeSnippet(part.resource.uri, 160),
                url: part.resource.uri,
                snippet: safeSnippet(part.resource.text || ''),
                source: getHostname(part.resource.uri) || serverName,
            });
        }
    }

    if (normalized.length === 0 && !sawJsonPayload) {
        const text = flattenObjectValues(result).join(' ');
        if (text) {
            normalized.push({
                title: `MCP result from ${serverName}`,
                url: '',
                snippet: safeSnippet(text),
                source: serverName,
            });
        }
    }

    const seen = new Set();
    return normalized
        .filter((item) => item.title || item.url || item.snippet)
        .filter((item) => {
            const key = item.url || `${item.title}\n${item.snippet}`;
            if (seen.has(key)) {
                return false;
            }
            seen.add(key);
            return true;
        })
        .map((item) => ({
            ...item,
            mcpServer: serverName,
            mcpTool: toolName,
        }));
}

async function callMcpSearchServer(server, query, maxResults) {
    const client = new Client({
        name: 'chatai-interactive',
        version: '1.0.0',
    }, {
        capabilities: {},
    });
    const transport = createTransport(server);

    try {
        await withTimeout(client.connect(transport), server.timeoutMs, `${server.name} connect`);
        const toolList = await withTimeout(client.listTools(), server.timeoutMs, `${server.name} listTools`);
        const tool = chooseSearchTool(toolList.tools, server.tool);
        if (!tool) {
            throw new Error(`No MCP tools found on ${server.name}`);
        }

        const args = buildToolArguments(tool, query, maxResults, server.arguments);
        const result = await withTimeout(
            client.callTool({ name: tool.name, arguments: args }),
            server.timeoutMs,
            `${server.name}.${tool.name}`
        );
        return normalizeToolResult(result, server.name, tool.name).slice(0, maxResults);
    } finally {
        try {
            await client.close();
        } catch {}
    }
}

async function mcpWebSearch(query, options = {}) {
    const maxResults = Number(options.maxResults) || DEFAULT_MAX_RESULTS;
    const servers = normalizeServers(loadMcpSearchConfig());
    if (servers.length === 0) {
        return [];
    }

    let lastError = null;
    for (const server of servers) {
        try {
            const results = await callMcpSearchServer(server, query, maxResults);
            if (results.length > 0) {
                return results;
            }
        } catch (error) {
            lastError = error;
        }
    }

    if (lastError) {
        throw lastError;
    }
    return [];
}

function hasMcpSearchConfig() {
    return normalizeServers(loadMcpSearchConfig()).length > 0;
}

module.exports = {
    mcpWebSearch,
    hasMcpSearchConfig,
};
