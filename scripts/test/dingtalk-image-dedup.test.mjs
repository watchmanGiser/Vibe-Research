import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeMessageHistory } from '../dingtalk-duplicates.mjs';

const message = (id, text, time = '2026-10-17 10:00:00') => ({ messageId: id, text, time, sender: id, duplicateCount: 0 });
const photo = (reference, caption = '') => `${caption}[图片消息](mediaId=${reference})\n图片内容：\n<imageContent>\nimage.jpg\n</imageContent>`;
const signature = (w, h, d) => ({ w, h, d });
const merge = (messages, fingerprints) => mergeMessageHistory(messages, [], { fingerprints });

test('同一张图经多次转发、mediaId 全部不同时按图片指纹合并', () => {
  const fingerprints = new Map([
    ['@a', signature(661, 3907, '0000000000000000')],
    ['@b', signature(661, 3907, '0000000000000003')],
    ['https://pic.guhai888.cn/view.php/0123456789abcdef0123456789abcdef.jpg', signature(661, 3907, '0000000000000001')],
  ]);
  const result = merge([
    message('a', photo('@a'), '2026-10-17 15:41:01'),
    message('b', photo('@b'), '2026-10-17 17:04:50'),
    message('c', photo('https://pic.guhai888.cn/view.php/0123456789abcdef0123456789abcdef.jpg'), '2026-10-17 18:34:34'),
  ], fingerprints);
  assert.equal(result.messages.length, 1);
  assert.equal(result.messages[0].messageId, 'a');
  assert.equal(result.messages[0].time, '2026-10-17 15:41:01');
  assert.equal(result.messages[0].duplicateCount, 2);
  assert.equal(result.messages[0].duplicateSources.length, 2);
  assert.equal(result.duplicateCount, 2);
});

test('dHash 超出阈值的图片仍按不同消息保留', () => {
  const fingerprints = new Map([
    ['@a', signature(661, 3907, '0000000000000000')],
    ['@b', signature(661, 3907, '00000000000000ff')],
  ]);
  assert.equal(merge([message('a', photo('@a')), message('b', photo('@b'))], fingerprints).messages.length, 2);
});

test('尺寸不同时即使 dHash 一致也不合并', () => {
  const fingerprints = new Map([
    ['@a', signature(661, 3907, '0000000000000000')],
    ['@b', signature(800, 1066, '0000000000000000')],
  ]);
  assert.equal(merge([message('a', photo('@a')), message('b', photo('@b'))], fingerprints).messages.length, 2);
});

test('一张指纹缺失时不做图片判重，保持原有文本去重结果', () => {
  const fingerprints = new Map([['@a', signature(661, 3907, '0000000000000000')]]);
  assert.equal(merge([message('a', photo('@a')), message('b', photo('@b'))], fingerprints).messages.length, 2);
  assert.equal(mergeMessageHistory([message('a', photo('@a')), message('b', photo('@b'))]).messages.length, 2);
});

test('带短文字的图片消息必须文字与图片同时一致才合并', () => {
  const fingerprints = new Map([
    ['@a', signature(661, 3907, '0000000000000000')],
    ['@b', signature(661, 3907, '0000000000000002')],
    ['@c', signature(661, 3907, '0000000000000000')],
  ]);
  const same = merge([message('a', photo('@a', '看图')), message('b', photo('@b', '看图'))], fingerprints);
  assert.equal(same.messages.length, 1);
  assert.equal(same.messages[0].duplicateCount, 1);
  const different = merge([message('a', photo('@a', '看图')), message('c', photo('@c', '看这个'))], fingerprints);
  assert.equal(different.messages.length, 2);
});

test('多图消息按整组指纹比对，张数不同不合并', () => {
  const fingerprints = new Map([
    ['@a1', signature(800, 1066, '0000000000000000')],
    ['@a2', signature(800, 1371, '0000000000000003')],
    ['@b1', signature(800, 1066, '0000000000000000')],
    ['@b2', signature(800, 1371, '0000000000000003')],
    ['@c1', signature(800, 1066, '0000000000000000')],
  ]);
  const pair = merge([message('a', photo('@a1') + photo('@a2')), message('b', photo('@b1') + photo('@b2'))], fingerprints);
  assert.equal(pair.messages.length, 1);
  const short = merge([message('a', photo('@a1') + photo('@a2')), message('c', photo('@c1'))], fingerprints);
  assert.equal(short.messages.length, 2);
});

test('长篇同文配图的既有合并行为不因图片指纹改变', () => {
  const body = '业务情况说明：'.repeat(20) + '订单数量1000台，价格1.5元。';
  const fingerprints = new Map([
    ['@a', signature(661, 3907, '0000000000000000')],
    ['@b', signature(661, 3907, 'ffffffffffffffff')],
  ]);
  const result = merge([message('a', body + photo('@a')), message('b', body + photo('@b'))], fingerprints);
  assert.equal(result.messages.length, 1);
  assert.ok(result.messages[0].duplicateSources[0].text.includes('@b'));
});
