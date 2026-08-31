import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const repoRoot = path.resolve(import.meta.dirname, "../..");

test("发布包移除 npm 命令入口，并在打包前拒绝残留符号链接", () => {
  const build = fs.readFileSync(path.join(repoRoot, "deploy", "build-release.sh"), "utf8");
  const remote = fs.readFileSync(path.join(repoRoot, "deploy", "remote-release.sh"), "utf8");

  assert.match(build, /rm -rf -- "\$stage\/app\/orchestrator\/node_modules\/\.bin"/);
  assert.match(build, /find "\$stage\/app" -type l -print -quit/);
  assert.match(remote, /kind" == "-" \|\| "\$kind" == "d"/);
});
