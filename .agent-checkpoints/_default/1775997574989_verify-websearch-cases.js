function buildFallbackSearchQuery(message) {
  return String(message || '')
    .trim()
    .replace(/^(请|帮我|麻烦|可以|能不能|请你|请问)?/i, '')
    .replace(/(联网搜索|上网查|网上查|搜索一下|搜索下|查一下|查下|帮我查一下|帮我搜索|帮我搜一下|search the web|web search|browse the web|look it up online)/ig, ' ')
    .replace(/^\s*(一下|一下子|一下下)/i, ' ')
    .replace(/(官网|官方文档|官方说明|新闻来源|参考链接|文章来源)/ig, ' ')
    .replace(/[：:]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 240);
}

function tokenizeSearchText(text) {
  return String(text || '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .map((token) => token.trim())
    .filter(Boolean);
}

function isReliableSearchQuery(message, query) {
  const sourceText = String(message || '').trim();
  const searchQuery = String(query || '').trim();
  if (!sourceText || !searchQuery) return false;
  if (searchQuery.length < 2 || searchQuery.length > 2000) return false;
  if (/^(请|帮我|给我|能不能|是否|为什么|怎么|如何)$/i.test(searchQuery)) return false;
  if (/(回答|回复|解释|总结|分析|assistant|system|prompt|tool|function|json|markdown|代码块)/i.test(searchQuery)) return false;
  if (/[,，。；;！？!?]{3,}|```|~~~|\{|\}|\[|\]/.test(searchQuery)) return false;

  const normalizedSource = sourceText.toLowerCase().replace(/\s+/g, '');
  const normalizedQuery = searchQuery.toLowerCase().replace(/\s+/g, '');
  if (normalizedSource.includes(normalizedQuery) || normalizedQuery.includes(normalizedSource)) return true;

  const messageTokens = new Set(tokenizeSearchText(sourceText));
  const queryTokens = tokenizeSearchText(searchQuery).filter((token) => token.length >= 2);
  if (queryTokens.length === 0) return false;

  const overlapCount = queryTokens.filter((token) => messageTokens.has(token)).length;
  return overlapCount / queryTokens.length >= 0.5;
}

const cases = [
  {
    name: 'positive-explicit-search',
    message: '联网搜索一下今天是周几',
    modelQuery: '今天是周几',
  },
  {
    name: 'negative-prompt-pollution',
    message: '联网搜索一下今天是周几',
    modelQuery: '请总结并回答 assistant system prompt',
  },
  {
    name: 'negative-low-overlap',
    message: '联网搜索一下今天是周几',
    modelQuery: 'OpenAI 发布会 直播地址',
  },
];

const result = cases.map((item) => ({
  ...item,
  fallback: buildFallbackSearchQuery(item.message),
  reliable: isReliableSearchQuery(item.message, item.modelQuery),
}));

console.log(JSON.stringify(result, null, 2));
