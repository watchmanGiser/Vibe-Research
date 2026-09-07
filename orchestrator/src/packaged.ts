/** macOS bundle entry. This process owns both servers; user data stays outside the signed bundle. */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { createApiServer } from "./api.ts";
import { createDesktopGateway } from "./desktop_gateway.ts";
import { serviceContext } from "./service.ts";
import { ensureInstructionsRoot } from "./instructions_root.ts";
import { installSkillsIsolation } from "./skills_isolation.ts";
import { terminateActiveLocalAgentProcesses } from "./local_agent_runtime.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
// These explicit overrides exist for isolated QA; the native launcher does not inherit them.
const dataRoot = path.resolve(process.env.VRA_DESKTOP_DATA ?? path.join(os.homedir(), ".vibe-research-desktop"));
const python = path.resolve(repoRoot, "../python/bin/python3.12");
const port = Number(process.env.VRA_DESKTOP_PORT ?? 5938);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error("无效的工作台端口");
// The installed app and the disk-image preview must use the same research tools.
fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
if (fs.lstatSync(dataRoot).isSymbolicLink()) throw new Error("用户数据目录不能是符号链接");
fs.chmodSync(dataRoot, 0o700);
const codexHome = path.join(dataRoot, "codex-home");
process.env.VRA_DATA_ROOT = dataRoot;
process.env.VRA_CODEX_HOME = codexHome;
process.env.VRA_PYTHON = python;
process.env.PYTHONDONTWRITEBYTECODE = "1";
const config = path.join(dataRoot, "config.json");
if (!fs.existsSync(config)) fs.writeFileSync(config, JSON.stringify({ provider: { profile: "openai" } }), { flag: "wx", mode: 0o600 });
const ctx = { ...serviceContext({ repoRoot, python }), researchExecutionMode: "controlled_mcp" as const };
// Reserve the stable UI port BEFORE touching instruction mirrors, so duplicate launches cannot race sync.
const token = crypto.randomBytes(32).toString("hex");
const api = createApiServer(ctx, { token, cookieLogin: false });
await new Promise<void>((resolve, reject) => { api.once("error", reject); api.listen(0, "127.0.0.1", resolve); });
const apiPort = (api.address() as import("node:net").AddressInfo).port;
const ui = createDesktopGateway({ dist: path.join(repoRoot, "desktop/dist"), apiPort, token });
try {
  await new Promise<void>((resolve, reject) => { ui.once("error", reject); ui.listen(port, "127.0.0.1", resolve); });
  installSkillsIsolation({ repoRoot, codexHome, python });
  ensureInstructionsRoot({ repoRoot, dataRoot, codexHome, runDir: path.join(dataRoot, "runs", "preflight") });
  console.log(`READY http://127.0.0.1:${port}/`);
} catch (error) {
  ui.close(); api.close(); throw error;
}
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  terminateActiveLocalAgentProcesses();
  ui.close(); api.close();
  ui.closeAllConnections(); api.closeAllConnections();
  // Independent research is intentionally not killed; cancel it from the research page first.
  setTimeout(() => process.exit(0), 250).unref();
};
process.once("SIGTERM", stop);
process.once("SIGINT", stop);
