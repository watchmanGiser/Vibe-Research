import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { createDesktopGateway } from "../src/desktop_gateway.ts";

test("packaged gateway: real HTTP static assets, same-origin proxy and credential boundaries", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vra-gateway-"));
  fs.writeFileSync(path.join(dir, "index.html"), "<html>Workbench</html>");
  fs.writeFileSync(path.join(dir, "app.js"), "export default 1;");
  fs.symlinkSync("/etc/hosts", path.join(dir, "outside.txt"));
  let received = "";
  const api = http.createServer((req,res) => { received = String(req.headers.authorization); res.end(JSON.stringify({ ok: true, url: req.url })); });
  await new Promise<void>(r => api.listen(0, "127.0.0.1", r));
  const gateway = createDesktopGateway({ dist: dir, apiPort: (api.address() as import("node:net").AddressInfo).port, token: "private-canary" });
  await new Promise<void>(r => gateway.listen(0, "127.0.0.1", r));
  t.after(() => { gateway.closeAllConnections(); gateway.close(); api.closeAllConnections(); api.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const base = `http://127.0.0.1:${(gateway.address() as import("node:net").AddressInfo).port}`;
  assert.match(await (await fetch(base + "/research")).text(), /Workbench/);
  assert.equal((await fetch(base + "/app.js")).headers.get("content-type"), "text/javascript");
  for (const url of ["/missing.js", "/.local/config.json", "/outside.txt"]) assert.equal((await fetch(base + url)).status, 404);
  assert.equal((await fetch(base + "/%zz")).status, 400);
  const forbidden: Record<string, string>[] = [{ Origin: "https://evil.example" }, { Host: "evil.example" }, { "Sec-Fetch-Site": "cross-site" }, { Origin: "http://127.0.0.1:9999" }];
  for (const headers of forbidden) {
    const status = await new Promise<number | undefined>((resolve, reject) => {
      http.get(base + "/api/health", { headers }, res => { res.resume(); resolve(res.statusCode); }).on("error", reject);
    });
    assert.equal(status, 403, JSON.stringify(headers));
  }
  const response = await fetch(base + "/api/health?x=1", { headers: { Origin: base, Authorization: "Bearer browser-wrong" } });
  assert.equal(received, "Bearer private-canary");
  assert.deepEqual(await response.json(), { ok: true, url: "/health?x=1" });
  assert.doesNotMatch(await (await fetch(base)).text(), /private-canary/);
});
