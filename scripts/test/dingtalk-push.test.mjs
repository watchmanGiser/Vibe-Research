import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../push-dingtalk-group.mjs", import.meta.url).pathname;

test("仅推送去标识结果快照；同步不完整时绝不上传", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-dingtalk-push-test-"));
  try {
    const bin = path.join(dir, "bin");
    fs.mkdirSync(bin);
    const response = path.join(dir, "response.json");
    const captured = path.join(dir, "captured.json");
    const calls = path.join(dir, "calls");
    const key = path.join(dir, "fake-key");
    fs.writeFileSync(key, "test-only", { mode: 0o600 });
    fs.writeFileSync(path.join(bin, "fake-dws"), "#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(process.env.DWS_TEST_RESPONSE, 'utf8'));\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "scp"), "#!/usr/bin/env node\nconst fs=require('node:fs');fs.copyFileSync(process.argv.at(-2),process.env.TEST_CAPTURED);fs.appendFileSync(process.env.TEST_CALLS,'scp\\n');\n", { mode: 0o700 });
    fs.writeFileSync(path.join(bin, "ssh"), "#!/usr/bin/env node\nrequire('node:fs').appendFileSync(process.env.TEST_CALLS,'ssh\\n');\n", { mode: 0o700 });
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`,
      DWS_BIN: path.join(bin, "fake-dws"), DWS_TEST_RESPONSE: response,
      DINGTALK_GROUP_NAME: "测试群", DINGTALK_CONVERSATION_ID: "private-conversation",
      DINGTALK_PUSH_HOST: "example.test", DINGTALK_PUSH_SSH_KEY: key,
      DINGTALK_LOCAL_SNAPSHOT_FILE: path.join(dir, "local.json"), TEST_CAPTURED: captured, TEST_CALLS: calls };
    const run = () => spawnSync(process.execPath, [script], { env, encoding: "utf8" });
    fs.writeFileSync(response, JSON.stringify({ complete: true, messages: [
      { messageId: "private-message", conversationId: "private-conversation", text: "测试正文", sender: "发送者", createTime: new Date().toISOString() },
    ] }));
    const first = run();
    assert.equal(first.status, 0, first.stderr);
    const published = fs.readFileSync(captured, "utf8");
    assert.doesNotMatch(published, /private-(conversation|message)|duplicateMessageIds|windowStart|conversationId/);
    const data = JSON.parse(published);
    assert.deepEqual(Object.keys(data).sort(), ["duplicateCount", "group", "messages", "receivedCount", "syncedAt"]);
    assert.match(data.messages[0].messageId, /^[a-f0-9]{64}$/);
    assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), ["scp", "ssh"]);
    fs.writeFileSync(response, JSON.stringify({ complete: false, messages: [] }));
    const second = run();
    assert.notEqual(second.status, 0);
    assert.deepEqual(fs.readFileSync(calls, "utf8").trim().split("\n"), ["scp", "ssh"]);
    assert.equal(fs.readFileSync(captured, "utf8"), published);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
