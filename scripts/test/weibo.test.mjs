import test from 'node:test';
import assert from 'node:assert/strict';
import { htmlToText, normalizePost, mergePosts, buildSnapshot, failureSnapshot, UID } from '../weibo/weibo-common.mjs';
const raw = (id = '100') => ({ id, bid: 'Test1', created_at: 'Tue Oct 13 13:20:48 +0800 2026', user: { id: Number(UID), screen_name: '交易者简放' },
  text: '第一段<br /><br />第二段 &amp; &#x4e2d;', pics: [], source: '微博网页版', isLongText: false, likes: 0 });
test('保留原文换行、表情和引用链接，实体解码不执行 HTML', () => {
  assert.equal(htmlToText('甲<br>乙<img alt="[微笑]" src="x">&lt;script&gt;'), '甲\n乙[微笑]<script>');
  assert.equal(htmlToText('<script>alert(1)</script><a href="https://weibo.com">参考</a>'), '参考 (https://weibo.com)');
});
test('按实际发布时间排序且通过 ID 去重，置顶旧文不能排到最新之前', () => {
  const first = normalizePost(raw());
  const second = normalizePost({ ...raw('101'), created_at: 'Fri Jan 02 20:00:00 +0800 2026', title: { text: '置顶' } });
  assert.equal(first.time, '2026-10-13T05:20:48.000Z');
  const result = mergePosts([first, second], [{ ...first, likes: 10 }]);
  assert.equal(result.length, 2); assert.equal(result[0].id, '100'); assert.equal(result[0].likes, 10); assert.equal(result[1].pinned, true);
});
test('长微博补全文，转发保留原作者；补取失败不覆盖此前完整文本', () => {
  const data = { ...raw(), isLongText: true, text: '节选', retweeted_status: { ...raw('200'), user: { id: 123, screen_name: '原作者' }, isLongText: true } };
  const complete = normalizePost(data, new Map([['100', { longTextContent: '完整原文末句' }], ['200', { longTextContent: '转发全文末句' }]]));
  assert.equal(complete.textComplete, true); assert.equal(complete.repost.author, '原作者');
  const result = mergePosts([complete], [normalizePost(data)])[0];
  assert.equal(result.text, '完整原文末句'); assert.equal(result.repost.text, '转发全文末句');
});
test('拒绝错误账号与伪造时间，外部图片域名不能进入采集结果', () => {
  assert.throws(() => normalizePost({ ...raw(), user: { id: 123 } }));
  assert.throws(() => normalizePost({ ...raw(), created_at: '昨天' }));
  assert.deepEqual(normalizePost({ ...raw(), pics: [{ url: 'https://evil.test/p.jpg' }, { large: { url: 'https://wx1.sinaimg.cn/large/x.jpg' } }] }).images, ['https://wx1.sinaimg.cn/large/x.jpg']);
});
test('失败保留上次成功时间与内容，不把失败误报成空列表或新鲜数据', () => {
  const at = '2026-10-13T05:00:00Z'; const prior = buildSnapshot(null, [normalizePost(raw())], at);
  const failed = failureSnapshot(prior, '2026-10-13T05:15:00Z');
  assert.equal(failed.syncedAt, at); assert.equal(failed.items[0].text, prior.items[0].text); assert.equal(failed.status, 'error');
  assert.equal(failureSnapshot(null, at), null); assert.throws(() => buildSnapshot(prior, [], at));
});
