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

test('合并消息保留可查看的其他原始版本、发送时间和全部配图，采用整页展开', async () => {
  await withRenderer(async r => {
    const { DingTalkMessageCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const html = r.html(DingTalkMessageCard, { item: { id: 'a'.repeat(64), time: '2026-10-13 10:00:00', sender: '首发', text: '首次原稿', duplicateCount: 1, relatedIds: ['a'.repeat(64),'b'.repeat(64)], latestDuplicateTime: '2026-10-13 11:00:00', versions: [{id:'b'.repeat(64),time:'2026-10-13 11:00:00',sender:'转发',text:'补充版本[图片消息](mediaId=@other)',images:[{reference:'@other',url:`/dingtalk/media/${'c'.repeat(64)}.jpg`}]}] } });
    assert.match(textOf(html), /查看其他原始版本（1 份）/);assert.match(textOf(html), /补充版本/);assert.match(textOf(html), /11:00:00/);
    assert.equal((html.match(/data-message-id=/g)||[]).length,1);assert.match(html, /<details/);assert.match(html, /<img /);
    assert.doesNotMatch(html, /overflow-y-auto|max-h-\[|上一页|下一页/);
  });
});

test('已下载文档提供预览和原文件下载，解析失败仍保留下载入口', async () => {
  await withRenderer(async r => {
    const { DingTalkMessageCard } = await r.load('/src/verticals/finance/pages/SemiPanels.tsx');
    const fingerprint = 'f'.repeat(64);
    const document = { id: 'e'.repeat(64), name: '研究资料.pdf', kind: 'pdf', status: 'ready', url: `/dingtalk/documents/${fingerprint}.pdf`, textUrl: `/dingtalk/documents/${fingerprint}.txt`, previewUrl: `/dingtalk/documents/${fingerprint}.pdf`, pageCount: 3, previewImages: [`/dingtalk/documents/${fingerprint}-page-001.jpg`] };
    const source = { id: 'a'.repeat(64), time: '2026-10-14 10:00:00', sender: '测试', text: '研究资料', duplicateCount: 0, relatedIds: ['a'.repeat(64)], latestDuplicateTime: null, documents: [document] };
    const html = r.html(DingTalkMessageCard, { item: source });
    assert.match(textOf(html), /预览文档/); assert.match(textOf(html), /已下载 · 正文已解析 · 3 页/);
    assert.ok(html.includes(`href="${document.url}" download="研究资料.pdf"`));
    const failed = r.html(DingTalkMessageCard, { item: { ...source, documents: [{ ...document, status: 'parse_failed', textUrl: undefined }] } });
    assert.match(textOf(failed), /正文解析暂未成功/); assert.match(textOf(failed), /下载原文件/); assert.doesNotMatch(textOf(failed), /预览文档/);
  });
});
