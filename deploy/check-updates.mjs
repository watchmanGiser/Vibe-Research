#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";

const appRoot = process.env.VIBE_APP_ROOT || "/opt/vibe-research/app";
const sharedRoot = process.env.VIBE_SHARED_ROOT || "/opt/vibe-research/shared";
const repository = process.env.VIBE_UPSTREAM_REPO || "simonlin1212/Vibe-Research";
const updateRoot = path.join(sharedRoot, "update");
const baselineFile = path.join(updateRoot, "deployed-upstream-sha");
const persistentStatus = path.join(updateRoot, "update-status.json");
const publicStatus = path.join(appRoot, "desktop", "dist", "update-status.json");

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function validSha(value) {
  return typeof value === "string" && /^[0-9a-f]{40}$/.test(value) ? value : null;
}

function currentUpstreamCommit() {
  try {
    const release = readJson(path.join(appRoot, "release.json"));
    const fromRelease = validSha(release.upstream_commit);
    if (fromRelease) return fromRelease;
  } catch {
    // bootstrap 发布没有 release.json，读取持久基线。
  }
  const fromBaseline = validSha(fs.readFileSync(baselineFile, "utf8").trim());
  if (!fromBaseline) throw new Error(`部署基线无效：${baselineFile}`);
  return fromBaseline;
}

async function fetchJson(url) {
  const response = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "vibe-research-update-check" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`GitHub 请求失败：HTTP ${response.status}`);
  return await response.json();
}

function writeAtomic(file, payload) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o644 });
  fs.renameSync(temporary, file);
}

const currentCommit = currentUpstreamCommit();
const currentPackage = readJson(path.join(appRoot, "orchestrator", "package.json"));
const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
const latestCommitResponse = await fetchJson(`https://api.github.com/repos/${encodedRepository}/commits/main`);
const latestCommit = validSha(latestCommitResponse.sha);
if (!latestCommit) throw new Error("GitHub 返回的 main commit 无效");

const latestPackage = await fetchJson(`https://raw.githubusercontent.com/${encodedRepository}/main/orchestrator/package.json`);
let aheadBy = 0;
if (currentCommit !== latestCommit) {
  try {
    const comparison = await fetchJson(`https://api.github.com/repos/${encodedRepository}/compare/${currentCommit}...${latestCommit}`);
    aheadBy = Number.isInteger(comparison.ahead_by) ? comparison.ahead_by : null;
  } catch {
    aheadBy = null;
  }
}

const message = String(latestCommitResponse.commit?.message || "上游代码已变化").split(/\r?\n/, 1)[0].slice(0, 180);
const status = {
  schema_version: 1,
  checked_at: new Date().toISOString(),
  available: currentCommit !== latestCommit,
  ahead_by: aheadBy,
  current: { version: String(currentPackage.version || "unknown"), commit: currentCommit },
  latest: {
    version: String(latestPackage.version || "unknown"),
    commit: latestCommit,
    message,
    committed_at: latestCommitResponse.commit?.committer?.date || null,
    url: `https://github.com/${repository}/commit/${latestCommit}`,
  },
  compare_url: `https://github.com/${repository}/compare/${currentCommit}...${latestCommit}`,
};

writeAtomic(persistentStatus, status);
writeAtomic(publicStatus, status);
console.log(`更新检查完成：current=${currentCommit.slice(0, 12)} latest=${latestCommit.slice(0, 12)} available=${status.available}`);
