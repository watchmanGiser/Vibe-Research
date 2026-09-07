import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
test('v1.1.0 candidate version is consistent across packages, locks and Mac build', () => {
  for (const dir of ['desktop', 'orchestrator']) {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, dir, 'package.json'), 'utf8'));
    const lock = JSON.parse(fs.readFileSync(path.join(root, dir, 'package-lock.json'), 'utf8'));
    assert.equal(pkg.version, '1.1.0');
    assert.equal(lock.version, pkg.version);
    assert.equal(lock.packages[''].version, pkg.version);
  }
  const builder = fs.readFileSync(path.join(root, 'packaging/macos/build.mjs'), 'utf8');
  assert.match(builder, /const buildNumber = '40';/);
});
