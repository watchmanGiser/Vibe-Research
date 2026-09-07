#!/usr/bin/env node
/** Local-only arm64 builder. Fresh dependencies, allowlisted payload, never copies development .local. */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('This builder requires an Apple Silicon Mac.');
const stamp = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15);
const out = path.join(repo, '.local', 'mac-builds', stamp);
const app = path.join(out, 'VibeResearch.app');
const resources = path.join(app, 'Contents/Resources');
const payload = path.join(resources, 'app');
const buildNumber = '40';
const milestone = `M${buildNumber}`;
fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
fs.mkdirSync(payload, { recursive: true });
const run = (cmd, args, cwd = out) => execFileSync(cmd, args, { cwd, stdio: 'inherit', timeout: 600_000 });
const write = (file, content) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, content); };
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const files = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard', '-z'], { cwd: repo, encoding: 'utf8' }).split('\0').filter(Boolean);
const { allowedSource: allowed, blockedSource: blocked } = await import('./source-policy.mjs');
const manifest = [];
for (const relative of [...new Set(files)].sort()) {
  if (!allowed.test(relative) || blocked.test(relative)) continue;
  const source = path.join(repo, relative);
  if (!fs.existsSync(source)) continue; // tracked deletion
  if (!fs.lstatSync(source).isFile()) throw new Error(`Non-regular source: ${relative}`);
  const target = path.join(payload, relative);
  fs.mkdirSync(path.dirname(target), { recursive: true }); fs.copyFileSync(source, target);
  manifest.push({ path: relative, sha256: hash(target) });
}
// No local app configuration should ship, even if someone accidentally tracked one later.
if (fs.existsSync(path.join(payload, 'vibe-research.config.json'))) {
  const config = JSON.parse(fs.readFileSync(path.join(payload, 'vibe-research.config.json'), 'utf8'));
  if (JSON.stringify(config).includes('/Users/') || JSON.stringify(config).includes('api_key')) throw new Error('Review product configuration before packaging.');
}
const nodeVersion = '22.23.2';
const archive = path.join(out, 'node.tar.gz');
const expected = '61130f394c1630d211dd50aecc4353d379480f36d3ac913cd85dbba1aed585c6';
if (process.env.VRA_MAC_NODE_ARCHIVE) {
  const cached = path.resolve(process.env.VRA_MAC_NODE_ARCHIVE);
  if (!fs.lstatSync(cached).isFile() || hash(cached) !== expected) throw new Error('Cached official Node archive checksum mismatch.');
  fs.copyFileSync(cached, archive);
} else {
  run('curl', ['-fL', '--retry', '2', '--max-time', '300', '-o', archive, `https://nodejs.org/dist/v${nodeVersion}/node-v${nodeVersion}-darwin-arm64.tar.gz`]);
}
if (hash(archive) !== expected) throw new Error('Official Node archive checksum mismatch.');
run('tar', ['-xzf', archive, '-C', resources]);
fs.renameSync(path.join(resources, `node-v${nodeVersion}-darwin-arm64`), path.join(resources, 'node'));
const node = path.join(resources, 'node/bin/node');
const npm = path.join(resources, 'node/lib/node_modules/npm/bin/npm-cli.js');
run(node, [npm, 'ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], path.join(payload, 'orchestrator'));
const pyInstall = path.join(out, 'python-install');
run('uv', ['--no-config', 'python', 'install', '3.12.13', '--install-dir', pyInstall, '--no-bin']);
// uv also creates version alias symlinks; never package an alias pointing back at the build machine.
const pyDir = fs.readdirSync(pyInstall).find(n => n.startsWith('cpython-3.12') && fs.lstatSync(path.join(pyInstall, n)).isDirectory());
if (!pyDir) throw new Error('Python distribution missing');
fs.renameSync(path.join(pyInstall, pyDir), path.join(resources, 'python'));
const python = path.join(resources, 'python/bin/python3.12');
const pythonLock = path.join(repo, 'packaging/macos/python-requirements.lock');
fs.copyFileSync(pythonLock, path.join(resources, 'python-requirements.lock'));
run('uv', ['--no-config', 'pip', 'install', '--python', python, '--break-system-packages', '--require-hashes', '-r', pythonLock]);
run('uv', ['--no-config', 'pip', 'check', '--python', python]);
run(python, ['-c', 'import pandas,numpy,requests,lxml,akshare,baostock,mootdx; print("Bundled Python imports OK")']);
// Compile UI in the source checkout; only generated production assets enter the bundle.
run('npm', ['ci', '--include=dev', '--ignore-scripts', '--prefix', 'desktop'], repo);
run('npm', ['run', 'build', '--prefix', 'desktop'], repo);
fs.cpSync(path.join(repo, 'desktop/dist'), path.join(payload, 'desktop/dist'), { recursive: true });
run('swiftc', ['-O', '-target', 'arm64-apple-macosx13.0', path.join(repo, 'packaging/macos/WindowPolicy.swift'), path.join(repo, 'packaging/macos/Launcher.swift'), '-o', path.join(app, 'Contents/MacOS/VibeResearch')]);
// Approved concept -> standard multi-resolution macOS icon. No generated personal data enters payload.
const iconSource = path.join(repo, 'packaging/macos/assets/app-icon.png');
const iconset = path.join(out, 'AppIcon.iconset');
fs.mkdirSync(iconset);
for (const size of [16, 32, 128, 256, 512]) {
  for (const scale of [1, 2]) {
    run('sips', ['-z', String(size * scale), String(size * scale), iconSource, '--out',
      path.join(iconset, `icon_${size}x${size}${scale === 2 ? '@2x' : ''}.png`)]);
  }
}
run('iconutil', ['-c', 'icns', iconset, '-o', path.join(resources, 'AppIcon.icns')]);
const version = JSON.parse(fs.readFileSync(path.join(repo, 'orchestrator/package.json'))).version;
write(path.join(app, 'Contents/Info.plist'), `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>CFBundleExecutable</key><string>VibeResearch</string><key>CFBundleIdentifier</key><string>ai.phoenixtree.viberesearch</string><key>CFBundleName</key><string>Vibe Research</string><key>CFBundleIconFile</key><string>AppIcon</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${version}</string><key>CFBundleVersion</key><string>${buildNumber}</string><key>LSMinimumSystemVersion</key><string>13.0</string><key>NSHighResolutionCapable</key><true/><key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict></dict></plist>`);
const codexVersion = JSON.parse(fs.readFileSync(path.join(payload, 'orchestrator/node_modules/@openai/codex/package.json'))).version;
const sdkVersion = JSON.parse(fs.readFileSync(path.join(payload, 'orchestrator/node_modules/@openai/codex-sdk/package.json'))).version;
const engineVersionOutput = execFileSync(node, [path.join(payload, 'orchestrator/node_modules/@openai/codex/bin/codex.js'), '--version'], { encoding: 'utf8' }).trim();
if (engineVersionOutput !== `codex-cli ${codexVersion}` || sdkVersion !== codexVersion) throw new Error('Bundled SDK / engine version mismatch.');
write(path.join(resources, 'build-manifest.json'), JSON.stringify({ status: 'local-test-not-notarized', version, milestone, window: 'AppKit-WKWebView', codex: codexVersion, sdk: sdkVersion, engineVersionOutput, nativeSourceFiles: ['packaging/macos/Launcher.swift', 'packaging/macos/WindowPolicy.swift', 'packaging/macos/build.mjs', 'packaging/macos/source-policy.mjs'].map(p => ({ path: p, sha256: hash(path.join(repo, p)) })), iconSha256: hash(path.join(resources, 'AppIcon.icns')), builtAt: new Date().toISOString(), arch: 'arm64', node: nodeVersion, nodeArchiveSha256: expected, python: '3.12.13', pythonLockSha256: hash(pythonLock), sourceFiles: manifest }, null, 2));
// pip freeze exposes standalone Python's temporary wheel path. The installed
// name/version inventory includes pip without publishing that build-machine path.
const packageList = JSON.parse(execFileSync('uv', ['--no-config', 'pip', 'list', '--python', python, '--format', 'json'], { encoding: 'utf8' }));
const packages = packageList.map(p => `${p.name}==${p.version}`).sort().join('\n') + '\n';
write(path.join(resources, 'python-packages.txt'), packages);
write(path.join(resources, 'NOTICE.txt'), `Vibe Research local test bundle. Not notarized or publicly released.\nIncludes Node.js (official LICENSE in node/), Astral python-build-standalone / CPython and packages (licenses in python/), Codex ${codexVersion} (Apache-2.0; package licenses retained in app/orchestrator/node_modules). Source license: app/LICENSE.\n`);
// Ad-hoc signing is only a local integrity seal, NOT Developer ID distribution acceptance.
run('codesign', ['--force', '--deep', '--sign', '-', app]);
run('codesign', ['--verify', '--deep', '--strict', app]);
const imageRoot = path.join(out, 'image');
fs.mkdirSync(imageRoot); fs.renameSync(app, path.join(imageRoot, 'VibeResearch.app'));
fs.symlinkSync('/Applications', path.join(imageRoot, 'Applications'));
write(path.join(imageRoot, '使用说明.txt'), `Vibe Research · ${milestone} 本地测试包（Apple Silicon / macOS 13+）\n拖动 VibeResearch.app 到 Applications，双击后在独立 App 窗口使用，不再自动打开浏览器。\n本包仅本地临时签名，尚未 Apple 公证，不是公开发布版。勿关闭系统安全功能。\n数据：~/.vibe-research-desktop；内部工作台：http://127.0.0.1:5938/，独立于开发仓库。\nApp 首次使用需重新接入自己的 AI；不读取浏览器账号、API key 或聊天，已有本地资料保留。\n关闭窗口保留服务，点击 App 图标可恢复；Cmd+Q 退出。退出前请在研究页取消后台研究；删应用不会删用户数据。\n`);
const dmg = path.join(out, `VibeResearch-${version}-${milestone}-mac-arm64.dmg`);
run('hdiutil', ['create', '-volname', 'Vibe Research', '-srcfolder', imageRoot, '-format', 'UDZO', '-o', dmg]);
write(dmg + '.sha256', hash(dmg) + '  ' + path.basename(dmg) + '\n');
console.log(`LOCAL_PACKAGE ${dmg}`);
