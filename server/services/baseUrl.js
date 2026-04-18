/**
 * Base URL 规范化工具
 * 统一处理 OpenAI 兼容接口的 Base URL，避免路径重复拼接。
 * 
 * 与 Python 版 base_url_service.py 逻辑 1:1 对应。
 */
const { URL } = require('url');

/**
 * 将用户输入的 Base URL 规范化为稳定格式。
 * - 去掉尾部 /chat/completions
 * - 统一 /v1 大小写
 * @param {string} baseUrl
 * @returns {string}
 */
function normalizeOpenaiBaseUrl(baseUrl) {
    let base = (baseUrl || '').trim().replace(/\/+$/, '');
    if (!base) return '';

    const lower = base.toLowerCase();
    const chatSuffix = '/chat/completions';
    const responsesSuffix = '/responses';
    const v1Suffix = '/v1';

    if (lower.endsWith(chatSuffix)) {
        base = base.slice(0, -chatSuffix.length);
    }

    if (base.toLowerCase().endsWith(responsesSuffix)) {
        base = base.slice(0, -responsesSuffix.length);
    }

    const lowerAfter = base.toLowerCase();
    if (lowerAfter.endsWith(v1Suffix)) {
        base = base.slice(0, -v1Suffix.length) + '/v1';
    }

    return base.replace(/\/+$/, '');
}

/**
 * 确保 Base URL 可直接传给 OpenAI SDK（末尾含 /v1）
 * @param {string} baseUrl
 * @returns {string}
 */
function ensureOpenaiApiBaseUrl(baseUrl) {
    let base = normalizeOpenaiBaseUrl(baseUrl);
    if (base && !base.toLowerCase().endsWith('/v1')) {
        base = `${base}/v1`;
    }
    return base;
}

/**
 * 构造完整的 chat completions URL
 * @param {string} baseUrl
 * @returns {string}
 */
function buildChatCompletionsUrl(baseUrl) {
    const base = ensureOpenaiApiBaseUrl(baseUrl);
    return base ? `${base}/chat/completions` : '';
}

/**
 * 判断是否为本地回环地址，需要禁用系统代理
 * @param {string} baseUrl
 * @returns {boolean}
 */
function shouldBypassEnvProxy(baseUrl) {
    try {
        const parsed = new URL((baseUrl || '').trim());
        const hostname = (parsed.hostname || '').toLowerCase();
        return ['127.0.0.1', 'localhost', '::1'].includes(hostname);
    } catch {
        return false;
    }
}

module.exports = {
    normalizeOpenaiBaseUrl,
    ensureOpenaiApiBaseUrl,
    buildChatCompletionsUrl,
    shouldBypassEnvProxy,
};
