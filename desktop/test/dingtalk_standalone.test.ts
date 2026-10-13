import test from 'node:test';
import assert from 'node:assert/strict';
import { withRenderer, textOf } from './helpers/render.ts';

test('独立情报页提供两栏、历史搜索和主题切换，不包含个人工作台入口', async () => {
  await withRenderer(async r => {
    const { DingTalkStandalone } = await r.load('/src/verticals/finance/pages/DingTalkStandalone.tsx');
    const html = r.html(DingTalkStandalone, {});
    const text = textOf(html);
    assert.match(text, /击球区情报/);
    assert.match(text, /原始消息/);
    assert.match(text, /观点总结/);
    assert.match(html, /aria-label="搜索原始消息"/);
    assert.match(html, /aria-label="切换为浅色"/);
    assert.doesNotMatch(html, /产品侧栏|原产品板块导航|接入 AI|个人台账/);
  });
});
