const msg = '联网搜索一下今天是周几';
const shouldUseRuntimeDate = [
  /今天.*(几号|日期|星期|礼拜|时间)/i,
  /现在.*(几点|时间|日期|几号)/i,
  /当前.*(日期|时间)/i,
  /^(几号|星期几|几点了|today|date|time)$/i,
].some((r) => r.test(msg));
const explicitWebSearchIntent = /(联网|上网|搜索|查一下|帮我查|查资料|官方资料)/i.test(msg);
const entersWebSearch = !!(msg && msg.trim() && (!shouldUseRuntimeDate || explicitWebSearchIntent));
const fallbackSearchQuery = msg
  .replace(/^(请|帮我|麻烦|可以|能不能|请你|请问)?/i, '')
  .replace(/(联网搜索|上网查|网上查|搜索一下|搜索下|查一下|查下|帮我查一下|帮我搜索|帮我搜一下|search the web|web search|browse the web|look it up online)/ig, ' ')
  .replace(/^\s*(一下|一下子|一下下)/i, ' ')
  .replace(/(官网|官方文档|官方说明|新闻来源|参考链接|文章来源)/ig, ' ')
  .replace(/[：:]/g, ' ')
  .replace(/\s+/g, ' ')
  .trim();

console.log(JSON.stringify({
  msg,
  shouldUseRuntimeDate,
  explicitWebSearchIntent,
  entersWebSearch,
  fallbackSearchQuery,
}, null, 2));
