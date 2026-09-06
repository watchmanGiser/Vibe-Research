import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const failures = [];

function requireFile(relative) {
  const file = path.join(root, relative);
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    failures.push(`缺少文件：${relative}`);
    return "";
  }
  return fs.readFileSync(file, "utf8");
}

function requireText(relative, patterns) {
  const text = requireFile(relative);
  for (const pattern of patterns) {
    if (!text.includes(pattern)) failures.push(`${relative} 缺少定制标识：${pattern}`);
  }
}

requireText("desktop/src/verticals/finance/pages/Intel.tsx", ['key: "semi"', "Semi动态", "function SemiPanel", "api.semiTweets", "api.semiStatus"]);
requireText("desktop/src/verticals/finance/components/layout/Layout.tsx", ['to: "/intel/semi"', "Semi动态"]);
requireText("desktop/src/verticals/finance/lib/api.ts", ["semiTweets:", "semiStatus:"]);
requireText("desktop/src/verticals/finance/lib/backend.ts", ["/semi/tweets", "/semi/status", "apiUrl(path)"]);
requireText("orchestrator/src/api.ts", ["/semi/health", "/semi/status", "/semi/tweets", "SemiUpstreamError"]);
requireText("orchestrator/src/semi.ts", ["SEMI_SNAPSHOT_FILE", "/opt/vibe-research/shared/semi/latest.json", "nova-push"]);
requireText("desktop/src/verticals/finance/pages/Intel.tsx", ["function semiMediaList", "item.author_avatar", "images.slice(0, 4)", 'item.zh || item.text']);
requireText("orchestrator/src/service.ts", ["r.exit_code === 2", 'env.status === "partial"']);
requireText("desktop/vite.config.ts", ['base: process.env.VITE_BASE_PATH ?? "/vibe-research/"']);
requireText("desktop/src/verticals/finance/lib/api-base.ts", ["BASE_URL", "`${base}/api${suffix}`"]);

const distIndex = requireFile("desktop/dist/index.html");
if (distIndex && !distIndex.includes("/vibe-research/assets/")) failures.push("desktop/dist/index.html 未使用 /vibe-research/ 资源子路径");
const assetsDir = path.join(root, "desktop", "dist", "assets");
const bundles = fs.existsSync(assetsDir)
  ? fs.readdirSync(assetsDir).filter((name) => name.endsWith(".js")).map((name) => fs.readFileSync(path.join(assetsDir, name), "utf8")).join("\n")
  : "";
if (!bundles.includes("Semi动态")) failures.push("生产 JS 产物缺少 Semi动态标签");

if (failures.length) {
  console.error("广州生产定制回归检查失败：");
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(2);
}
console.log("广州生产定制回归检查通过：Semi 标签、推送接口、子路径和生产产物均已保留");
