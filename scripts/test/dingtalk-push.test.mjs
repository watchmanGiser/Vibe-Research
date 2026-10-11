import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const script = new URL('../push-dingtalk-group.mjs', import.meta.url).pathname;
test('原文只保留本地；模型输出白名单摘要；失败禁止上传', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'jqz-test-'));
  try {
    const bin = path.join(dir, 'bin'); fs.mkdirSync(bin);
    const response = path.join(dir, 'response.json'), captured = path.join(dir, 'captured.json'), calls = path.join(dir, 'calls'), key = path.join(dir, 'key');
    fs.writeFileSync(key, 'test-key');
    fs.writeFileSync(path.join(bin, 'dws'), "#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(process.env.TEST_RESPONSE));\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'gpt'), "#!/usr/bin/env node\nconst fs=require('fs');if(process.env.TEST_GPT_FAIL)process.exit(1);fs.writeFileSync(process.argv[process.argv.indexOf('-o')+1],JSON.stringify({title:'产业调研',summary:process.env.TEST_OVERSIZE?'过长概述。'.repeat(200):'第三方表示行业需求存在变化，尚需验证。',keyPoints:['关注需求变化'],caveats:['缺少独立数据，待核验']}));fs.appendFileSync(process.env.TEST_CALLS,'gpt\\n');\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'scp'), "#!/usr/bin/env node\nconst fs=require('fs');fs.copyFileSync(process.argv.at(-2),process.env.TEST_CAPTURED);fs.appendFileSync(process.env.TEST_CALLS,'scp\\n');\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, 'ssh'), "#!/usr/bin/env node\nrequire('fs').appendFileSync(process.env.TEST_CALLS,'ssh\\n');\n", { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, DWS_BIN: path.join(bin, 'dws'), DINGTALK_GPT_BIN: path.join(bin, 'gpt'), TEST_RESPONSE: response, TEST_CAPTURED: captured, TEST_CALLS: calls,
      DINGTALK_GPT_PROVIDER_APPROVED: '1', DINGTALK_GROUP_NAME: '测试群', DINGTALK_CONVERSATION_ID: 'private-conversation', DINGTALK_PUSH_HOST: 'example.test', DINGTALK_PUSH_SSH_KEY: key,
      DINGTALK_LOCAL_SNAPSHOT_FILE: path.join(dir, 'raw.json'), DINGTALK_LOCAL_SUMMARY_FILE: path.join(dir, 'summary.json') };
    const run = (extra = {}) => spawnSync(process.execPath, [script], { env: { ...env, ...extra }, encoding: 'utf8' });
    const noConsent = run({ DINGTALK_GPT_PROVIDER_APPROVED: '0' });
    assert.notEqual(noConsent.status, 0); assert.equal(fs.existsSync(calls), false, '未经确认不得同步或推送');
    const original = '研究调研原文内容仅应在 Nova 本地保留。'.repeat(15);
    fs.writeFileSync(response, JSON.stringify({ complete: true, messages: [{ messageId: 'private-id', conversationId: 'private-conversation', text: original, sender: '甲', createTime: new Date().toISOString() }] }));
    let result = run({ DINGTALK_SUMMARY_ONLY: '1' }); assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.existsSync(calls), true); assert.equal(fs.readFileSync(calls, 'utf8'), 'gpt\n');
    assert.equal(fs.existsSync(captured), false, '本地试运行不可上传');
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.ok(fs.readFileSync(env.DINGTALK_LOCAL_SNAPSHOT_FILE, 'utf8').includes(original));
    const published = fs.readFileSync(captured, 'utf8');
    assert.doesNotMatch(published, /private-conversation|private-id|研究调研原文内容|sender|textHash|messages/);
    const body = JSON.parse(published); assert.equal(body.schemaVersion, 2); assert.equal(body.label, '击球区观点'); assert.equal(body.opinions.length, 1);
    result = run(); assert.equal(result.status, 0, result.stderr);
    assert.equal(fs.readFileSync(calls, 'utf8').split('gpt').length - 1, 1, '摘要应缓存，不重复模型调用');
    const latestPublished = fs.readFileSync(captured, 'utf8');
    fs.writeFileSync(response, JSON.stringify({ complete: true, messages: [JSON.parse(fs.readFileSync(response)).messages[0], { messageId: 'new-id', conversationId: 'private-conversation', text: '新的原文调研材料'.repeat(40), sender: '乙', createTime: new Date().toISOString() }] }));
    result = run({ TEST_GPT_FAIL: '1' }); assert.notEqual(result.status, 0);
    assert.equal(fs.readFileSync(captured, 'utf8'), latestPublished);
    result = run({ TEST_OVERSIZE: '1', DINGTALK_SUMMARY_ONLY: '1' }); assert.equal(result.status, 0, result.stderr);
    const latest = JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, 'utf8'));
    assert.ok(Object.values(latest.entries).every(x => x.summary.length <= 800));
    assert.equal(fs.readFileSync(captured, 'utf8'), latestPublished, '超长模型输出被裁剪且仍未上传');
    const injected = JSON.parse(fs.readFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, 'utf8'));
    const one = Object.keys(injected.entries)[0]; injected.entries[one].text = 'malicious-source-copy';
    fs.writeFileSync(env.DINGTALK_LOCAL_SUMMARY_FILE, JSON.stringify(injected));
    result = run(); assert.notEqual(result.status, 0, '缓存带原文字段必须拒绝');
    assert.equal(fs.readFileSync(captured, 'utf8'), latestPublished);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
