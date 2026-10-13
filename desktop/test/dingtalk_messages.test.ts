import test from 'node:test';
import assert from 'node:assert/strict';
import { withRenderer, textOf } from './helpers/render.ts';

test('原文卡片保留长文最后一句、发送者与重复计数，提供展开全文入口', async () => {
  await withRenderer(async r => {
    const { DingTalkMessageCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const body = '长篇消息\n'.repeat(1000) + '必须保留的最后一句';
    const html = r.html(DingTalkMessageCard, { item: { id: 'a'.repeat(64), time: '2026-10-13T02:00:00Z', sender: '测试发送者', text: body, duplicateCount: 2, relatedIds: ['a'.repeat(64)], latestDuplicateTime: null } });
    const visible = textOf(html);
    assert.match(visible, /必须保留的最后一句/); assert.match(visible, /测试发送者/); assert.match(visible, /已合并 2 条重复/);
    assert.match(visible, /展开全文/); assert.match(visible, /10:00:00/);
  });
});

test('短消息直接显示全文，原文中的 HTML 不会作为网页执行', async () => {
  await withRenderer(async r => {
    const { DingTalkMessageCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const html = r.html(DingTalkMessageCard, { item: { id: 'b'.repeat(64), time: '2026-10-13 10:00:00', sender: '甲', text: '<script>原文内容</script>', duplicateCount: 0, relatedIds: ['b'.repeat(64)], latestDuplicateTime: null } });
    assert.ok(html.includes('&lt;script&gt;原文内容&lt;/script&gt;'));
    assert.doesNotMatch(html, /<script>|展开全文|已合并/);
  });
});

test('配图直接展示且可查看原图，清理空行和图片技术占位并保留段落、数值', async () => {
  await withRenderer(async r => {
    const { DingTalkMessageCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const url = `/dingtalk/media/${'c'.repeat(64)}.jpg`;
    const original = '价格 1.5 元  \r\n\r\n \r\n价格 15 元\r\n\r\n[图片消息](mediaId=@real-image)\n图片内容：\n<imageContent>\nimage.jpg\n</imageContent>';
    const item = { id: 'c'.repeat(64), time: '2026-10-13 10:00:00', sender: '甲', text: original, duplicateCount: 0, relatedIds: ['c'.repeat(64)], latestDuplicateTime: null, images: [{ reference: '@real-image', url }] };
    const html = r.html(DingTalkMessageCard, { item });
    assert.match(html, /价格 1\.5 元\n价格 15 元/);
    assert.ok(html.includes(`<img src="${url}"`));
    assert.ok(html.includes(`href="${url}" target="_blank"`));
    assert.match(textOf(html), /点击查看原图/);
    assert.doesNotMatch(html, /\[图片消息\]|mediaId=|image\.jpg|imageContent|\n\n/);
    assert.equal(item.text, original);
  });
});

test('历史公开网址和纯图片消息也能展示；一条消息的全部图片都保留', async () => {
  await withRenderer(async r => {
    const { DingTalkMessageCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const images = Array.from({ length: 6 }, (_, i) => `[图片消息](mediaId=https://example.com/photo-${i}.jpg)`);
    const html = r.html(DingTalkMessageCard, { item: { id: 'd'.repeat(64), time: '2026-10-13 10:00:00', sender: '乙', text: images.join('\n\n'), duplicateCount: 0, relatedIds: ['d'.repeat(64)], latestDuplicateTime: null } });
    assert.equal((html.match(/<img /g) || []).length, 6);
    assert.ok(html.includes('https://example.com/photo-5.jpg'));
    assert.doesNotMatch(textOf(html), /mediaId|图片消息|展开全文/);
  });
});

test('图片描述保留，危险地址和尚未获取的原图不会作为图片网址执行', async () => {
  await withRenderer(async r => {
    const { DingTalkMessageCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const text = '正文\n[图片消息](mediaId=@missing)\n图片内容：\n<imageContent>需求增长 15%，报价 1.5 元</imageContent>\n[图片消息](mediaId=javascript:evil)';
    const html = r.html(DingTalkMessageCard, { item: { id: 'e'.repeat(64), time: '2026-10-13 10:00:00', sender: '丙', text, duplicateCount: 0, relatedIds: ['e'.repeat(64)], latestDuplicateTime: null, images: [{ reference: '@missing', url: 'data:text/html,evil' }] } });
    assert.match(textOf(html), /需求增长 15%，报价 1\.5 元/);
    assert.match(textOf(html), /原图暂时无法加载/);
    assert.doesNotMatch(html, /<img |javascript:|data:text/);
  });
});
