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

requireText("desktop/src/verticals/finance/pages/Intel.tsx", ['key: "semi"', 'key: "dingtalk"', "Semi动态", "SemiPanel", "DingTalkGroupPanel"]);
requireText("desktop/src/verticals/finance/pages/SemiPanels.tsx", ["function SemiPanel", "api.semiTweets", "api.semiStatus", "api.dingtalkGroup", "item.author_avatar", "images.slice(0, 4)"]);
requireText("desktop/src/verticals/finance/lib/nav.ts", ['to: "/intel/semi"', 'to: "/intel/dingtalk"', 'to: "/realtime"']);
requireText("desktop/src/verticals/finance/router.tsx", ['path: "/realtime"', "basename: import.meta.env.BASE_URL"]);
requireText("desktop/src/verticals/finance/lib/backend.ts", ["/semi/tweets", "/semi/status", "/semi/dingtalk", "apiUrl(path)"]);
requireText("orchestrator/src/api.ts", ["readOnlyEndpoint(url.pathname)", "ApiExtensionError"]);
requireText("orchestrator/src/finance/feed_routes.ts", ["/semi/health", "/semi/status", "/semi/tweets", "/semi/dingtalk"]);
requireText("orchestrator/src/finance/semi.ts", ["SEMI_SNAPSHOT_FILE", "/opt/vibe-research/shared/semi/latest.json", "nova-push"]);
requireText("orchestrator/src/finance/dingtalk_semi.ts", ["schemaVersion !== 2", "opinions"]);
requireText("desktop/vite.config.ts", ['const basePath = process.env.VITE_BASE_PATH ?? "/"', "[apiPrefix]:", "p.slice(apiPrefix.length)"]);
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
