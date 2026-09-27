import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const script = new URL("../sync-dingtalk-group.mjs", import.meta.url).pathname;

test("完整查询可去重并幂等；不完整查询保留旧快照", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-dingtalk-sync-"));
  try {
    const dws = path.join(dir, "fake-dws");
    const responseFile = path.join(dir, "response.json");
    const snapshotFile = path.join(dir, "snapshot.json");
    fs.writeFileSync(dws, `#!/usr/bin/env node\nprocess.stdout.write(require('node:fs').readFileSync(process.env.DWS_TEST_RESPONSE, 'utf8'));\n`, { mode: 0o700 });
    const env = { ...process.env, DWS_BIN: dws, DWS_TEST_RESPONSE: responseFile,
      DINGTALK_GROUP_NAME: "测试群", DINGTALK_CONVERSATION_ID: "test-conversation",
      DINGTALK_SEMI_SNAPSHOT_FILE: snapshotFile };
    const now = new Date().toISOString();
    const long = "这是用于验证重复内容的测试语句。".repeat(12);
    const messages = [
      { messageId: "a", conversationId: "test-conversation", text: long, createTime: now, sender: "甲" },
      { messageId: "b", conversationId: "test-conversation", text: long, createTime: now, sender: "乙" },
      { messageId: "c", conversationId: "test-conversation", text: "不同内容", createTime: now, sender: "丙" },
    ];
    const run = () => spawnSync(process.execPath, [script], { encoding: "utf8", env });
    fs.writeFileSync(responseFile, JSON.stringify({ complete: true, messages }));
    assert.equal(run().status, 0);
    const first = fs.readFileSync(snapshotFile, "utf8");
    const data = JSON.parse(first);
    assert.equal(data.messages.length, 2);
    assert.equal(data.duplicateCount, 1);
    assert.deepEqual(data.messages.find((m) => m.messageId === "a").duplicateMessageIds, ["b"]);
    assert.equal(run().status, 0);
    assert.equal(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).duplicateCount, 1);
    fs.writeFileSync(responseFile, JSON.stringify({ complete: false, partial: true, messages: [] }));
    assert.notEqual(run().status, 0);
    assert.equal(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).duplicateCount, 1);
    fs.writeFileSync(responseFile, JSON.stringify({ complete: true, messages: [{ ...messages[0], conversationId: "other" }] }));
    assert.notEqual(run().status, 0);
    assert.equal(JSON.parse(fs.readFileSync(snapshotFile, "utf8")).duplicateCount, 1);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
