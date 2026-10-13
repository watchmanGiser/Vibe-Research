/** 仅合并可解释的转发差异；原稿、发送者与发送时间均保存在原始版本中。 */
import { createHash } from 'node:crypto';
export const digest = value => createHash('sha256').update(value).digest('hex');
export const messageTime = value => Date.parse(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value) ? value.replace(' ', 'T') + '+08:00' : value);
export const normalizedMessageText = value => value.normalize('NFC').replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).filter(Boolean).join('\n');
const refs = text => [...text.matchAll(/\[图片消息\]\(mediaId=([^\r\n)]+)\)/g)].map(match => match[1].trim());
const plain = text => text.normalize('NFC').replace(/\r\n?/g, '\n')
  .replace(/(?:图片内容[：:]\s*)?<imageContent>\s*(?:image|photo|img)(?:[ _.-]?\d+)?\.(?:jpe?g|png|gif|webp)\s*<\/imageContent>/gi, '')
  .replace(/\[图片消息\]\(mediaId=[^\r\n)]+\)/g, '[配图]')
  .replace(/[（）]/g, char => char === '（' ? '(' : ')');
function profile(text) {
  const body = plain(text);
  const numbers = body.match(/\d+(?:\.\d+)?/g) || [];
  const signs = [];
  for (const match of body.matchAll(/[+-]/g)) {
    const before = body.slice(0, match.index).trimEnd();
    const after = body.slice(match.index + 1).trimStart();
    // ins2+3、M8+2 等型号的加号经常在转发时变为空格。
    if (match[0] === '+' && /(?:\bins|\bM)\d+$/i.test(before) && /^\d/.test(after)) continue;
    if (/^\d/.test(after) || /(?:\d+(?:\.\d+)?|[一二三四五六七八九十百千万亿]+)(?:[A-Za-z%‰]|[\u4e00-\u9fff]){0,6}$/.test(before.replace(/\s/g, ''))) signs.push([match[0], (before.match(/\d+(?:\.\d+)?/g) || []).length]);
  }
  const qualifiers = body.match(/人民币|美元|港币|欧元|美金|\b(?:USD|CNY|RMB|HKD|EUR)\b|未|不|否|没有|无|已|确认|完成|失败|延期|延后|延迟|取消|撤销|终止|暂停|停|撤回|减少|下降|增长|以上|以下|至少|至多|超过|不足|仅|[?？!！]/g) || [];
  const key = body.replace(/cha(?=异|距|别)|(?<=代)cha/gi, '差').replace(/[+\s]/g, '');
  const parentheses = [...key.matchAll(/\(([^()]{1,100})\)/g)].map(match => match[1]);
  return { key, outside: key.replace(/\([^()]{1,100}\)/g, '()'), parentheses,
    guard: JSON.stringify([numbers, signs, qualifiers]), images: refs(text).length, full: normalizedMessageText(text) };
}
function equivalent(a, b) {
  if (a.full === b.full) return true;
  if (a.key.length < 100 || b.key.length < 100) return false;
  if (a.guard !== b.guard || a.images !== b.images) return false;
  if (a.key === b.key) return true;
  if (a.outside !== b.outside || a.parentheses.length !== b.parentheses.length) return false;
  // 仅接受用户截图已经确认的同一条转发中的客户备注差异。
  // 任意状态、订单或其他括号补充都不能据此当成重复。
  for (let i = 0; i < a.parentheses.length; i++) {
    const x = a.parentheses[i], y = b.parentheses[i];
    if (x === y) continue;
    if (!((x === '剑桥' && y === '剑桥思科一体') || (y === '剑桥' && x === '剑桥思科一体'))) return false;
  }
  return true;
}
const valid = value => typeof value === 'string' && value.trim().length > 0;
export function validateArchivedMessage(message) {
  if (!message || !valid(message.messageId) || !valid(message.text) || !valid(message.sender) || !valid(message.time) || !Number.isFinite(messageTime(message.time)) ||
      !Number.isInteger(message.duplicateCount) || message.duplicateCount < 0 ||
      (message.duplicateMessageIds !== undefined && (!Array.isArray(message.duplicateMessageIds) || !message.duplicateMessageIds.every(valid))) ||
      (message.latestDuplicateTime !== undefined && (!valid(message.latestDuplicateTime) || !Number.isFinite(messageTime(message.latestDuplicateTime)))) ||
      (message.duplicateSources !== undefined && (!Array.isArray(message.duplicateSources) || !message.duplicateSources.every(source => source &&
        Object.keys(source).sort().join(',') === 'messageId,sender,text,time' && valid(source.messageId) && valid(source.text) && valid(source.sender) && valid(source.time) && Number.isFinite(messageTime(source.time)))))) throw Error('原文及原始版本格式无效');
}
const original = message => ({ messageId: message.messageId, time: message.time, sender: message.sender, text: message.text });
export function mergeMessageHistory(existing, incoming = []) {
  const groups = [], exact = new Map(), buckets = new Map(), seen = new Map();
  let merged = 0, added = 0;
  const add = (message, isIncoming) => {
    validateArchivedMessage(message);
    if (seen.has(message.messageId)) {
      const target = seen.get(message.messageId).message;
      // 旧归档仅有副本 ID 时，补齐真实原稿，但不重复计数或替换首稿。
      if (message.messageId !== target.messageId && !(target.duplicateSources || []).some(source => source.messageId === message.messageId)) {
        target.duplicateSources = [...(target.duplicateSources || []), original(message)].sort((a, b) => messageTime(a.time) - messageTime(b.time));
      }
      return;
    }
    const p = profile(message.text), exactKey = p.full;
    const bucket = digest(JSON.stringify([p.outside, p.guard, p.images]));
    const match = exact.get(exactKey) || (buckets.get(bucket) || []).find(group => equivalent(group.profile, p));
    const ids = [message.messageId, ...(message.duplicateMessageIds || []), ...(message.duplicateSources || []).map(source => source.messageId)];
    if (match) {
      const target = match.message;
      const sources = new Map((target.duplicateSources || []).map(source => [source.messageId, source]));
      for (const source of [original(message), ...(message.duplicateSources || [])]) if (source.messageId !== target.messageId) sources.set(source.messageId, source);
      target.duplicateSources = [...sources.values()].sort((a, b) => messageTime(a.time) - messageTime(b.time) || a.messageId.localeCompare(b.messageId));
      target.duplicateMessageIds = [...new Set([...(target.duplicateMessageIds || []), ...ids])].filter(id => id !== target.messageId);
      target.duplicateCount = Math.max(target.duplicateCount + 1 + message.duplicateCount, target.duplicateMessageIds.length);
      for (const time of [message.time, message.latestDuplicateTime].filter(Boolean)) if (messageTime(time) > messageTime(target.latestDuplicateTime || target.time)) target.latestDuplicateTime = time;
      merged++;
    } else {
      const group = { message: structuredClone(message), profile: p };
      groups.push(group);exact.set(exactKey, group);
      if (!buckets.has(bucket)) buckets.set(bucket, []);
      buckets.get(bucket).push(group);
      if (isIncoming) added++;
    }
    const owner = match || groups.at(-1);
    for (const id of ids) seen.set(id, owner);
  };
  [...existing].sort((a, b) => messageTime(a.time) - messageTime(b.time) || a.messageId.localeCompare(b.messageId)).forEach(message => add(message, false));
  [...incoming].sort((a, b) => messageTime(a.time) - messageTime(b.time) || a.messageId.localeCompare(b.messageId)).forEach(message => add(message, true));
  const messages = groups.map(group => group.message).sort((a, b) => messageTime(b.time) - messageTime(a.time) || a.messageId.localeCompare(b.messageId));
  return { messages, added, merged, duplicateCount: messages.reduce((sum, message) => sum + message.duplicateCount, 0) };
}
