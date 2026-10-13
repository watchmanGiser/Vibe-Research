import test from 'node:test';
import assert from 'node:assert/strict';
import { withRenderer, textOf } from './helpers/render.ts';

test('独立情报页提供两栏、历史搜索和主题切换，不包含个人工作台入口', async () => {
  await withRenderer(async r => {
    const { DingTalkStandalone } = await r.load('/src/verticals/finance/pages/DingTalkStandalone.tsx');
    const html = r.html(DingTalkStandalone, {});
    const text = textOf(html);
    assert.match(text, /击球区 消息/);
    assert.match(text, /原始消息/);
    assert.match(text, /整理信息/);
    assert.match(html, /aria-label="搜索原始消息"/);
    assert.match(html, /aria-label="切换为深色"/);
    assert.doesNotMatch(html, /产品侧栏|原产品板块导航|接入 AI|个人台账/);
    assert.doesNotMatch(text, /上一页|下一页/);
  });
});

test('消息页使用独立主题偏好，旧版失效设置不影响默认白底', async () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  const preferences = new Map([['vra-theme', 'dark'], ['vr-theme', 'dark']]);
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, value: { getItem: (key: string) => preferences.get(key) ?? null } });
  try {
    await withRenderer(async r => {
      const { DingTalkStandalone } = await r.load('/src/verticals/finance/pages/DingTalkStandalone.tsx');
      assert.match(r.html(DingTalkStandalone, {}), /aria-label="切换为深色"/);
      preferences.set('dingtalk-theme', 'dark');
      assert.match(r.html(DingTalkStandalone, {}), /aria-label="切换为浅色"/);
      preferences.set('dingtalk-theme', 'light');
      assert.match(r.html(DingTalkStandalone, {}), /aria-label="切换为深色"/);
    });
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else Reflect.deleteProperty(globalThis, 'localStorage');
  }
});

test('手机信息切换提供两个可访问按钮，首次选择原始信息，两个内容区域完整保留', async()=>{
 await withRenderer(async r=>{
  const {DingTalkStandalone}=await r.load('/src/verticals/finance/pages/DingTalkStandalone.tsx');
  const html=r.html(DingTalkStandalone,{});
  assert.match(html,/aria-label="切换信息视图"/);
  assert.match(html,/<button[^>]*aria-pressed="true"[^>]*>[^]*?原始信息<\/button>/);
  assert.match(html,/<button[^>]*aria-pressed="false"[^>]*>[^]*?整理信息<\/button>/);
  assert.match(html,/aria-label="原始消息"/);assert.match(html,/aria-label="整理信息"/);
  assert.doesNotMatch(textOf(html),/上一页|下一页/);
 });
});
