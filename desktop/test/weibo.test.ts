import test from 'node:test';
import assert from 'node:assert/strict';
import { withRenderer, textOf } from './helpers/render.ts';
const item = { id: '100', author: '交易者简放', time: '2026-10-13T05:20:48Z', text: '完整长微博\n'.repeat(120) + '保留最后一句<script>不是代码</script>', textComplete: true,
  url: 'https://weibo.com/1357064103/Test', images: ['https://wx1.sinaimg.cn/large/test.jpg'], source: '微博网页版', likes: 2, comments: 3, reposts: 4, pinned: false, repost: null };
test('卡片保留全文、原帖、图片与北京时间，微博文本不能执行 HTML', async () => withRenderer(async r => {
  const { JianfangPostCard } = await r.load('/src/verticals/finance/pages/JianfangPanel.tsx');
  const html = r.html(JianfangPostCard, { item }); const text = textOf(html);
  assert.match(text, /保留最后一句/); assert.match(text, /13:20:48/); assert.match(text, /展开全文/);
  assert.match(html, /&lt;script&gt;/); assert.doesNotMatch(html, /<script>/); assert.match(html, /https:\/\/weibo.com\/1357064103\/Test/);
  assert.match(html, /referrerPolicy="no-referrer"/i); assert.match(text, /赞 2 · 评 3 · 转 4/);
}));
test('节选明确标注，转发内容和原作者都显示', async () => withRenderer(async r => {
  const { JianfangPostCard } = await r.load('/src/verticals/finance/pages/JianfangPanel.tsx');
  const text = textOf(r.html(JianfangPostCard, { item: { ...item, text: '当前内容', textComplete: false, repost: { ...item, id: '200', author: '转发原作者', text: '被转发的完整正文' } } }));
  assert.match(text, /当前为节选/); assert.match(text, /转发 @转发原作者/); assert.match(text, /被转发的完整正文/);
}));
test('同步失败与过期存档有清晰状态，显示上次成功时间', async () => withRenderer(async r => {
  const { JianfangFeedStatus } = await r.load('/src/verticals/finance/pages/JianfangPanel.tsx');
  const data = { total: 11, syncedAt: '2026-10-13T00:00:00Z', status: 'error', error: '当前展示上次成功保存的内容' };
  const text = textOf(r.html(JianfangFeedStatus, { data })); assert.match(text, /已记录 11 条/); assert.match(text, /08:00:00/); assert.match(text, /上次成功保存/);
}));
