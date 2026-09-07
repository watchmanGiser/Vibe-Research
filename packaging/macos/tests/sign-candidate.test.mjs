import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { entitlementKeys, inventory, hasMachMagic, signCandidate } from '../sign-candidate.mjs';

test('only bundled JIT engines receive narrowly enumerated exceptions', () => {
  assert.equal(entitlementKeys('Contents/Resources/node/bin/node').length, 2);
  assert.equal(entitlementKeys('Contents/Resources/app/orchestrator/node_modules/@openai/codex-darwin-arm64/vendor/aarch64-apple-darwin/bin/codex-code-mode-host').length, 2);
  for (const name of ['Contents/MacOS/VibeResearch', 'Contents/Resources/python/bin/python3.12', 'evil/node', 'codex']) assert.deepEqual(entitlementKeys(name), []);
  assert.ok(entitlementKeys('Contents/Resources/node/bin/node').every(key => !/get-task-allow|disable-library-validation|dyld/.test(key)));
});
test('inventory includes non-executable native modules and does not follow aliases', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vra-sign-test-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  const lib = path.join(root, 'module.so');
  fs.writeFileSync(lib, Buffer.from('cffaedfe00000000', 'hex'), { mode: 0o600 });
  fs.symlinkSync(lib, path.join(root, 'alias'));
  assert.deepEqual(inventory(root), [lib]);
  assert.equal(hasMachMagic(lib), true);
  const text = path.join(root, 'text'); fs.writeFileSync(text, 'hi');
  assert.equal(hasMachMagic(text), false);
  fs.symlinkSync(os.tmpdir(), path.join(root, 'escape'));
  assert.throws(() => inventory(root), /escapes/);
});
test('unhandled nested code bundles fail closed', t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'vra-sign-test-')));
  t.after(() => fs.rmSync(root, { recursive: true }));
  fs.mkdirSync(path.join(root, 'Other.app'));
  assert.throws(() => inventory(root), /Nested bundle/);
});
test('signing requires an explicit identity, not ad-hoc fallback', () => {
  assert.throws(() => signCandidate('.', '.', '-', 'W23NY49KQ5'));
});
