#!/usr/bin/env node
/** Explicit local signing step; never uploads, publishes, or modifies the input app. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function entitlementKeys(relative) {
  if (relative === 'Contents/Resources/node/bin/node' ||
      /^Contents\/Resources\/app\/orchestrator\/node_modules\/@openai\/codex-darwin-arm64\/vendor\/aarch64-apple-darwin\/bin\/codex-code-mode-host$/.test(relative)) {
    return ['com.apple.security.cs.allow-jit', 'com.apple.security.cs.allow-unsigned-executable-memory'];
  }
  return [];
}

export function inventory(root) {
  const files = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        const resolved = fs.realpathSync(full);
        if (resolved !== root && !resolved.startsWith(root + path.sep)) throw new Error('Bundle symlink escapes app');
      } else if (entry.isDirectory()) {
        if (/\.(app|framework|xpc|bundle)$/.test(entry.name)) throw new Error('Nested bundle requires explicit signing support');
        walk(full);
      } else if (entry.isFile()) files.push(full);
      else throw new Error('Non-regular bundle entry');
    }
  }
  walk(root);
  return files.sort();
}

export function hasMachMagic(file) {
  const fd = fs.openSync(file, 'r');
  try {
    const bytes = Buffer.alloc(4);
    if (fs.readSync(fd, bytes, 0, 4, 0) !== 4) return false;
    return ['feedface', 'feedfacf', 'cefaedfe', 'cffaedfe', 'cafebabe', 'bebafeca', 'cafebabf', 'bfbafeca'].includes(bytes.toString('hex'));
  } finally { fs.closeSync(fd); }
}

export function signCandidate(sourceArg, outputArg, identity, team) {
  if (process.platform !== 'darwin') throw new Error('macOS required');
  if (!/^[a-f\d]{40}$/i.test(identity ?? '') || !/^[A-Z\d]{10}$/.test(team ?? '')) throw new Error('Explicit certificate SHA1 and Team ID required');
  const source = fs.realpathSync(sourceArg);
  if (!source.endsWith('.app') || !fs.statSync(source).isDirectory()) throw new Error('Source must be an app bundle');
  // Resolve the existing parent, reject an existing target, and never place output inside source.
  const requested = path.resolve(outputArg);
  const output = path.join(fs.realpathSync(path.dirname(requested)), path.basename(requested));
  if (output === source || output.startsWith(source + path.sep) || fs.existsSync(output)) throw new Error('Output must be a new directory outside the source app');
  const run = (cmd, args, capture = false) => execFileSync(cmd, args, {
    encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', timeout: 120_000,
  });
  const identities = run('/usr/bin/security', ['find-identity', '-v', '-p', 'codesigning'], true);
  if (!identities.split('\n').some(line => line.includes(identity.toUpperCase()) && line.includes('Developer ID Application:') && line.includes(`(${team})`))) throw new Error('Valid matching Developer ID Application identity not found');
  inventory(source);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', source]);
  fs.mkdirSync(output);
  const app = path.join(output, 'VibeResearch.app');
  run('/usr/bin/ditto', [source, app]);
  const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  const priorManifest = path.join(app, 'Contents/Resources/build-manifest.json');
  const originalManifestSha256 = hash(priorManifest);
  // Do not preserve upstream debugging/library-validation exceptions wholesale.
  const entitlementFile = path.join(output, 'jit-entitlements.plist');
  fs.writeFileSync(entitlementFile, '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict>' + entitlementKeys('Contents/Resources/node/bin/node').map(key => `<key>${key}</key><true/>`).join('') + '</dict></plist>');
  const candidates = inventory(app).filter(hasMachMagic).filter(file => run('/usr/bin/file', ['-b', file], true).includes('Mach-O'));
  if (!candidates.includes(path.join(app, 'Contents/MacOS/VibeResearch'))) throw new Error('Main executable missing');
  const records = [];
  for (const file of candidates) {
    const relative = path.relative(app, file);
    const keys = entitlementKeys(relative);
    const args = ['--force', '--sign', identity, '--timestamp', '--options', 'runtime'];
    if (keys.length) args.push('--entitlements', entitlementFile);
    run('/usr/bin/codesign', [...args, file]);
    run('/usr/bin/codesign', ['--verify', '--strict', file]);
    records.push({ path: relative, entitlements: keys });
  }
  // Child code is already signed; seal resources and the outer app last, without --deep.
  run('/usr/bin/codesign', ['--force', '--sign', identity, '--timestamp', '--options', 'runtime', app]);
  run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
  fs.writeFileSync(path.join(output, 'signing-record.json'), JSON.stringify({
    status: 'developer-id-signed-not-notarized', team, identity, signedAt: new Date().toISOString(),
    originalManifestSha256, signingScriptSha256: hash(fileURLToPath(import.meta.url)), binaries: records,
  }, null, 2));
  run('/usr/bin/ditto', ['-c', '-k', '--keepParent', app, path.join(output, 'VibeResearch-notary.zip')]);
  console.log(`SIGNED_CANDIDATE ${output}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.length !== 6) throw new Error('Usage: sign-candidate.mjs source.app new-output-dir certificate-sha1 team-id');
  signCandidate(...process.argv.slice(2));
}
